//! Scene projection and the kernel's geometric lints.
//!
//! STAND-IN: the scene Element shape follows ARCHITECTURE §4.3 (`id`, `type`,
//! `by`, `bounds`, `text`, ...) until T1's schemas land.

use crate::apply::{connector_aware_bounds, display_id, Edit};
use crate::doc;
use crate::model::{Principal, Record};
use automerge::ReadDoc;
use serde_json::{json, Map, Value};

fn viewer_of(q: &Value) -> Option<Principal> {
    let v = q.get("viewer")?;
    if let Some(a) = v.get("agent").and_then(|a| a.as_str()) {
        return Some(Principal::Agent(a.to_string()));
    }
    v.get("person")
        .and_then(|p| p.as_str())
        .map(|p| Principal::Person(p.to_string()))
}

pub fn element_json<R: ReadDoc>(d: &R, rec: &Record, viewer: Option<&Principal>, full: bool) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(display_id(viewer, &rec.key)));
    m.insert("type".into(), json!(rec.typ));
    m.insert("by".into(), rec.owner.to_json());
    m.insert("bounds".into(), json!(connector_aware_bounds(d, rec)));
    if let Some(t) = &rec.text {
        m.insert("text".into(), json!(t));
    }
    for name in ["shape", "color"] {
        if let Some(v) = rec.field_json(name) {
            m.insert(name.into(), v);
        }
    }
    if let Some(ends) = rec.field_json("ends") {
        for name in ["from", "to"] {
            if let Some(k) = ends.get(name).and_then(|v| v.as_str()) {
                m.insert(name.into(), json!(display_id(viewer, k)));
            }
        }
    }
    if full {
        m.insert("layer".into(), json!(rec.layer()));
        m.insert("type_version".into(), json!(rec.type_version));
        m.insert("incarnation".into(), json!(rec.incarnation));
        let data: Map<String, Value> = rec
            .data
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::from_str(v).unwrap_or(Value::Null)))
            .collect();
        m.insert("data".into(), Value::Object(data));
        for name in ["stroke", "origin", "props"] {
            if let Some(v) = rec.field_json(name) {
                m.insert(name.into(), v);
            }
        }
        if let Some(p) = rec.field_json("parent").and_then(|p| p.as_str().map(String::from)) {
            m.insert("parent".into(), json!(display_id(viewer, &p)));
        }
    }
    Value::Object(m)
}

pub fn scene<R: ReadDoc>(d: &R, q: &Value, heads: &[String]) -> Value {
    let full = q.get("detail").and_then(|v| v.as_str()) != Some("outline");
    let viewer = viewer_of(q);
    let only: Option<Vec<String>> = q
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect());
    let elements: Vec<Value> = doc::live_records(d)
        .iter()
        .filter(|r| {
            only.as_ref().is_none_or(|ids| {
                let shown = display_id(viewer.as_ref(), &r.key);
                ids.contains(&shown) || ids.contains(&r.key)
            })
        })
        .map(|r| element_json(d, r, viewer.as_ref(), full))
        .collect();
    let meta = doc::root(d, "meta");
    let mut out = json!({
        "space": doc::get_str(d, &meta, "space"),
        "kind": doc::get_str(d, &meta, "kind"),
        "heads": heads,
        "elements": elements,
    });
    if full {
        let sends = doc::root(d, "sends");
        out["sends"] = json!(d.keys(&sends).collect::<Vec<_>>());
        let library = doc::root(d, "library");
        let entries: Vec<Value> = doc::str_map(d, &library)
            .values()
            .filter_map(|v| serde_json::from_str(v).ok())
            .collect();
        if !entries.is_empty() || doc::get_str(d, &meta, "kind").as_deref() == Some("library") {
            out["library"] = json!(entries);
        }
        let agents = doc::root(d, "agents");
        let focus: Map<String, Value> = doc::str_map(d, &agents)
            .into_iter()
            .filter_map(|(k, v)| serde_json::from_str::<Value>(&v).ok().map(|v| (k, v["focus"].clone())))
            .collect();
        if !focus.is_empty() {
            out["focus"] = Value::Object(focus);
        }
    }
    out
}

fn overlaps(a: [i64; 4], b: [i64; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

/// Warnings for what a batch just wrote. Only geometric facts the kernel can
/// know; the wording an Agent sees is refined by the Agent layer (T4).
pub fn lints<R: ReadDoc>(d: &R, agent: &Principal, edits: &[Edit]) -> Vec<Value> {
    let ink: Vec<Record> = doc::live_records(d)
        .into_iter()
        .filter(|r| r.typ == "ink" && matches!(r.owner, Principal::Person(_)))
        .collect();
    let mut out = vec![];
    let mut seen = std::collections::BTreeSet::new();
    for e in edits {
        let key = match e {
            Edit::Create { .. } => e.key(),
            Edit::Field { field, .. } if field == "bounds" => e.key(),
            _ => continue,
        };
        if !seen.insert(key.clone()) {
            continue;
        }
        let Some(rec) = doc::live_record(d, &key) else { continue };
        if rec.typ == "connector" || rec.typ == "ink" {
            continue;
        }
        let b = connector_aware_bounds(d, &rec);
        if let Some(hit) = ink.iter().find(|i| overlaps(b, i.bounds)) {
            let id = display_id(Some(agent), &key);
            out.push(json!({
                "id": id,
                "code": "overlaps_ink",
                "msg": format!("'{id}' covers the user's Ink '{}'.", hit.key),
                "fix": format!("Move it with at: {{\"below\": \"{}\"}}.", hit.key),
            }));
        }
    }
    out
}
