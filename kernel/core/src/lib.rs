//! Reflex Space kernel.
//!
//! A sans-IO state machine (ADR-0005): JSON and bytes go in, new state, JSON
//! results and bytes come out. It owns no sockets, files, clocks or threads.
//! Callers inject the time (`now_ms`) and the replica's actor ID, which they
//! generate from their own random source.
//!
//! The Swift binding (UniFFI, `kernel/ffi`) and the TypeScript binding
//! (wasm-bindgen, `kernel/wasm`) are thin wrappers over [`Space`].

#![forbid(unsafe_code)]

mod apply;
mod auth;
mod doc;
pub mod model;
mod ops;
#[allow(dead_code, clippy::large_enum_variant, clippy::enum_variant_names)]
pub mod protocol;
mod scene;
mod send;

use crate::apply::{Ctx, Edit};
use crate::doc::sha_hex;
use crate::model::Principal;
use crate::ops::OpError;
use crate::protocol::Code;
use automerge::sync::{self, SyncDoc};
use automerge::transaction::{CommitOptions, Transactable};
use automerge::{ActorId, Automerge, ChangeHash, ObjType, ReadDoc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq)]
pub enum KernelError {
    /// The caller passed JSON the kernel cannot read at all.
    BadJson(String),
    /// Bytes that are not an Automerge document, change or sync message.
    BadBytes(String),
    /// An argument outside what the kernel accepts (actor ID, principal ID, kind).
    BadArgument(String),
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KernelError::BadJson(m) => write!(f, "bad JSON: {m}"),
            KernelError::BadBytes(m) => write!(f, "bad bytes: {m}"),
            KernelError::BadArgument(m) => write!(f, "bad argument: {m}"),
        }
    }
}

impl std::error::Error for KernelError {}

pub type Result<T> = std::result::Result<T, KernelError>;

fn parse_json(s: &str) -> Result<Value> {
    serde_json::from_str(s).map_err(|e| KernelError::BadJson(e.to_string()))
}

fn check_id(what: &str, id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if ok {
        Ok(())
    } else {
        Err(KernelError::BadArgument(format!(
            "{what} '{id}' must be 1-64 characters of letters, digits, '-', '_' or '.'"
        )))
    }
}

fn parse_actor(actor_hex: &str) -> Result<ActorId> {
    let bytes = hex::decode(actor_hex)
        .map_err(|e| KernelError::BadArgument(format!("actor must be hex: {e}")))?;
    if bytes.len() < 8 || bytes.len() > 32 {
        return Err(KernelError::BadArgument(
            "actor must be 8 to 32 random bytes, hex encoded".into(),
        ));
    }
    Ok(ActorId::from(bytes))
}

fn commit(now_ms: i64, message: String) -> CommitOptions {
    CommitOptions::default()
        .with_time(now_ms.div_euclid(1000))
        .with_message(message)
}

/// One replica of one Space.
pub struct Space {
    doc: Automerge,
    actor_hex: String,
    sync: HashMap<String, sync::State>,
}

impl Space {
    /// A new replica of a Space. Every replica of the same `space_id` starts
    /// from the same genesis change, so they can be created independently and
    /// still merge. `actor_hex` must be unique to this replica.
    pub fn create(space_id: &str, kind: &str, actor_hex: &str) -> Result<Space> {
        check_id("space id", space_id)?;
        if kind != "space" && kind != "library" {
            return Err(KernelError::BadArgument(format!(
                "kind '{kind}' must be \"space\" or \"library\""
            )));
        }
        let actor = parse_actor(actor_hex)?;
        let mut doc = doc::genesis(space_id, kind);
        doc.set_actor(actor);
        Ok(Space {
            doc,
            actor_hex: actor_hex.to_lowercase(),
            sync: HashMap::new(),
        })
    }

    /// Opens a replica from a saved document (`save`), as this replica's actor.
    pub fn load(bytes: &[u8], actor_hex: &str) -> Result<Space> {
        let actor = parse_actor(actor_hex)?;
        let mut doc = doc::load(bytes).map_err(|e| KernelError::BadBytes(e.to_string()))?;
        if doc::ROOTS
            .iter()
            .any(|r| doc::obj(&doc, &automerge::ROOT, r).is_none())
        {
            return Err(KernelError::BadBytes("not a Reflex Space".into()));
        }
        doc.set_actor(actor);
        Ok(Space {
            doc,
            actor_hex: actor_hex.to_lowercase(),
            sync: HashMap::new(),
        })
    }

    pub fn space_id(&self) -> String {
        doc::get_str(&self.doc, &doc::root(&self.doc, "meta"), "space").unwrap_or_default()
    }

    pub fn kind(&self) -> String {
        doc::get_str(&self.doc, &doc::root(&self.doc, "meta"), "kind").unwrap_or_default()
    }

    fn heads_hex(&self) -> Vec<String> {
        self.doc.get_heads().iter().map(|h| h.to_string()).collect()
    }

    /// Applies one Agent batch atomically. `agent` comes from the
    /// authenticated context, never from the batch. Returns the result JSON:
    /// `{ok: true, batch, ids, repaired, lints}` or `{ok: false, applied: 0, errors}`.
    pub fn apply_agent_batch(
        &mut self,
        agent: &str,
        request_id: &str,
        batch_json: &str,
        now_ms: i64,
    ) -> Result<String> {
        check_id("agent id", agent)?;
        let batch = parse_json(batch_json)?;
        let ops_v = match batch.get("ops").and_then(|o| o.as_array()) {
            Some(a) => a.clone(),
            None => {
                return Ok(reject(vec![OpError::new(
                    0,
                    Code::InvalidInput,
                    "The batch has no ops list.",
                    "Pass {\"ops\": [ ... ]}.",
                )]))
            }
        };
        let batch_id = format!(
            "b_{}",
            &sha_hex(&[agent.as_bytes(), request_id.as_bytes()])[..12]
        );
        let hash = sha_hex(&[Value::Array(ops_v.clone()).to_string().as_bytes()]);

        // Idempotency (ARCHITECTURE §7.3).
        let batches = doc::root(&self.doc, "batches");
        if let Some(b) = doc::obj(&self.doc, &batches, &batch_id) {
            let prior = doc::get_str(&self.doc, &b, "hash").unwrap_or_default();
            if prior == hash {
                let mut result = doc::get_str(&self.doc, &b, "result")
                    .and_then(|r| serde_json::from_str::<Value>(&r).ok())
                    .unwrap_or(json!({ "ok": true, "batch": batch_id }));
                result["duplicate"] = json!(true);
                return Ok(result.to_string());
            }
            return Ok(reject(vec![OpError::new(
                0,
                Code::RequestReused,
                format!("Request '{request_id}' was already applied with different ops."),
                "Use a new request ID for a new batch.",
            )]));
        }

        let (ops, parse_errs) = ops::parse_agent_ops(&ops_v);
        let principal = Principal::Agent(agent.to_string());
        let kind = self.kind();
        let actor_hex = self.actor_hex.clone();
        let res = self.doc.transact_with(
            |_| commit(now_ms, format!("batch {batch_id}")),
            |tx| {
                let ctx = Ctx {
                    principal: &principal,
                    tag: &batch_id,
                    now_ms,
                    actor_hex: &actor_hex,
                    space_kind: &kind,
                };
                let out = apply::run(tx, &ctx, &ops, parse_errs)?;
                let lints = scene::lints(tx, &principal, &out.edits);
                let ids: serde_json::Map<String, Value> =
                    out.ids.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                let result = json!({
                    "ok": true,
                    "batch": batch_id,
                    "ids": ids,
                    "repaired": out.repaired,
                    "lints": lints,
                });
                let batches = doc::root(tx, "batches");
                let wr = |tx: &mut automerge::transaction::Transaction| -> std::result::Result<(), automerge::AutomergeError> {
                    let b = tx.put_object(&batches, batch_id.as_str(), ObjType::Map)?;
                    tx.put(&b, "agent", agent)?;
                    tx.put(&b, "request", request_id)?;
                    tx.put(&b, "hash", hash.as_str())?;
                    tx.put(&b, "at", now_ms)?;
                    tx.put(&b, "edits", serde_json::to_string(&out.edits).expect("edits"))?;
                    tx.put(&b, "result", result.to_string())?;
                    Ok(())
                };
                wr(tx).map_err(|e| vec![OpError::new(0, Code::Internal, e.to_string(), "Retry.")])?;
                Ok::<_, Vec<OpError>>(result)
            },
        );
        Ok(match res {
            Ok(s) => s.result.to_string(),
            Err(f) => reject(f.error),
        })
    }

    /// Applies one finished user action from a device: a finished stroke, an
    /// erase, a move, an edit, or undo/redo. The person and device come from
    /// the authenticated context.
    pub fn apply_user_intent(
        &mut self,
        person: &str,
        device: &str,
        intent_json: &str,
        now_ms: i64,
    ) -> Result<String> {
        check_id("person id", person)?;
        check_id("device id", device)?;
        let intent = parse_json(intent_json)?;
        match intent.get("intent").and_then(|v| v.as_str()) {
            Some("undo") => return self.undo(person, device, now_ms),
            Some("redo") => return self.redo(person, device, now_ms),
            _ => {}
        }
        let op = match ops::parse_intent(&intent) {
            Ok(op) => op,
            Err(errs) => return Ok(reject(errs)),
        };
        let kind_name = intent
            .get("intent")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let principal = Principal::Person(person.to_string());
        let entry_id = format!(
            "h_{}",
            &sha_hex(&[
                self.actor_hex.as_bytes(),
                self.heads_hex().join(",").as_bytes(),
                &now_ms.to_le_bytes()
            ])[..12]
        );
        let kind = self.kind();
        let actor_hex = self.actor_hex.clone();
        let res = self.doc.transact_with(
            |_| commit(now_ms, format!("intent {entry_id}")),
            |tx| {
                let ctx = Ctx {
                    principal: &principal,
                    tag: &entry_id,
                    now_ms,
                    actor_hex: &actor_hex,
                    space_kind: &kind,
                };
                let out = apply::run(tx, &ctx, &[Some(op)], vec![])?;
                let ids: serde_json::Map<String, Value> =
                    out.ids.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                if out.edits.is_empty() {
                    return Ok(json!({ "ok": true, "entry": null, "ids": ids }));
                }
                history_push(
                    tx, person, device, &entry_id, &kind_name, &out.edits, now_ms,
                )
                .map_err(|e| vec![OpError::new(0, Code::Internal, e.to_string(), "Retry.")])?;
                Ok::<_, Vec<OpError>>(
                    json!({ "ok": true, "entry": entry_id, "ids": ids, "repaired": out.repaired }),
                )
            },
        );
        Ok(match res {
            Ok(s) => s.result.to_string(),
            Err(f) => reject(f.error),
        })
    }

    /// Undoes this person's most recent action, whichever of their devices
    /// made it (ADR-0008). Other people's and Agents' actions are untouched.
    pub fn undo(&mut self, person: &str, device: &str, now_ms: i64) -> Result<String> {
        self.undo_redo(person, device, now_ms, true)
    }

    /// Redoes this person's most recently undone action.
    pub fn redo(&mut self, person: &str, device: &str, now_ms: i64) -> Result<String> {
        self.undo_redo(person, device, now_ms, false)
    }

    fn undo_redo(&mut self, person: &str, device: &str, now_ms: i64, undo: bool) -> Result<String> {
        check_id("person id", person)?;
        check_id("device id", device)?;
        let entries = history_entries(&self.doc, person);
        let last_done = entries.iter().rposition(|e| e.state == "done");
        let pick = if undo {
            last_done
        } else {
            let start = last_done.map(|i| i + 1).unwrap_or(0);
            (start..entries.len()).find(|&i| entries[i].state == "undone")
        };
        let what = if undo { "undone" } else { "redone" };
        let Some(idx) = pick else {
            return Ok(json!({ "ok": true, what: null }).to_string());
        };
        let entry = entries[idx].clone();
        let principal = Principal::Person(person.to_string());
        let kind = self.kind();
        let actor_hex = self.actor_hex.clone();
        let tag = format!("{}:{}:{now_ms}", entry.id, if undo { "u" } else { "r" });
        let res = self.doc.transact_with(
            |_| {
                commit(
                    now_ms,
                    format!(
                        "{} {} by {device}",
                        if undo { "undo" } else { "redo" },
                        entry.id
                    ),
                )
            },
            |tx| {
                let ctx = Ctx {
                    principal: &principal,
                    tag: &tag,
                    now_ms,
                    actor_hex: &actor_hex,
                    space_kind: &kind,
                };
                let steps: Vec<Edit> = if undo {
                    entry.edits.iter().rev().map(Edit::inverse).collect()
                } else {
                    entry.edits.clone()
                };
                let mut applied = 0;
                for (i, e) in steps.iter().enumerate() {
                    if apply::replay(tx, e, &ctx, i)? {
                        applied += 1;
                    }
                }
                let history = doc::root(tx, "history");
                let m = doc::obj(tx, &history, &entry.slot).expect("entry");
                tx.put(&m, "state", if undo { "undone" } else { "done" })?;
                Ok::<_, automerge::AutomergeError>(applied)
            },
        );
        match res {
            Ok(s) => Ok(json!({ "ok": true, what: entry.id, "kind": entry.kind, "applied": s.result, "skipped": entry.edits.len() - s.result }).to_string()),
            Err(f) => Err(KernelError::BadBytes(f.error.to_string())),
        }
    }

    /// Projects the scene. `query_json`: `{detail?: "full"|"outline"|"strokes",
    /// viewer?: {agent}|{person}, ids?: [..], names?: {<principal id>: <display name>}}`.
    pub fn scene(&self, query_json: &str) -> Result<String> {
        let q = if query_json.trim().is_empty() {
            json!({})
        } else {
            parse_json(query_json)?
        };
        Ok(scene::scene(&self.doc, &q, &self.heads_hex()).to_string())
    }

    /// A hash of the full logical state, ignoring history: two replicas that
    /// agree on every Element, Send and Library entry have the same digest.
    pub fn digest(&self) -> String {
        let mut s = scene::scene(&self.doc, &json!({ "detail": "full" }), &[]);
        s.as_object_mut().expect("scene").remove("heads");
        sha_hex(&[s.to_string().as_bytes()])
    }

    /// Freezes a Send: pins the frontier, claims this person's unsent strokes
    /// and changes atomically, and stores it immutably. Returns the frozen Send.
    pub fn freeze_send(
        &mut self,
        person: &str,
        device: &str,
        raw_json: &str,
        now_ms: i64,
    ) -> Result<String> {
        check_id("person id", person)?;
        check_id("device id", device)?;
        let raw = parse_json(raw_json)?;
        let frontier = self.heads_hex();
        let res = self.doc.transact_with(
            |_| commit(now_ms, "send".to_string()),
            |tx| send::freeze(tx, person, device, &raw, &frontier, now_ms),
        );
        match res {
            Ok(s) => Ok(s.result),
            Err(f) => match f.error {
                send::FreezeError::Rejected(errs) => Ok(reject(errs)),
                send::FreezeError::Existing(s) => Ok(s),
                send::FreezeError::Am(e) => Err(KernelError::BadBytes(e.to_string())),
            },
        }
    }

    /// The whole document, compressed.
    pub fn save(&self) -> Vec<u8> {
        self.doc.save()
    }

    /// The current heads, as a JSON list of hex change hashes.
    pub fn heads(&self) -> String {
        json!(self.heads_hex()).to_string()
    }

    /// Every change the holder of `heads_json` is missing.
    pub fn changes_since(&self, heads_json: &str) -> Result<Vec<u8>> {
        let v = parse_json(heads_json)?;
        let heads = v
            .as_array()
            .ok_or_else(|| KernelError::BadJson("heads must be a list".into()))?
            .iter()
            .map(|h| {
                h.as_str()
                    .and_then(|s| ChangeHash::from_str(s).ok())
                    .ok_or_else(|| KernelError::BadJson(format!("bad change hash {h}")))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(self.doc.save_after(&heads))
    }

    /// Merges changes or a whole document from another replica. Returns the
    /// new heads. Duplicates and reordering are harmless.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<String> {
        self.doc
            .load_incremental(bytes)
            .map_err(|e| KernelError::BadBytes(e.to_string()))?;
        Ok(self.heads())
    }

    /// The next Automerge sync message for `peer`, if any.
    pub fn sync_message(&mut self, peer: &str) -> Option<Vec<u8>> {
        let state = self.sync.entry(peer.to_string()).or_default();
        self.doc.generate_sync_message(state).map(|m| m.encode())
    }

    /// Takes a sync message from `peer`.
    pub fn receive_sync_message(&mut self, peer: &str, msg: &[u8]) -> Result<()> {
        let m = sync::Message::decode(msg).map_err(|e| KernelError::BadBytes(e.to_string()))?;
        let state = self.sync.entry(peer.to_string()).or_default();
        self.doc
            .receive_sync_message(state, m)
            .map_err(|e| KernelError::BadBytes(e.to_string()))
    }

    /// Takes a sync message from `peer` only if every change in it was the
    /// peer's to make. `writers_json` says who the peer writes for, from its
    /// authenticated pairing: `{"any": true}`, or `{"people": [..], "agents":
    /// [..] | "*"}`. Returns `{"ok": true}`, or `{"ok": false, "reason":
    /// "not_yours", "errors": [..]}` with nothing applied.
    pub fn receive_sync_message_checked(
        &mut self,
        peer: &str,
        msg: &[u8],
        writers_json: &str,
    ) -> Result<String> {
        let writers = auth::Writers::parse(&parse_json(writers_json)?);
        let m = sync::Message::decode(msg).map_err(|e| KernelError::BadBytes(e.to_string()))?;
        if !writers.any && !m.changes.is_empty() {
            let mut fork = self.doc.fork();
            for c in m.changes.iter() {
                fork.load_incremental(c)
                    .map_err(|e| KernelError::BadBytes(e.to_string()))?;
            }
            let errs = auth::check(&self.doc, &fork, &writers);
            if !errs.is_empty() {
                let errors: Vec<Value> = errs
                    .iter()
                    .map(|e| json!({ "code": "not_yours", "msg": format!("The peer {e}."), "fix": "Only changes the peer's own person or Agents may make are accepted." }))
                    .collect();
                return Ok(
                    json!({ "ok": false, "reason": "not_yours", "errors": errors }).to_string(),
                );
            }
        }
        let state = self.sync.entry(peer.to_string()).or_default();
        self.doc
            .receive_sync_message(state, m)
            .map_err(|e| KernelError::BadBytes(e.to_string()))?;
        Ok(json!({ "ok": true }).to_string())
    }

    /// One frozen Send's stored record, or `null`.
    pub fn send(&self, send_id: &str) -> String {
        doc::get_str(&self.doc, &doc::root(&self.doc, "sends"), send_id)
            .unwrap_or_else(|| "null".into())
    }

    /// Forgets the sync state for `peer`, after a disconnect.
    pub fn reset_sync(&mut self, peer: &str) {
        self.sync.remove(peer);
    }
}

/// A rejected batch, in `error.schema.json`'s shape.
fn reject(errors: Vec<OpError>) -> String {
    let reason = match errors.as_slice() {
        [one] => one.code,
        _ => Code::BatchRejected,
    };
    json!({ "ok": false, "reason": reason, "applied": 0, "errors": errors }).to_string()
}

#[derive(Clone, Debug)]
pub(crate) struct HistoryEntry {
    pub slot: String,
    pub id: String,
    pub kind: String,
    pub state: String,
    pub edits: Vec<Edit>,
}

/// History lives in one flat map, keyed `<person>|<order>|<entry>`, so two
/// devices never race to create a per-person container.
fn history_push(
    tx: &mut automerge::transaction::Transaction,
    person: &str,
    device: &str,
    entry_id: &str,
    kind: &str,
    edits: &[Edit],
    now_ms: i64,
) -> std::result::Result<(), automerge::AutomergeError> {
    let history = doc::root(tx, "history");
    // A new action ends the redo chain: undone entries can no longer be redone.
    let prefix = format!("{person}|");
    let undone: Vec<_> = tx
        .keys(&history)
        .filter(|k| k.starts_with(&prefix))
        .filter_map(|k| doc::obj(tx, &history, &k))
        .filter(|m| doc::get_str(tx, m, "state").as_deref() == Some("undone"))
        .collect();
    for m in undone {
        tx.put(&m, "state", "abandoned")?;
    }
    let slot = format!("{person}|{:013}|{entry_id}", now_ms.max(0));
    let m = tx.put_object(&history, slot.as_str(), ObjType::Map)?;
    tx.put(&m, "id", entry_id)?;
    tx.put(&m, "device", device)?;
    tx.put(&m, "kind", kind)?;
    tx.put(&m, "state", "done")?;
    tx.put(&m, "at", now_ms)?;
    tx.put(&m, "edits", serde_json::to_string(edits).expect("edits"))?;
    Ok(())
}

pub(crate) fn history_entries<R: ReadDoc>(d: &R, person: &str) -> Vec<HistoryEntry> {
    let history = doc::root(d, "history");
    let prefix = format!("{person}|");
    // Map keys iterate in sorted order, so entries come out in time order.
    d.keys(&history)
        .filter(|k| k.starts_with(&prefix))
        .filter_map(|slot| {
            let m = doc::obj(d, &history, &slot)?;
            Some(HistoryEntry {
                id: doc::get_str(d, &m, "id")?,
                kind: doc::get_str(d, &m, "kind").unwrap_or_default(),
                state: doc::get_str(d, &m, "state")?,
                edits: serde_json::from_str(&doc::get_str(d, &m, "edits")?).ok()?,
                slot,
            })
        })
        .collect()
}
