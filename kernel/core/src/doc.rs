//! The mapping between the logical Space and the Automerge document.
//!
//! This is the one place that knows the CRDT layout (ADR-0005). Layout:
//!
//! ```text
//! ROOT
//! ├─ meta       Map   space: str, kind: "space" | "library", schema: int
//! ├─ elements   Map   <key> -> Element Map
//! │                    id, type, type_version, owner, incarnation, order: str/int registers
//! │                    bounds: str   JSON [x,y,w,h], one atomic register
//! │                    text:   Text  collaborative, UTF-16 indexed
//! │                    data:   Map   <key> -> JSON text, one register per key
//! │                    <field>: str  JSON text, one register per type field
//! ├─ removed    Map   <incarnation> -> {key, by, at}   immutable removal records
//! ├─ batches    Map   <batch id> -> {agent, request, hash, at, edits, result}
//! ├─ history    Map   <person>|<order>|<entry id> -> {device, kind, edits, state, at}
//! ├─ sends      Map   <send id> -> JSON text of the frozen Send (immutable)
//! ├─ claims     Map   stroke:<key> | entry:<id> -> send id
//! ├─ library    Map   <kind>:<name> -> JSON text of a saved Recipe or Embed Template
//! └─ agents     Map   <agent id> -> JSON text {focus}
//! ```
//!
//! Every root container is created by a shared, deterministic genesis change,
//! so two replicas that create the same Space independently produce the
//! byte-identical first change and never hold competing root maps.

use crate::model::{Principal, Record};
use automerge::transaction::Transactable;
use automerge::{
    ActorId, Automerge, LoadOptions, ObjId, ObjType, ReadDoc, ScalarValue, TextEncoding, Value,
    ROOT,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: i64 = 1;
pub const ROOTS: &[&str] = &[
    "meta", "elements", "removed", "batches", "history", "sends", "claims", "library", "agents",
];
pub const ENCODING: TextEncoding = TextEncoding::Utf16CodeUnit;

pub fn sha_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p);
    }
    hex::encode(h.finalize())
}

/// The actor that writes the genesis change. Derived from the Space ID only.
fn genesis_actor(space_id: &str) -> ActorId {
    let h = sha_hex(&[b"reflex-genesis", space_id.as_bytes()]);
    ActorId::from(hex::decode(&h[..32]).expect("hex"))
}

/// Builds the deterministic genesis document for a Space.
pub fn genesis(space_id: &str, kind: &str) -> Automerge {
    let mut doc = Automerge::new_with_encoding(ENCODING);
    doc.set_actor(genesis_actor(space_id));
    doc.transact_with::<_, _, automerge::AutomergeError, _>(
        |_| automerge::transaction::CommitOptions::default()
            .with_time(0)
            .with_message("genesis".to_string()),
        |tx| {
            for name in ROOTS {
                tx.put_object(ROOT, *name, ObjType::Map)?;
            }
            let meta = obj(tx, &ROOT, "meta").expect("meta");
            tx.put(&meta, "space", space_id)?;
            tx.put(&meta, "kind", kind)?;
            tx.put(&meta, "schema", SCHEMA_VERSION)?;
            Ok(())
        },
    )
    .expect("genesis cannot fail");
    doc
}

pub fn load(bytes: &[u8]) -> Result<Automerge, automerge::AutomergeError> {
    Automerge::load_with_options(bytes, LoadOptions::new().text_encoding(ENCODING))
}

pub fn obj<R: ReadDoc>(doc: &R, parent: &ObjId, key: &str) -> Option<ObjId> {
    match doc.get(parent, key).ok()?? {
        (Value::Object(_), id) => Some(id),
        _ => None,
    }
}

pub fn root<R: ReadDoc>(doc: &R, name: &str) -> ObjId {
    obj(doc, &ROOT, name).unwrap_or_else(|| panic!("missing root container {name}"))
}

pub fn get_str<R: ReadDoc>(doc: &R, parent: &ObjId, key: &str) -> Option<String> {
    match doc.get(parent, key).ok()?? {
        (Value::Scalar(s), _) => match s.as_ref() {
            ScalarValue::Str(s) => Some(s.to_string()),
            _ => None,
        },
        _ => None,
    }
}

pub fn get_int<R: ReadDoc>(doc: &R, parent: &ObjId, key: &str) -> Option<i64> {
    match doc.get(parent, key).ok()?? {
        (Value::Scalar(s), _) => match s.as_ref() {
            ScalarValue::Int(i) => Some(*i),
            ScalarValue::Uint(u) => i64::try_from(*u).ok(),
            _ => None,
        },
        _ => None,
    }
}

pub fn str_map<R: ReadDoc>(doc: &R, m: &ObjId) -> BTreeMap<String, String> {
    doc.keys(m)
        .filter_map(|k| get_str(doc, m, &k).map(|v| (k, v)))
        .collect()
}

const ENVELOPE: &[&str] = &[
    "id", "type", "type_version", "owner", "incarnation", "order", "bounds", "text", "data",
];

pub fn read_record<R: ReadDoc>(doc: &R, key: &str) -> Option<Record> {
    let elements = root(doc, "elements");
    let el = obj(doc, &elements, key)?;
    let bounds: Vec<i64> = serde_json::from_str(&get_str(doc, &el, "bounds")?).ok()?;
    let mut b = [0i64; 4];
    for (i, v) in bounds.iter().take(4).enumerate() {
        b[i] = *v;
    }
    let text = obj(doc, &el, "text").and_then(|t| doc.text(&t).ok());
    let data = obj(doc, &el, "data")
        .map(|d| str_map(doc, &d))
        .unwrap_or_default();
    let mut fields = BTreeMap::new();
    for k in doc.keys(&el) {
        if ENVELOPE.contains(&k.as_str()) {
            continue;
        }
        if let Some(v) = get_str(doc, &el, &k) {
            fields.insert(k, v);
        }
    }
    Some(Record {
        key: key.to_string(),
        typ: get_str(doc, &el, "type")?,
        type_version: get_int(doc, &el, "type_version").unwrap_or(1),
        owner: Principal::decode(&get_str(doc, &el, "owner")?)?,
        incarnation: get_str(doc, &el, "incarnation")?,
        order: get_str(doc, &el, "order").unwrap_or_default(),
        bounds: b,
        text,
        fields,
        data,
    })
}

/// Every live Element: present in `elements` and not removed.
pub fn live_records<R: ReadDoc>(doc: &R) -> Vec<Record> {
    let elements = root(doc, "elements");
    let removed = root(doc, "removed");
    let mut out: Vec<Record> = doc
        .keys(&elements)
        .filter_map(|k| read_record(doc, &k))
        .filter(|r| doc.get(&removed, r.incarnation.as_str()).ok().flatten().is_none())
        .collect();
    out.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.key.cmp(&b.key)));
    out
}

pub fn live_record<R: ReadDoc>(doc: &R, key: &str) -> Option<Record> {
    let removed = root(doc, "removed");
    read_record(doc, key)
        .filter(|r| doc.get(&removed, r.incarnation.as_str()).ok().flatten().is_none())
}

pub fn write_record<T: Transactable + ReadDoc>(
    tx: &mut T,
    rec: &Record,
) -> Result<(), automerge::AutomergeError> {
    let elements = root(tx, "elements");
    let el = tx.put_object(&elements, rec.key.as_str(), ObjType::Map)?;
    tx.put(&el, "id", rec.key.as_str())?;
    tx.put(&el, "type", rec.typ.as_str())?;
    tx.put(&el, "type_version", rec.type_version)?;
    tx.put(&el, "owner", rec.owner.encode())?;
    tx.put(&el, "incarnation", rec.incarnation.as_str())?;
    tx.put(&el, "order", rec.order.as_str())?;
    tx.put(&el, "bounds", bounds_json(&rec.bounds))?;
    if let Some(text) = &rec.text {
        let t = tx.put_object(&el, "text", ObjType::Text)?;
        tx.splice_text(&t, 0, 0, text)?;
    }
    let d = tx.put_object(&el, "data", ObjType::Map)?;
    for (k, v) in &rec.data {
        tx.put(&d, k.as_str(), v.as_str())?;
    }
    for (k, v) in &rec.fields {
        tx.put(&el, k.as_str(), v.as_str())?;
    }
    Ok(())
}

pub fn bounds_json(b: &[i64; 4]) -> String {
    serde_json::to_string(b).expect("bounds")
}

pub fn element_obj<R: ReadDoc>(doc: &R, key: &str) -> Option<ObjId> {
    obj(doc, &root(doc, "elements"), key)
}

pub fn text_obj<T: Transactable + ReadDoc>(
    tx: &mut T,
    key: &str,
) -> Result<Option<ObjId>, automerge::AutomergeError> {
    let Some(el) = element_obj(tx, key) else {
        return Ok(None);
    };
    if let Some(t) = obj(tx, &el, "text") {
        return Ok(Some(t));
    }
    Ok(Some(tx.put_object(&el, "text", ObjType::Text)?))
}

pub fn data_obj<T: Transactable + ReadDoc>(
    tx: &mut T,
    key: &str,
) -> Result<Option<ObjId>, automerge::AutomergeError> {
    let Some(el) = element_obj(tx, key) else {
        return Ok(None);
    };
    if let Some(d) = obj(tx, &el, "data") {
        return Ok(Some(d));
    }
    Ok(Some(tx.put_object(&el, "data", ObjType::Map)?))
}
