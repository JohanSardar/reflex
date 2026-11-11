//! Logical model of a Space: principals and the record each Element is stored
//! as. The wire shapes of ops and Elements are the protocol's, generated from
//! `protocol/schema/` into `protocol.rs`.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Largest integer every runtime can carry losslessly (JS `Number.MAX_SAFE_INTEGER`).
pub const SAFE_INT: i64 = 9_007_199_254_740_991;

/// Size limit for one Element's free `data` map, in bytes of compact JSON.
pub const DATA_LIMIT_BYTES: usize = 16 * 1024;

/// A principal: a person or an Agent, each with a stable ID (ADR-0008).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Principal {
    Person(String),
    Agent(String),
}

impl Principal {
    /// The form stored in the document: `person:<id>` or `agent:<id>`.
    pub fn encode(&self) -> String {
        match self {
            Principal::Person(id) => format!("person:{id}"),
            Principal::Agent(id) => format!("agent:{id}"),
        }
    }

    pub fn decode(s: &str) -> Option<Principal> {
        if let Some(id) = s.strip_prefix("person:") {
            Some(Principal::Person(id.to_string()))
        } else {
            s.strip_prefix("agent:")
                .map(|id| Principal::Agent(id.to_string()))
        }
    }

    /// The wire form used in scenes and Sends: `{"person": id}` or `{"agent": id}`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        match self {
            Principal::Person(id) => m.insert("person".into(), Value::String(id.clone())),
            Principal::Agent(id) => m.insert("agent".into(), Value::String(id.clone())),
        };
        Value::Object(m)
    }

    pub fn id(&self) -> &str {
        match self {
            Principal::Person(id) | Principal::Agent(id) => id,
        }
    }
}

/// One Element as the kernel holds it between the CRDT and the projection.
///
/// `fields` holds every type-specific value as compact JSON text. Each one is a
/// single CRDT register, so values that must change together (a connector's
/// two ends, a stroke's geometry) are always one atomic write (ARCHITECTURE §7.1).
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    /// Storage key. Agent Elements are `<agent>/<local id>`; person Elements
    /// use the device-chosen ID, which never contains `/`.
    pub key: String,
    pub typ: String,
    pub type_version: i64,
    pub owner: Principal,
    pub incarnation: String,
    pub order: String,
    /// `[x, y, w, h]`, one atomic register.
    pub bounds: [i64; 4],
    /// Collaborative text, if the type carries text.
    pub text: Option<String>,
    /// Type-specific registers, each JSON text.
    pub fields: BTreeMap<String, String>,
    /// The free `data` map: key -> JSON text. Reflex never interprets it.
    pub data: BTreeMap<String, String>,
}

impl Record {
    pub fn field_json(&self, name: &str) -> Option<Value> {
        self.fields
            .get(name)
            .and_then(|s| serde_json::from_str(s).ok())
    }

    /// The whole record as JSON, used for undo snapshots and batch records.
    pub fn to_snapshot(&self) -> Value {
        serde_json::json!({
            "key": self.key,
            "type": self.typ,
            "type_version": self.type_version,
            "owner": self.owner.encode(),
            "incarnation": self.incarnation,
            "order": self.order,
            "bounds": self.bounds,
            "text": self.text,
            "fields": self.fields,
            "data": self.data,
        })
    }

    pub fn from_snapshot(v: &Value) -> Option<Record> {
        let o = v.as_object()?;
        let bounds_v = o.get("bounds")?.as_array()?;
        let mut bounds = [0i64; 4];
        for (i, b) in bounds_v.iter().take(4).enumerate() {
            bounds[i] = b.as_i64()?;
        }
        let str_map = |name: &str| -> BTreeMap<String, String> {
            o.get(name)
                .and_then(|m| m.as_object())
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default()
        };
        Some(Record {
            key: o.get("key")?.as_str()?.to_string(),
            typ: o.get("type")?.as_str()?.to_string(),
            type_version: o.get("type_version").and_then(|v| v.as_i64()).unwrap_or(1),
            owner: Principal::decode(o.get("owner")?.as_str()?)?,
            incarnation: o.get("incarnation")?.as_str()?.to_string(),
            order: o.get("order")?.as_str()?.to_string(),
            bounds,
            text: o.get("text").and_then(|t| t.as_str()).map(String::from),
            fields: str_map("fields"),
            data: str_map("data"),
        })
    }

    /// The layer an Element lives on is derived from its owner, never stored
    /// separately (gpt-sol §1.2).
    pub fn layer(&self) -> String {
        self.owner.encode()
    }
}

pub fn clamp_safe(v: i64) -> i64 {
    v.clamp(-SAFE_INT, SAFE_INT)
}

pub fn has_text(typ: &str) -> bool {
    matches!(typ, "text" | "note" | "shape" | "connector")
}
