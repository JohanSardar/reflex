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

/// The most strokes one watch snapshot carries (ARCHITECTURE §7.6, watch-mode size budget).
pub const MAX_WATCH_STROKES: usize = 1500;

/// Whether `b` lies in the Region `r`: its center is inside.
pub fn inside(r: [i64; 4], b: [i64; 4]) -> bool {
    let (cx, cy) = (b[0] + b[2] / 2, b[1] + b[3] / 2);
    cx >= r[0] && cx <= r[0] + r[2] && cy >= r[1] && cy <= r[1] + r[3]
}

/// Where the Element an edit touched is (or was).
fn edit_bounds(tx: &Transaction, e: &Edit) -> Option<[i64; 4]> {
    match e {
        Edit::Create { snapshot } | Edit::Delete { snapshot } => {
            Record::from_snapshot(snapshot).map(|r| r.bounds)
        }
        Edit::Field { field, new, .. } if field == "bounds" => {
            serde_json::from_str(new.as_deref()?).ok()
        }
        _ => doc::live_record(tx, &e.key()).map(|r| r.bounds),
    }
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
    let trigger = raw
        .get("trigger")
        .and_then(Value::as_str)
        .unwrap_or("button");
    // A Region's Send button, or a watch snapshot, carries only that Region's work.
    let mut scope: Option<[i64; 4]> = None;
    if let Some(r) = raw.get("region").and_then(Value::as_str) {
        let rec = crate::apply::resolve(tx, &me, r).and_then(|k| doc::live_record(tx, &k));
        match rec {
            Some(rec) if rec.typ == "region" => {
                if matches!(trigger, "region" | "watch") {
                    scope = Some(rec.bounds);
                }
                if trigger == "watch" && rec.field_json("watch") != Some(Value::Bool(true)) {
                    return Err(FreezeError::Rejected(vec![OpError::new(
                        0,
                        Code::InvalidInput,
                        format!("Region '{r}' is not watched."),
                        "Send watch snapshots only for a Region whose watch is on.",
                    )]));
                }
                extra.insert("region".into(), json!(rec.key));
                extra.insert("owner".into(), rec.owner.to_json());
            }
            _ if matches!(trigger, "region" | "watch") => {
                return Err(FreezeError::Rejected(vec![OpError::new(
                    0,
                    Code::UnknownId,
                    format!("No Region '{r}'."),
                    "Pass the ID of the Region whose Send button was pressed.",
                )]))
            }
            _ => {}
        }
    } else if matches!(trigger, "region" | "watch") {
        return Err(FreezeError::Rejected(vec![OpError::new(
            0,
            Code::InvalidInput,
            format!("A {trigger} Send needs its region."),
            "Pass the Region's ID as \"region\".",
        )]));
    }
    if trigger == "watch" {
        kind = "watch";
    }
    let within = |b: [i64; 4]| scope.is_none_or(|r| inside(r, b));
    let claims = doc::root(tx, "claims");
    let claimed = |tx: &Transaction, k: &str| doc::get_str(tx, &claims, k).is_some();

    // Unsent strokes: this person's live Ink no earlier Send has claimed. A watch
    // snapshot claims nothing; it shows all of the person's Ink in the Region, so the
    // Region's own Send later still carries the work.
    let claiming = kind == "send";
    let watching = kind == "watch";
    let mut strokes: Vec<String> = doc::live_records(tx)
        .into_iter()
        .filter(|r| r.typ == "ink" && r.owner == me && within(r.bounds))
        .filter(|r| watching || (claiming && !claimed(tx, &format!("stroke:{}", r.key))))
        .map(|r| r.key)
        .collect();
    if watching && strokes.len() > MAX_WATCH_STROKES {
        // The newest strokes: the person's latest work matters most.
        let times = crate::marks::stroke_times(tx, person);
        strokes.sort_by_key(|k| times.get(k).copied().unwrap_or(0));
        strokes.drain(..strokes.len() - MAX_WATCH_STROKES);
    }
    // A Region's Send also shows the work already sent from it, so its lines are
    // numbered from the top of the Region and a correction reads in place. Those
    // strokes are context: claimed before, not claimed again.
    let mut context: Vec<String> = if scope.is_some() && claiming {
        doc::live_records(tx)
            .into_iter()
            .filter(|r| r.typ == "ink" && r.owner == me && within(r.bounds))
            .filter(|r| claimed(tx, &format!("stroke:{}", r.key)))
            .map(|r| r.key)
            .collect()
    } else {
        vec![]
    };
    if context.len() + strokes.len() > MAX_WATCH_STROKES {
        let times = crate::marks::stroke_times(tx, person);
        context.sort_by_key(|k| times.get(k).copied().unwrap_or(0));
        context.drain(..(context.len() + strokes.len() - MAX_WATCH_STROKES).min(context.len()));
    }
    if let Some(extra) = raw
        .get("strokes")
        .and_then(|v| v.as_array())
        .filter(|_| !watching)
    {
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
        // A Region's Send claims only the actions on what lies inside it.
        .filter(|e| {
            scope.is_none()
                || e.edits
                    .iter()
                    .all(|ed| edit_bounds(tx, ed).is_some_and(within))
        })
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
    if !context.is_empty() {
        record["context"] = json!(context);
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
        "user_still_writing",
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
