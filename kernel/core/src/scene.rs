//! Scene projection and the kernel's geometric lints.
//!
//! Elements come out in the protocol's shapes, through the generated types:
//! `detail: "full"` gives `element.schema.json` Elements, `"outline"` gives
//! `scene-item.schema.json` items, and `"strokes"` gives raw Ink points as in
//! `read.output.schema.json`.

use crate::apply::{connector_aware_bounds, display_id, Edit};
use crate::doc;
use crate::model::{has_text, Principal, Record};
use crate::ops::element_fields;
use crate::protocol as p;
use automerge::ReadDoc;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// Display names by principal ID, passed in by the caller (the kernel stores
/// IDs only). A missing name falls back to the ID.
pub type Names = BTreeMap<String, String>;

pub fn viewer_of(q: &Value) -> Option<Principal> {
    let v = q.get("viewer")?;
    if let Some(a) = v.get("agent").and_then(|a| a.as_str()) {
        return Some(Principal::Agent(a.to_string()));
    }
    v.get("person")
        .and_then(|p| p.as_str())
        .map(|p| Principal::Person(p.to_string()))
}

pub fn names_of(q: &Value) -> Names {
    q.get("names")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn name_for(names: &Names, who: &Principal) -> String {
    names
        .get(who.id())
        .cloned()
        .unwrap_or_else(|| who.id().to_string())
}

const ENVELOPE: &[&str] = &[
    "id",
    "type",
    "owner",
    "bounds",
    "text",
    "data",
    "type_version",
];

/// One Element as `element.schema.json` describes it, before typing.
pub fn element_value<R: ReadDoc>(
    d: &R,
    rec: &Record,
    viewer: Option<&Principal>,
    names: &Names,
) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(display_id(viewer, &rec.key)));
    m.insert("type".into(), json!(rec.typ));
    let mut owner = rec.owner.to_json();
    owner["name"] = json!(name_for(names, &rec.owner));
    m.insert("owner".into(), owner);
    m.insert("bounds".into(), json!(connector_aware_bounds(d, rec)));
    let fields = element_fields(&rec.typ);
    if fields.contains(&"type_version") {
        m.insert("type_version".into(), json!(rec.type_version));
    }
    if let Some(t) = &rec.text {
        if !t.is_empty() || matches!(rec.typ.as_str(), "text" | "note") {
            m.insert("text".into(), json!(t));
        }
    }
    let ends = rec.field_json("ends");
    for f in fields.iter().filter(|f| !ENVELOPE.contains(f)) {
        let v = match *f {
            "from" | "to" => ends
                .as_ref()
                .and_then(|e| e.get(*f))
                .and_then(Value::as_str)
                .map(|k| json!(display_id(viewer, k))),
            // snap.to names Elements by the owner's IDs; show them as this viewer sees them.
            "snap" => rec.field_json("snap").map(|mut v| {
                if let Some(to) = v.get_mut("to").and_then(Value::as_array_mut) {
                    for t in to.iter_mut() {
                        if let Some(id) = t.as_str().filter(|id| !id.contains(':')) {
                            let key = match &rec.owner {
                                Principal::Agent(a) => format!("{a}/{id}"),
                                Principal::Person(_) => id.to_string(),
                            };
                            *t = json!(display_id(viewer, &key));
                        }
                    }
                }
                v
            }),
            "parent" => rec
                .field_json("parent")
                .and_then(|p| p.as_str().map(|k| json!(display_id(viewer, k)))),
            _ => rec.field_json(f),
        };
        if let Some(v) = v {
            m.insert((*f).into(), v);
        }
    }
    if !rec.data.is_empty() {
        let data: Map<String, Value> = rec
            .data
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::from_str(v).unwrap_or(Value::Null)))
            .collect();
        m.insert("data".into(), Value::Object(data));
    }
    Value::Object(m)
}

/// Typed through the generated protocol type, so the output is exactly the schema's.
fn typed<T: serde::Serialize + serde::de::DeserializeOwned>(v: Value) -> Value {
    match serde_json::from_value::<T>(v.clone()) {
        Ok(t) => serde_json::to_value(t).unwrap_or(v),
        Err(_) => v,
    }
}

fn contains(outer: [i64; 4], inner: [i64; 4]) -> bool {
    inner[0] >= outer[0]
        && inner[1] >= outer[1]
        && inner[0] + inner[2] <= outer[0] + outer[2]
        && inner[1] + inner[3] <= outer[1] + outer[3]
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    }
}

/// One Element as `scene-item.schema.json` describes it.
fn item_value<R: ReadDoc>(
    d: &R,
    rec: &Record,
    viewer: Option<&Principal>,
    names: &Names,
    all: &[Record],
) -> Value {
    let full = element_value(d, rec, viewer, names);
    let mut m = Map::new();
    m.insert("id".into(), full["id"].clone());
    m.insert("type".into(), full["type"].clone());
    let by = if viewer == Some(&rec.owner) {
        "you".to_string()
    } else {
        name_for(names, &rec.owner)
    };
    m.insert("by".into(), json!(by));
    let b = connector_aware_bounds(d, rec);
    m.insert("bounds".into(), json!(b));
    let text = ["text", "latex", "title", "name"]
        .iter()
        .find_map(|k| full.get(*k).and_then(Value::as_str));
    if let Some(t) = text.filter(|t| !t.is_empty()) {
        m.insert("text".into(), json!(cut(t, 200)));
    }
    for k in ["from", "to", "data", "state"] {
        if let Some(v) = full.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    // The smallest frame or Region it sits in.
    let host = all
        .iter()
        .filter(|r| (r.typ == "frame" || r.typ == "region") && r.key != rec.key)
        .filter(|r| contains(r.bounds, b))
        .min_by_key(|r| r.bounds[2] * r.bounds[3]);
    if let Some(h) = host {
        m.insert("in".into(), json!(display_id(viewer, &h.key)));
    }
    Value::Object(m)
}

/// Raw Ink points as `[x, y, t, pressure]`. Devices send `[x, y]`,
/// `[x, y, pressure]` or `[x, y, t, pressure]`.
fn stroke_value(rec: &Record, viewer: Option<&Principal>) -> Value {
    let pts: Vec<Value> = rec
        .field_json("stroke")
        .and_then(|s| s.get("points").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_array)
        .map(|a| {
            let n = |i: usize| a.get(i).and_then(Value::as_f64).unwrap_or(0.0);
            match a.len() {
                2 => json!([n(0), n(1), 0, 0.5]),
                3 => json!([n(0), n(1), 0, n(2)]),
                _ => json!([n(0), n(1), n(2).max(0.0) as i64, n(3)]),
            }
        })
        .collect();
    json!({ "id": display_id(viewer, &rec.key), "points": pts })
}

pub fn scene<R: ReadDoc>(d: &R, q: &Value, heads: &[String]) -> Value {
    let detail = q.get("detail").and_then(|v| v.as_str()).unwrap_or("full");
    let viewer = viewer_of(q);
    let names = names_of(q);
    let only: Option<Vec<String>> = q.get("ids").and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    });
    let all = doc::live_records(d);
    let chosen: Vec<&Record> = all
        .iter()
        .filter(|r| {
            only.as_ref().is_none_or(|ids| {
                let shown = display_id(viewer.as_ref(), &r.key);
                ids.contains(&shown) || ids.contains(&r.key)
            })
        })
        .collect();
    let elements: Vec<Value> = match detail {
        "outline" => chosen
            .iter()
            .map(|r| typed::<p::SceneItem>(item_value(d, r, viewer.as_ref(), &names, &all)))
            .collect(),
        "strokes" => chosen
            .iter()
            .filter(|r| r.typ == "ink")
            .map(|r| stroke_value(r, viewer.as_ref()))
            .collect(),
        _ => chosen
            .iter()
            .map(|r| typed::<p::Element>(element_value(d, r, viewer.as_ref(), &names)))
            .collect(),
    };
    let meta = doc::root(d, "meta");
    let mut out = json!({
        "space": doc::get_str(d, &meta, "space"),
        "kind": doc::get_str(d, &meta, "kind"),
        "heads": heads,
        "elements": elements,
    });
    if detail == "full" {
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
            .filter_map(|(k, v)| {
                serde_json::from_str::<Value>(&v)
                    .ok()
                    .and_then(|v| v.get("focus").cloned())
                    .map(|f| (k, f))
            })
            .collect();
        if !focus.is_empty() {
            out["focus"] = Value::Object(focus);
        }
        let attention: Map<String, Value> = doc::str_map(d, &agents)
            .into_iter()
            .filter_map(|(k, v)| {
                let mut a = serde_json::from_str::<Value>(&v)
                    .ok()?
                    .get("attention")?
                    .clone();
                if let Some(ids) = a.get("ids").and_then(Value::as_array).cloned() {
                    a["ids"] = json!(ids
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|k| display_id(viewer.as_ref(), k))
                        .collect::<Vec<_>>());
                }
                Some((k, a))
            })
            .collect();
        if !attention.is_empty() {
            out["attention"] = Value::Object(attention);
        }
    }
    out
}

fn overlaps(a: [i64; 4], b: [i64; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

/// Warnings for what a batch just wrote, in `apply.output.schema.json`'s lint
/// shape. Only geometric facts the kernel can know.
pub fn lints<R: ReadDoc>(d: &R, agent: &Principal, edits: &[Edit]) -> Vec<Value> {
    let all = doc::live_records(d);
    let ink: Vec<&Record> = all
        .iter()
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
        let Some(rec) = doc::live_record(d, &key) else {
            continue;
        };
        if rec.typ == "connector" || rec.typ == "ink" {
            continue;
        }
        let id = display_id(Some(agent), &key);
        let b = connector_aware_bounds(d, &rec);
        if let Some(hit) = ink.iter().find(|i| overlaps(b, i.bounds)) {
            let ink_id = display_id(Some(agent), &hit.key);
            out.push(json!({
                "id": id,
                "code": "overlaps_ink",
                "msg": format!("'{id}' covers the person's Ink '{ink_id}'."),
                "fix": format!("Move it next to the Ink: patch set at: {{\"right_of\": \"{ink_id}\"}}."),
            }));
            continue;
        }
        // Text that sits on top of another Element of this Agent's, other than a container.
        let other = all.iter().find(|r| {
            r.key != key
                && has_text(&r.typ)
                && r.typ != "connector"
                && r.owner == rec.owner
                && overlaps(b, r.bounds)
                && !contains(b, r.bounds)
                && !contains(r.bounds, b)
        });
        if let (true, Some(o)) = (has_text(&rec.typ), other) {
            let oid = display_id(Some(agent), &o.key);
            out.push(json!({
                "id": id,
                "code": "overlaps",
                "msg": format!("'{id}' overlaps '{oid}'."),
                "fix": format!("Place it with at: {{\"below\": \"{oid}\"}}, or use arrange."),
            }));
        }
    }
    out
}
