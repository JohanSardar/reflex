//! `freeze_send`: turning a raw Send from a device into an immutable record.
//!
//! The frozen Send pins the frontier it was made at, names the person who sent
//! it, and claims that person's strokes and changes made since their last
//! Send, in the same commit, so rapid Sends neither repeat nor drop an edit
//! (ARCHITECTURE §7.4). Mark grouping and Anchor resolution run later, where
//! the Agent is, against the pinned frontier.

use crate::apply::Edit;
use crate::doc;
use crate::model::{Principal, Record};
use crate::ops::OpError;
use crate::protocol::Code;
use automerge::transaction::{Transactable, Transaction};
use serde_json::{json, Value};

pub enum FreezeError {
    Rejected(Vec<OpError>),
    /// The Send already exists; here is the stored record, unchanged.
    Existing(String),
    Am(automerge::AutomergeError),
}

impl From<automerge::AutomergeError> for FreezeError {
    fn from(e: automerge::AutomergeError) -> Self {
        FreezeError::Am(e)
    }
}

pub(crate) fn summarize(e: &Edit) -> Option<Value> {
    let label = |s: &Value| {
        let r = Record::from_snapshot(s)?;
        Some((r.key.clone(), r.typ.clone(), r.text.clone()))
    };
    Some(match e {
        Edit::Create { snapshot } => {
            let (id, typ, _) = label(snapshot)?;
            if typ == "ink" {
                return None; // strokes travel in `strokes`
            }
            json!({ "kind": "added", "id": id, "type": typ })
        }
        Edit::Delete { snapshot } => {
            let (id, typ, text) = label(snapshot)?;
            json!({ "kind": "removed", "id": id, "type": typ, "was": text })
        }
        Edit::Field {
            key,
            field,
            old,
            new,
        } if field == "bounds" => {
            let o: Vec<i64> = serde_json::from_str(old.as_deref()?).ok()?;
            let n: Vec<i64> = serde_json::from_str(new.as_deref()?).ok()?;
            if o[2..] == n[2..] {
                json!({ "kind": "moved", "id": key, "by": [n[0] - o[0], n[1] - o[1]] })
            } else {
                json!({ "kind": "resized", "id": key, "bounds": n })
            }
        }
        Edit::Field { key, field, .. } => json!({ "kind": "edited", "id": key, "field": field }),
        Edit::Text { key, new, .. } => {
            json!({ "kind": "edited", "id": key, "field": "text", "text": new })
        }
        Edit::Data { key, name, .. } => {
            json!({ "kind": "edited", "id": key, "field": format!("data.{name}") })
        }
        Edit::Library { .. } => return None,
    })
}

pub fn freeze(
    tx: &mut Transaction,
    person: &str,
    device: &str,
    raw: &Value,
    frontier: &[String],
    now_ms: i64,
) -> Result<String, FreezeError> {
    let Some(send_id) = raw.get("send").and_then(|v| v.as_str()) else {
        return Err(FreezeError::Rejected(vec![OpError::new(
            0,
            Code::InvalidInput,
            "A raw Send needs its ID.",
            "Generate a Send ID on the device and pass it as \"send\".",
        )]));
    };
    let sends = doc::root(tx, "sends");
    if let Some(existing) = doc::get_str(tx, &sends, send_id) {
        // A frozen Send never changes.
        return Err(FreezeError::Existing(existing));
    }
    let me = Principal::Person(person.to_string());
    // A tap (a notify Behavior) doesn't end the person's turn, so it claims nothing.
    let tap = raw.get("kind").and_then(Value::as_str) == Some("tap");
    let claims = doc::root(tx, "claims");
    let claimed = |tx: &Transaction, k: &str| doc::get_str(tx, &claims, k).is_some();

    // Unsent strokes: this person's live Ink no earlier Send has claimed.
    let mut strokes: Vec<String> = doc::live_records(tx)
        .into_iter()
        .filter(|r| {
            !tap && r.typ == "ink" && r.owner == me && !claimed(tx, &format!("stroke:{}", r.key))
        })
        .map(|r| r.key)
        .collect();
    if let Some(extra) = raw.get("strokes").and_then(|v| v.as_array()) {
        let mut errs = vec![];
        for s in extra.iter().filter_map(|v| v.as_str()) {
            match doc::live_record(tx, s) {
                Some(r) if r.typ == "ink" && r.owner == me => {
                    if !strokes.iter().any(|k| k == s) {
                        strokes.push(s.to_string());
                    }
                }
                _ => errs.push(OpError::new(
                    0,
                    Code::UnknownId,
                    format!("'{s}' is not one of your strokes."),
                    "Pass the IDs of strokes you drew.",
                )),
            }
        }
        if !errs.is_empty() {
            return Err(FreezeError::Rejected(errs));
        }
    }

    // Unsent changes: this person's done actions no earlier Send has claimed.
    let entries: Vec<_> = crate::history_entries(tx, person)
        .into_iter()
        .filter(|e| !tap && e.state == "done" && !claimed(tx, &format!("entry:{}", e.id)))
        .collect();
    let changes: Vec<Value> = entries
        .iter()
        .flat_map(|e| e.edits.iter().filter_map(summarize))
        .collect();

    let mut record = json!({
        "send": send_id,
        "space": doc::get_str(tx, &doc::root(tx, "meta"), "space"),
        "from": me.to_json(),
        "device": device,
        "trigger": raw.get("trigger").cloned().unwrap_or(json!("button")),
        "frontier": frontier,
        "strokes": strokes,
        "changes": changes,
        "at": now_ms,
        "state": "ready",
    });
    for k in [
        "said",
        "viewport",
        "selection",
        "words",
        "hints",
        "crops",
        "embed_anchors",
        "kind",
        "behavior",
        "panels",
        "times",
    ] {
        if let Some(v) = raw.get(k) {
            record[k] = v.clone();
        }
    }
    let text = record.to_string();
    tx.put(&sends, send_id, text.as_str())?;
    for s in &strokes {
        tx.put(&claims, format!("stroke:{s}"), send_id)?;
    }
    for e in &entries {
        tx.put(&claims, format!("entry:{}", e.id), send_id)?;
    }
    Ok(text)
}
