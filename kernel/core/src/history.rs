//! History beyond per-person undo: which entry redo replays, reverting an
//! Agent's batches (SPEC §6, ARCHITECTURE §3 `plan_revert`), and the timeline
//! of who did what in a Space.
//!
//! A revert is planned from the edits a batch recorded. Each edit is inverted
//! and replayed newest first, and it only takes effect when the Element still
//! holds what that batch left there. When a person changed it afterwards, the
//! edit is skipped and reported as kept, so a revert never overwrites a
//! person's later work. Reverting is itself a new batch (an Agent's) or a new
//! history entry (a person's, which that person can undo).

use crate::apply::{self, display_id, Ctx, Edit};
use crate::doc;
use crate::model::Principal;
use crate::{history_entries, HistoryEntry};
use automerge::transaction::Transaction;
use automerge::ReadDoc;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// The entry redo replays: of the undone entries that no newer action has
/// abandoned, the one undone most recently. An entry is abandoned when an
/// action was made after it was undone, even on another device whose new
/// action didn't see the undo (two devices of one person, concurrently).
pub fn redo_pick(entries: &[HistoryEntry]) -> Option<usize> {
    let newest = |after: i64| entries.iter().any(|f| f.at > after);
    entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.state == "undone")
        .filter(|(_, e)| !newest(e.undone_at.unwrap_or(e.at)))
        .max_by(|(i, a), (j, b)| {
            a.undone_at
                .unwrap_or(a.at)
                .cmp(&b.undone_at.unwrap_or(b.at))
                // Undone in the same millisecond: the older entry was undone last.
                .then(j.cmp(i))
        })
        .map(|(i, _)| i)
}

#[derive(Clone, Debug)]
pub struct Batch {
    pub id: String,
    pub agent: String,
    pub at: i64,
    pub edits: Vec<Edit>,
    /// The batches this one reverted, if it is a revert.
    pub reverts: Vec<String>,
}

pub fn batches<R: ReadDoc>(d: &R) -> Vec<Batch> {
    let root = doc::root(d, "batches");
    let mut out: Vec<Batch> = d
        .keys(&root)
        .filter_map(|id| {
            let m = doc::obj(d, &root, &id)?;
            Some(Batch {
                agent: doc::get_str(d, &m, "agent")?,
                at: doc::get_int(d, &m, "at").unwrap_or(0),
                edits: doc::get_str(d, &m, "edits")
                    .and_then(|e| serde_json::from_str(&e).ok())
                    .unwrap_or_default(),
                reverts: doc::get_str(d, &m, "reverts")
                    .and_then(|e| serde_json::from_str(&e).ok())
                    .unwrap_or_default(),
                id,
            })
        })
        .collect();
    out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Every person's history entries, in time order.
fn all_entries<R: ReadDoc>(d: &R) -> Vec<(String, HistoryEntry)> {
    let history = doc::root(d, "history");
    let people: BTreeSet<String> = d
        .keys(&history)
        .filter_map(|k| k.split('|').next().map(String::from))
        .collect();
    let mut out: Vec<(String, HistoryEntry)> = people
        .into_iter()
        .flat_map(|p| {
            history_entries(d, &p)
                .into_iter()
                .map(move |e| (p.clone(), e))
        })
        .collect();
    out.sort_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.1.slot.cmp(&b.1.slot)));
    out
}

/// Batches that are currently reverted: named by a revert batch that is not
/// itself reverted, or by a person's revert entry that is not undone.
pub fn reverted<R: ReadDoc>(d: &R) -> BTreeSet<String> {
    let bs = batches(d);
    let mut out = BTreeSet::new();
    // Newest first, so a revert that was itself reverted no longer counts.
    for b in bs.iter().rev() {
        if !b.reverts.is_empty() && !out.contains(&b.id) {
            out.extend(b.reverts.iter().cloned());
        }
    }
    for (_, e) in all_entries(d) {
        if e.state != "done" {
            continue;
        }
        if let Some(list) = e
            .info
            .as_ref()
            .and_then(|i| i.get("reverts"))
            .and_then(Value::as_array)
        {
            out.extend(list.iter().filter_map(|v| v.as_str().map(String::from)));
        }
    }
    out
}

pub enum Pick {
    Batch(String),
    Last(usize),
}

pub enum PlanError {
    Unknown(String),
    NotYours(String),
    Already(String),
    Nothing,
}

/// Which batches a revert undoes, newest first.
pub fn plan<R: ReadDoc>(d: &R, agent: &str, pick: &Pick) -> Result<Vec<Batch>, PlanError> {
    let bs = batches(d);
    let gone = reverted(d);
    match pick {
        Pick::Batch(id) => {
            let Some(b) = bs.iter().find(|b| &b.id == id) else {
                return Err(PlanError::Unknown(id.clone()));
            };
            if b.agent != agent {
                return Err(PlanError::NotYours(id.clone()));
            }
            if gone.contains(id) {
                return Err(PlanError::Already(id.clone()));
            }
            Ok(vec![b.clone()])
        }
        Pick::Last(n) => {
            let mine: Vec<Batch> = bs
                .into_iter()
                .rev()
                .filter(|b| b.agent == agent && b.reverts.is_empty() && !gone.contains(&b.id))
                // A batch that changed nothing (focus only, or a duplicate) is not a change to undo.
                .filter(|b| !b.edits.is_empty())
                .take(*n)
                .collect();
            if mine.is_empty() {
                return Err(PlanError::Nothing);
            }
            Ok(mine)
        }
    }
}

/// Who changed this Element after `since`, for the kept list.
fn later_editor<R: ReadDoc>(
    d: &R,
    key: &str,
    since: i64,
    names: &BTreeMap<String, String>,
) -> String {
    let who = all_entries(d)
        .into_iter()
        .rev()
        .find(|(_, e)| e.at >= since && e.state == "done" && e.edits.iter().any(|x| x.key() == key))
        .map(|(p, _)| p);
    match who {
        Some(p) => names.get(&p).cloned().unwrap_or(p),
        None => "Someone".to_string(),
    }
}

/// Applies the inverse of each planned batch's edits, newest first. Returns
/// the edits that took effect and the Elements kept as a person left them.
pub fn apply_revert(
    tx: &mut Transaction,
    ctx: &Ctx,
    plan: &[Batch],
    viewer: Option<&Principal>,
    names: &BTreeMap<String, String>,
) -> Result<(Vec<Edit>, Vec<Value>), automerge::AutomergeError> {
    let mut applied = vec![];
    let mut kept: Vec<Value> = vec![];
    let mut seen = BTreeSet::new();
    let mut i = 0;
    for b in plan {
        for e in b.edits.iter().rev() {
            let inv = e.inverse();
            i += 1;
            if apply::replay(tx, &inv, ctx, i)? {
                applied.push(inv);
                continue;
            }
            let key = e.key();
            // Already gone (the person erased what the batch added): nothing to keep.
            let live = doc::live_record(tx, &key).is_some();
            if matches!(e, Edit::Library { .. }) || (!live && matches!(e, Edit::Create { .. })) {
                continue;
            }
            if seen.insert(key.clone()) {
                let who = later_editor(tx, &key, b.at, names);
                let why = if live {
                    format!(
                        "{who} changed it after {}, so it stays as they left it.",
                        b.id
                    )
                } else {
                    format!("{who} removed it after {}, so it stays removed.", b.id)
                };
                kept.push(json!({ "id": display_id(viewer, &key), "why": why }));
            }
        }
    }
    Ok((applied, kept))
}

/// Who did what in a Space, oldest first: Agent batches, people's actions and
/// Sends. `query`: `{viewer?, names?, limit?}`.
pub fn timeline<R: ReadDoc>(
    d: &R,
    viewer: Option<&Principal>,
    names: &BTreeMap<String, String>,
    limit: usize,
) -> Value {
    let name = |p: &Principal| {
        names
            .get(p.id())
            .cloned()
            .unwrap_or_else(|| p.id().to_string())
    };
    let summary = |edits: &[Edit]| {
        let mut added = BTreeSet::new();
        let mut removed = BTreeSet::new();
        let mut changed = BTreeSet::new();
        for e in edits {
            let k = display_id(viewer, &e.key());
            match e {
                Edit::Create { .. } => added.insert(k),
                Edit::Delete { .. } => removed.insert(k),
                _ => changed.insert(k),
            };
        }
        for k in &added {
            changed.remove(k);
        }
        let ids: Vec<String> = added
            .iter()
            .chain(changed.iter())
            .chain(removed.iter())
            .take(20)
            .cloned()
            .collect();
        (
            json!({ "added": added.len(), "changed": changed.len(), "removed": removed.len() }),
            ids,
        )
    };
    let gone = reverted(d);
    let mut rows: Vec<(i64, Value)> = vec![];
    for b in batches(d) {
        let who = Principal::Agent(b.agent.clone());
        let (counts, ids) = summary(&b.edits);
        let mut row = json!({
            "kind": if b.reverts.is_empty() { "batch" } else { "revert" },
            "id": b.id,
            "by": { "agent": b.agent, "name": name(&who) },
            "at": b.at,
            "state": if gone.contains(&b.id) { "reverted" } else { "done" },
            "counts": counts,
            "ids": ids,
        });
        if !b.reverts.is_empty() {
            row["reverts"] = json!(b.reverts);
        }
        rows.push((b.at, row));
    }
    for (person, e) in all_entries(d) {
        let who = Principal::Person(person.clone());
        let (counts, ids) = summary(&e.edits);
        let mut row = json!({
            "kind": "action",
            "id": e.id,
            "action": e.kind,
            "by": { "person": person, "name": name(&who) },
            "at": e.at,
            "state": e.state,
            "counts": counts,
            "ids": ids,
        });
        if let Some(info) = &e.info {
            row["info"] = info.clone();
        }
        rows.push((e.at, row));
    }
    let sends = doc::root(d, "sends");
    for (id, text) in doc::str_map(d, &sends) {
        let Ok(s) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let at = s["at"].as_i64().unwrap_or(0);
        let person = s["from"]["person"].as_str().unwrap_or("").to_string();
        rows.push((
            at,
            json!({
                "kind": "send",
                "id": id,
                "by": { "person": person, "name": name(&Principal::Person(person.clone())) },
                "at": at,
                "state": "sent",
                "trigger": s["trigger"],
                "strokes": s["strokes"].as_array().map(|a| a.len()).unwrap_or(0),
            }),
        ));
    }
    rows.sort_by_key(|(at, _)| *at);
    let skip = rows.len().saturating_sub(limit);
    json!({ "entries": rows.into_iter().skip(skip).map(|(_, r)| r).collect::<Vec<_>>() })
}
