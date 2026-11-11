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

fn summarize(e: &Edit) -> Option<Value> {
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

    // A Behavior trigger (`element` + `on`) runs the Behaviors the Element's
    // owner attached for it. A `send` action makes this a full Send; a
    // `notify` makes it a tap, which leaves the person's turn open and claims
    // nothing; anything else (set, apply_recipe, open_panel) is an action the
    // Link runs and nobody receives.
    let mut kind = "send";
    let mut extra = serde_json::Map::new();
    if let Some(el) = raw.get("element").and_then(Value::as_str) {
        let Some(rec) = crate::apply::resolve(tx, &me, el).and_then(|k| doc::live_record(tx, &k))
        else {
            return Err(FreezeError::Rejected(vec![OpError::new(
                0,
                Code::UnknownId,
                format!("No Element '{el}'."),
                "Pass the ID of the Element that was interacted with.",
            )]));
        };
        extra.insert("element".into(), json!(rec.key));
        extra.insert("owner".into(), rec.owner.to_json());
        if let Some(on) = raw.get("on").and_then(Value::as_str) {
            let event = raw.get("event").and_then(Value::as_str);
            let fired: Vec<Value> = rec
                .field_json("behaviors")
                .and_then(|b| b.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter(|b| {
                    b["on"].as_str() == Some(on)
                        && (on != "embed_event" || b["event"].as_str() == event)
                })
                .collect();
            if fired.is_empty() {
                return Err(FreezeError::Rejected(vec![OpError::new(
                    0,
                    Code::InvalidInput,
                    format!("'{el}' has no Behavior for {on}."),
                    "Fire only the triggers the Element's Behaviors name.",
                )]));
            }
            let does = |d: &str| fired.iter().any(|b| b["do"].as_str() == Some(d));
            kind = if does("send") {
                "send"
            } else if does("notify") {
                "tap"
            } else {
                "action"
            };
            if let Some(p) = fired
                .iter()
                .find(|b| matches!(b["do"].as_str(), Some("send" | "notify")))
                .and_then(|b| b.get("payload"))
            {
                extra.insert("payload".into(), p.clone());
            }
            extra.insert("on".into(), json!(on));
            extra.insert("actions".into(), Value::Array(fired));
        }
    }
    if let Some(r) = raw.get("region").and_then(Value::as_str) {
        if let Some(rec) = crate::apply::resolve(tx, &me, r).and_then(|k| doc::live_record(tx, &k))
        {
            extra.insert("region".into(), json!(rec.key));
            extra.insert("owner".into(), rec.owner.to_json());
        }
    }
    let claims = doc::root(tx, "claims");
    let claimed = |tx: &Transaction, k: &str| doc::get_str(tx, &claims, k).is_some();

    // Unsent strokes: this person's live Ink no earlier Send has claimed.
    let claiming = kind == "send";
    let mut strokes: Vec<String> = doc::live_records(tx)
        .into_iter()
        .filter(|r| {
            claiming
                && r.typ == "ink"
                && r.owner == me
                && !claimed(tx, &format!("stroke:{}", r.key))
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
        .filter(|e| claiming && e.state == "done" && !claimed(tx, &format!("entry:{}", e.id)))
        .collect();
    let changes: Vec<Value> = entries
        .iter()
        .flat_map(|e| match (&e.info, e.kind.as_str()) {
            // An import is one change, whatever Elements it made.
            (Some(info), "add_file") => {
                let mut c = json!({ "kind": "added_file", "id": info["id"], "file": info["file"], "mime": info["mime"] });
                if let Some(n) = info.get("pages") {
                    c["pages"] = n.clone();
                }
                vec![c]
            }
            _ => e.edits.iter().filter_map(summarize).collect(),
        })
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
        "kind": kind,
    });
    for (k, v) in extra {
        record[k] = v;
    }
    for k in [
        "said",
        "viewport",
        "selection",
        "words",
        "hints",
        "crops",
        "embed_anchors",
        "event",
        "values",
        "panel",
    ] {
        if let Some(v) = raw.get(k) {
            record[k] = v.clone();
        }
    }
    if let Some(p) = raw.get("payload").filter(|p| p.is_object()) {
        record["payload"] = p.clone();
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
