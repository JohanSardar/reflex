//! Authorization of changes received from a peer (ARCHITECTURE §7.2).
//!
//! A peer may only bring changes its principals were allowed to make. The
//! caller says who the peer writes for (`Writers`), from its authenticated
//! pairing record. The incoming changes are applied to a fork first, and every
//! record they touch is checked against the ownership rules the kernel itself
//! enforces on local writes:
//!
//! - An Element's ID, type and owner never change.
//! - A new Element must be owned by one of the writers.
//! - Ink can be changed or erased only by the person who drew it.
//! - An Agent's Element can be changed by that Agent, or by a person.
//! - A Send must come from a writing person and never changes; claims point
//!   only at such Sends.
//! - History entries, batch records and Agent focus belong to their principal.
//! - The Space's identity (`meta`) never changes after genesis.
//!
//! Ownership is immutable, so checking it against the state before the
//! incoming changes gives the same answer as checking it at each writer's own
//! frontier. Roles (owner, editor, viewer) arrive with shared Spaces (T22) and
//! are checked here too.

use crate::doc;
use crate::model::Principal;
use automerge::{Automerge, ObjId, ObjType, ReadDoc, Value as AmValue};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// Who a peer writes for.
pub struct Writers {
    pub any: bool,
    pub people: Vec<String>,
    /// `None` means any Agent (a peer that hosts Agents, such as another Link).
    pub agents: Option<Vec<String>>,
}

impl Writers {
    pub fn parse(v: &Value) -> Writers {
        let list = |k: &str| {
            v.get(k).and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
        };
        Writers {
            any: v.get("any").and_then(Value::as_bool).unwrap_or(false),
            people: list("people").unwrap_or_default(),
            agents: match v.get("agents") {
                Some(Value::String(s)) if s == "*" => None,
                _ => Some(list("agents").unwrap_or_default()),
            },
        }
    }

    fn person(&self, id: &str) -> bool {
        self.people.iter().any(|p| p == id)
    }

    fn agent(&self, id: &str) -> bool {
        self.agents
            .as_ref()
            .is_none_or(|a| a.iter().any(|x| x == id))
    }

    fn principal(&self, p: &Principal) -> bool {
        match p {
            Principal::Person(id) => self.person(id),
            Principal::Agent(id) => self.agent(id),
        }
    }

    fn has_person(&self) -> bool {
        !self.people.is_empty()
    }
}

/// The whole value under one object, for comparing before and after.
fn dump<R: ReadDoc>(d: &R, obj: &ObjId) -> Value {
    match d.object_type(obj) {
        Ok(ObjType::Text) => json!({ "$text": d.text(obj).unwrap_or_default() }),
        Ok(ObjType::List) => Value::Array(
            (0..d.length(obj))
                .filter_map(|i| d.get(obj, i).ok().flatten())
                .map(|(v, id)| one(d, v, &id))
                .collect(),
        ),
        _ => {
            let mut m = Map::new();
            for k in d.keys(obj) {
                if let Ok(Some((v, id))) = d.get(obj, &k) {
                    m.insert(k.clone(), one(d, v, &id));
                }
            }
            Value::Object(m)
        }
    }
}

fn one<R: ReadDoc>(d: &R, v: AmValue<'_>, id: &ObjId) -> Value {
    match v {
        AmValue::Object(_) => dump(d, id),
        AmValue::Scalar(s) => match s.as_ref() {
            automerge::ScalarValue::Str(s) => json!(s.to_string()),
            other => json!(other.to_string()),
        },
    }
}

fn root_map<R: ReadDoc>(d: &R, name: &str) -> BTreeMap<String, Value> {
    let r = doc::root(d, name);
    match dump(d, &r) {
        Value::Object(m) => m.into_iter().collect(),
        _ => BTreeMap::new(),
    }
}

fn owner_of(v: &Value) -> Option<Principal> {
    v.get("owner")
        .and_then(Value::as_str)
        .and_then(Principal::decode)
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// Checks the changes that took `before` to `after`. Returns every violation.
pub fn check(before: &Automerge, after: &Automerge, w: &Writers) -> Vec<String> {
    if w.any {
        return vec![];
    }
    let mut errs = vec![];
    let changed = |name: &str| -> Vec<(String, Option<Value>, Option<Value>)> {
        let b = root_map(before, name);
        let a = root_map(after, name);
        let mut keys: Vec<&String> = b.keys().chain(a.keys()).collect();
        keys.sort();
        keys.dedup();
        keys.into_iter()
            .filter(|k| b.get(*k) != a.get(*k))
            .map(|k| (k.clone(), b.get(k).cloned(), a.get(k).cloned()))
            .collect()
    };

    if !changed("meta").is_empty() {
        errs.push("changed the Space's identity".to_string());
    }

    // Elements: who may touch which record.
    let may_change = |owner: &Principal, typ: &str| match owner {
        Principal::Person(p) if typ == "ink" => w.person(p),
        Principal::Person(_) => w.has_person(),
        Principal::Agent(a) => w.agent(a) || w.has_person(),
    };
    let before_elements = root_map(before, "elements");
    let before_removed = root_map(before, "removed");
    let was_removed = |key: &str| before_removed.values().any(|r| str_field(r, "key") == Some(key));
    let after_elements = root_map(after, "elements");
    for (key, b, a) in changed("elements") {
        match (&b, &a) {
            (None, Some(a)) => match owner_of(a) {
                Some(o) if w.principal(&o) => {}
                // Undoing a removal puts the Element back under its owner: allowed
                // when the writer may change it and it was removed before.
                Some(o)
                    if may_change(&o, str_field(a, "type").unwrap_or(""))
                        && was_removed(&key) => {}
                _ => errs.push(format!("created Element '{key}' for someone else")),
            },
            (Some(b), a) => {
                let (bo, bt) = (owner_of(b), str_field(b, "type").unwrap_or(""));
                if let Some(a) = a {
                    if owner_of(a) != bo
                        || str_field(a, "type") != Some(bt)
                        || str_field(a, "id") != str_field(b, "id")
                    {
                        errs.push(format!("changed the owner, type or ID of '{key}'"));
                        continue;
                    }
                }
                if !bo.as_ref().is_some_and(|o| may_change(o, bt)) {
                    errs.push(format!("changed '{key}', which it may not change"));
                }
            }
            (None, None) => {}
        }
    }
    for (inc, b, a) in changed("removed") {
        let (None, Some(a)) = (&b, &a) else {
            errs.push(format!("changed the removal record '{inc}'"));
            continue;
        };
        let by = str_field(a, "by").and_then(Principal::decode);
        let key = str_field(a, "key").unwrap_or("");
        let target = before_elements.get(key).or_else(|| after_elements.get(key));
        let ok_by = by.as_ref().is_some_and(|p| w.principal(p));
        let ok_target = target.is_some_and(|t| {
            owner_of(t).is_some_and(|o| may_change(&o, str_field(t, "type").unwrap_or("")))
        });
        if !ok_by || !ok_target {
            errs.push(format!("removed '{key}', which it may not remove"));
        }
    }

    // Sends and what they claim.
    let after_sends = root_map(after, "sends");
    let send_from = |s: &str| {
        after_sends
            .get(s)
            .and_then(Value::as_str)
            .and_then(|t| serde_json::from_str::<Value>(t).ok())
            .and_then(|v| v["from"]["person"].as_str().map(String::from))
    };
    for (id, b, _) in changed("sends") {
        if b.is_some() {
            errs.push(format!("changed the frozen Send '{id}'"));
        } else if !send_from(&id).is_some_and(|p| w.person(&p)) {
            errs.push(format!("made Send '{id}' for someone else"));
        }
    }
    for (claim, _, a) in changed("claims") {
        let ok = a
            .as_ref()
            .and_then(Value::as_str)
            .and_then(send_from)
            .is_some_and(|p| w.person(&p));
        if !ok {
            errs.push(format!("changed the claim '{claim}'"));
        }
    }

    // Records that belong to one principal.
    for (slot, _, _) in changed("history") {
        let person = slot.split('|').next().unwrap_or("");
        if !w.person(person) {
            errs.push(format!("changed {person}'s undo history"));
        }
    }
    for (batch, _, a) in changed("batches") {
        if !a
            .as_ref()
            .and_then(|a| str_field(a, "agent"))
            .is_some_and(|x| w.agent(x))
        {
            errs.push(format!(
                "wrote the batch record '{batch}' for another Agent"
            ));
        }
    }
    for (agent, _, _) in changed("agents") {
        if !w.agent(&agent) {
            errs.push(format!("changed Agent {agent}'s focus"));
        }
    }
    if !changed("library").is_empty()
        && !w.has_person()
        && w.agents.as_ref().is_some_and(|a| a.is_empty())
    {
        errs.push("changed the Library".to_string());
    }
    errs
}
