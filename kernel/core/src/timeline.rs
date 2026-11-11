//! A Space's history as people see it, and a person reverting an Agent's
//! last change (SPEC §6, "Agent changes").
//!
//! The timeline merges every Agent batch with every person's history entries,
//! newest last, each summarized as Send `changes` are. Reverting is a person's
//! action: it replays the inverse of the Agent's latest batch that isn't
//! already reverted, skipping any field someone has changed since, and is
//! recorded as that person's own history entry, so their undo brings the
//! Agent's change back. The Agent's own `revert` tool is planned separately.

use crate::apply::{self, display_id, Ctx, Edit};
use crate::doc;
use crate::model::Principal;
use automerge::transaction::{Transactable, Transaction};
use automerge::ReadDoc;
use serde_json::{json, Value};

/// One Agent batch, as stored by `apply_agent_batch`.
pub(crate) struct Batch {
    pub id: String,
    pub agent: String,
    pub at: i64,
    pub edits: Vec<Edit>,
}

pub(crate) fn batches<R: ReadDoc>(d: &R) -> Vec<Batch> {
    let root = doc::root(d, "batches");
    let mut out: Vec<Batch> = d
        .keys(&root)
        .filter_map(|id| {
            let m = doc::obj(d, &root, &id)?;
            Some(Batch {
                agent: doc::get_str(d, &m, "agent")?,
                at: doc::get_int(d, &m, "at").unwrap_or(0),
                edits: serde_json::from_str(&doc::get_str(d, &m, "edits")?).ok()?,
                id,
            })
        })
        .collect();
    out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
    out
}

/// One person's history entry, across all people.
struct Entry {
    person: String,
    id: String,
    device: String,
    kind: String,
    state: String,
    at: i64,
    batch: Option<String>,
    edits: Vec<Edit>,
}

fn entries<R: ReadDoc>(d: &R) -> Vec<Entry> {
    let history = doc::root(d, "history");
    d.keys(&history)
        .filter_map(|slot| {
            let m = doc::obj(d, &history, &slot)?;
            Some(Entry {
                person: slot.split('|').next()?.to_string(),
                id: doc::get_str(d, &m, "id")?,
                device: doc::get_str(d, &m, "device").unwrap_or_default(),
                kind: doc::get_str(d, &m, "kind").unwrap_or_default(),
                state: doc::get_str(d, &m, "state")?,
                at: doc::get_int(d, &m, "at").unwrap_or(0),
                batch: doc::get_str(d, &m, "batch"),
                edits: serde_json::from_str(&doc::get_str(d, &m, "edits")?).ok()?,
            })
        })
        .collect()
}

/// Batches someone has reverted, and not undone that revert.
fn reverted<R: ReadDoc>(d: &R) -> Vec<(String, String)> {
    entries(d)
        .into_iter()
        .filter(|e| e.kind == "revert" && e.state == "done")
        .filter_map(|e| Some((e.batch?, e.person)))
        .collect()
}

fn ids(edits: &[Edit], viewer: Option<&Principal>) -> Vec<Value> {
    let mut out: Vec<String> = vec![];
    for e in edits {
        let key = match e {
            Edit::Create { snapshot } | Edit::Delete { snapshot } => snapshot
                .get("key")
                .and_then(Value::as_str)
                .map(String::from),
            Edit::Field { key, .. } | Edit::Text { key, .. } | Edit::Data { key, .. } => {
                Some(key.clone())
            }
            Edit::Library { .. } => None,
        };
        if let Some(k) = key.map(|k| display_id(viewer, &k)) {
            if !out.contains(&k) {
                out.push(k);
            }
        }
    }
    out.into_iter().map(Value::String).collect()
}

/// `query`: `{viewer?: {person}, limit?: n}`. Returns
/// `{entries: [{at, by, kind, batch | entry, device?, state, changes, ids, reverted_by?}]}`,
/// oldest first, the last `limit` (default 200).
pub fn timeline<R: ReadDoc>(d: &R, q: &Value) -> Value {
    let viewer = q
        .get("viewer")
        .and_then(|v| v.get("person"))
        .and_then(Value::as_str)
        .map(|p| Principal::Person(p.to_string()));
    let limit = q.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
    let undone: Vec<(String, String)> = reverted(d);
    let mut rows: Vec<(i64, Value)> = vec![];
    for b in batches(d) {
        let mut row = json!({
            "at": b.at, "by": { "agent": b.agent }, "kind": "batch", "batch": b.id, "state": "done",
            "changes": b.edits.iter().filter_map(crate::send::summarize).collect::<Vec<_>>(),
            "ids": ids(&b.edits, viewer.as_ref()),
        });
        if let Some((_, who)) = undone.iter().find(|(id, _)| *id == b.id) {
            row["state"] = json!("reverted");
            row["reverted_by"] = json!({ "person": who });
        }
        rows.push((b.at, row));
    }
    for e in entries(d) {
        let mut row = json!({
            "at": e.at, "by": { "person": e.person }, "kind": e.kind, "entry": e.id,
            "device": e.device, "state": e.state,
            "changes": e.edits.iter().filter_map(crate::send::summarize).collect::<Vec<_>>(),
            "ids": ids(&e.edits, viewer.as_ref()),
        });
        if let Some(b) = e.batch {
            row["batch"] = json!(b);
        }
        rows.push((e.at, row));
    }
    rows.sort_by_key(|(at, _)| *at);
    let skip = rows.len().saturating_sub(limit);
    json!({ "entries": rows.into_iter().skip(skip).map(|(_, r)| r).collect::<Vec<_>>() })
}

/// The Agent's latest batch that changed something and isn't reverted.
pub(crate) fn last_batch<R: ReadDoc>(d: &R, agent: &str) -> Option<Batch> {
    let undone = reverted(d);
    batches(d).into_iter().rev().find(|b| {
        b.agent == agent && !b.edits.is_empty() && !undone.iter().any(|(id, _)| *id == b.id)
    })
}

/// Replays the inverse of `batch` as the person in `ctx`. Returns the edits
/// that applied, for the person's history entry.
pub(crate) fn revert(
    tx: &mut Transaction,
    batch: &Batch,
    ctx: &Ctx,
) -> Result<Vec<Edit>, automerge::AutomergeError> {
    let mut applied = vec![];
    for (i, e) in batch.edits.iter().rev().map(Edit::inverse).enumerate() {
        if apply::replay(tx, &e, ctx, i)? {
            applied.push(e);
        }
    }
    Ok(applied)
}

/// Records which batch a revert entry reverted.
pub(crate) fn mark(
    tx: &mut Transaction,
    person: &str,
    entry: &str,
    batch: &str,
) -> Result<(), automerge::AutomergeError> {
    let history = doc::root(tx, "history");
    let prefix = format!("{person}|");
    let slot = tx
        .keys(&history)
        .find(|k| k.starts_with(&prefix) && k.ends_with(&format!("|{entry}")));
    if let Some(m) = slot.and_then(|s| doc::obj(tx, &history, &s)) {
        tx.put(&m, "batch", batch)?;
    }
    Ok(())
}
