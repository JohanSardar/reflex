//! Executing ops inside one Automerge transaction.
//!
//! Every write is recorded as an `Edit`. Edits are what undo (per person) and
//! revert (per Agent batch, T8) are planned from. Each edit carries both the old
//! and the new value, and replaying an edit only takes effect when the current
//! value still matches what the edit expects, so one person's undo never
//! clobbers another person's later change.

use crate::doc::{self, sha_hex};
use crate::model::{clamp_safe, has_text, Principal, Record, DATA_LIMIT_BYTES};
use crate::ops::{At, AddOp, Layout, Op, OpError, PatchOp, Rel};
use automerge::transaction::{Transactable, Transaction};
use automerge::{ObjType, ReadDoc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "e", rename_all = "snake_case")]
pub enum Edit {
    Create { snapshot: Value },
    Delete { snapshot: Value },
    Field { key: String, field: String, old: Option<String>, new: Option<String> },
    Text { key: String, old: String, new: String },
    Data { key: String, name: String, old: Option<String>, new: Option<String> },
    Library { key: String, old: Option<String>, new: Option<String> },
}

impl Edit {
    pub fn inverse(&self) -> Edit {
        match self.clone() {
            Edit::Create { snapshot } => Edit::Delete { snapshot },
            Edit::Delete { snapshot } => Edit::Create { snapshot },
            Edit::Field { key, field, old, new } => Edit::Field { key, field, old: new, new: old },
            Edit::Text { key, old, new } => Edit::Text { key, old: new, new: old },
            Edit::Data { key, name, old, new } => Edit::Data { key, name, old: new, new: old },
            Edit::Library { key, old, new } => Edit::Library { key, old: new, new: old },
        }
    }

    pub fn key(&self) -> String {
        match self {
            Edit::Create { snapshot } | Edit::Delete { snapshot } => {
                snapshot.get("key").and_then(|k| k.as_str()).unwrap_or("").to_string()
            }
            Edit::Field { key, .. } | Edit::Text { key, .. } | Edit::Data { key, .. } | Edit::Library { key, .. } => key.clone(),
        }
    }
}

pub struct Ctx<'a> {
    pub principal: &'a Principal,
    /// Batch ID for an Agent, history entry ID for a person.
    pub tag: &'a str,
    pub now_ms: i64,
    pub actor_hex: &'a str,
    pub space_kind: &'a str,
}

#[derive(Default, Debug)]
pub struct Outcome {
    pub edits: Vec<Edit>,
    pub ids: BTreeMap<String, String>,
    pub repaired: Vec<String>,
}

type Tx<'a> = Transaction<'a>;
type AmResult<T> = Result<T, automerge::AutomergeError>;

/// The storage key an Element ID refers to, from this principal's point of view.
/// Agents' own IDs are scoped to them (`<agent>/<id>`); a full key or a
/// person's Element ID is used as given.
pub fn resolve<R: ReadDoc>(doc: &R, p: &Principal, r: &str) -> Option<String> {
    if let Principal::Agent(a) = p {
        if !r.contains('/') {
            let own = format!("{a}/{r}");
            if doc::live_record(doc, &own).is_some() {
                return Some(own);
            }
        }
    }
    doc::live_record(doc, r).map(|_| r.to_string())
}

/// The ID a principal uses for a key: Agents see their own Elements by local ID.
pub fn display_id(viewer: Option<&Principal>, key: &str) -> String {
    if let Some(Principal::Agent(a)) = viewer {
        if let Some(local) = key.strip_prefix(&format!("{a}/")) {
            return local.to_string();
        }
    }
    key.to_string()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != *cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

fn unknown_id<R: ReadDoc>(doc: &R, p: &Principal, i: usize, r: &str, field: &str) -> OpError {
    let viewer = Some(p);
    let best = doc::live_records(doc)
        .into_iter()
        .map(|rec| display_id(viewer, &rec.key))
        .map(|id| (levenshtein(&id, r), id))
        .filter(|(d, id)| *d <= 3.max(id.len() / 3))
        .min();
    match best {
        Some((_, id)) => OpError::new(i, "unknown_id", format!("No Element '{r}'. Closest: '{id}'."), format!("Set {field} to '{id}'.")),
        None => OpError::new(i, "unknown_id", format!("No Element '{r}'."), "Call read to see the Element IDs in this Space."),
    }
}

/// May this principal change this Element? Ink belongs to whoever drew it,
/// and Agents only change their own Elements (ARCHITECTURE §3, SPEC §6).
fn check_owner(p: &Principal, rec: &Record, i: usize, shown: &str) -> Result<(), OpError> {
    match p {
        Principal::Agent(_) if &rec.owner != p => {
            let whose = match &rec.owner {
                Principal::Person(_) if rec.typ == "ink" => "a person's Ink".to_string(),
                Principal::Person(id) => format!("owned by person '{id}'"),
                Principal::Agent(id) => format!("owned by Agent '{id}'"),
            };
            Err(OpError::new(
                i,
                "not_yours",
                format!("'{shown}' is {whose}. Agents can only change their own Elements."),
                format!("Add a note next to it instead: {{\"op\": \"add\", \"type\": \"note\", \"at\": {{\"near\": \"{shown}\"}}}}."),
            ))
        }
        Principal::Person(_) if rec.typ == "ink" && &rec.owner != p => Err(OpError::new(
            i,
            "not_yours",
            format!("'{shown}' is another person's Ink."),
            "Only the person who drew a stroke can change or erase it.",
        )),
        _ => Ok(()),
    }
}

fn default_size(add: &AddOp) -> (i64, i64) {
    match add.typ.as_str() {
        "shape" => (160, 80),
        "note" => (200, 120),
        "text" => {
            let longest = add.text.as_deref().unwrap_or("").lines().map(|l| l.encode_utf16().count()).max().unwrap_or(0) as i64;
            let lines = add.text.as_deref().unwrap_or("").lines().count().max(1) as i64;
            ((longest * 10).max(40), lines * 24)
        }
        _ => (120, 80),
    }
}

fn stroke_bounds(stroke: &Value) -> [i64; 4] {
    let pts = stroke.get("points").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in &pts {
        let (x, y) = (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0));
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let w = stroke.get("width").and_then(|w| w.as_f64()).unwrap_or(2.0);
    let pad = (w / 2.0).ceil();
    [
        clamp_safe((x0 - pad).floor() as i64),
        clamp_safe((y0 - pad).floor() as i64),
        clamp_safe((x1 - x0 + 2.0 * pad).ceil() as i64),
        clamp_safe((y1 - y0 + 2.0 * pad).ceil() as i64),
    ]
}

fn place(at: &At, target: [i64; 4], size: (i64, i64)) -> (i64, i64) {
    let [x, y, w, h] = target;
    match at {
        At::Abs { x, y } => (*x, *y),
        At::Rel { rel, gap, .. } => match rel {
            Rel::RightOf | Rel::Near => (x + w + gap, y),
            Rel::LeftOf => (x - gap - size.0, y),
            Rel::Below => (x, y + h + gap),
            Rel::Above => (x, y - gap - size.1),
        },
    }
}

fn data_json(data: &BTreeMap<String, Value>) -> BTreeMap<String, String> {
    data.iter().map(|(k, v)| (k.clone(), v.to_string())).collect()
}

fn data_size(data: &BTreeMap<String, String>) -> usize {
    data.iter().map(|(k, v)| k.len() + v.len() + 4).sum()
}

fn new_incarnation(ctx: &Ctx, key: &str, i: usize) -> String {
    match ctx.principal {
        // Agent requests are idempotent (ARCHITECTURE §7.3): the same request
        // accepted on two paths yields the same incarnation.
        Principal::Agent(_) => sha_hex(&[ctx.tag.as_bytes(), key.as_bytes(), &(i as u64).to_le_bytes()])[..16].to_string(),
        Principal::Person(_) => sha_hex(&[ctx.actor_hex.as_bytes(), ctx.tag.as_bytes(), key.as_bytes(), &(i as u64).to_le_bytes()])[..16].to_string(),
    }
}

fn order_key(now_ms: i64, incarnation: &str) -> String {
    format!("{:013}-{}", now_ms.max(0), &incarnation[..8])
}

pub fn remove_record(tx: &mut Tx, rec: &Record, by: &Principal, now_ms: i64) -> AmResult<()> {
    let removed = doc::root(tx, "removed");
    let r = tx.put_object(&removed, rec.incarnation.as_str(), ObjType::Map)?;
    tx.put(&r, "key", rec.key.as_str())?;
    tx.put(&r, "by", by.encode())?;
    tx.put(&r, "at", now_ms)?;
    let elements = doc::root(tx, "elements");
    tx.delete(&elements, rec.key.as_str())?;
    Ok(())
}

fn set_field(tx: &mut Tx, key: &str, field: &str, value: Option<&str>) -> AmResult<()> {
    let Some(el) = doc::element_obj(tx, key) else { return Ok(()) };
    match value {
        Some(v) => tx.put(&el, field, v),
        None => tx.delete(&el, field),
    }
}

fn field_value(rec: &Record, field: &str) -> Option<String> {
    if field == "bounds" {
        Some(doc::bounds_json(&rec.bounds))
    } else {
        rec.fields.get(field).cloned()
    }
}

/// Runs a list of ops. All or nothing: on any error the caller drops the
/// transaction and returns every error.
pub fn run(tx: &mut Tx, ctx: &Ctx, ops: &[Option<Op>], parse_errs: Vec<OpError>) -> Result<Outcome, Vec<OpError>> {
    let mut out = Outcome::default();
    let mut errs = parse_errs;
    for (i, op) in ops.iter().enumerate() {
        let Some(op) = op else { continue };
        if let Err(mut e) = run_op(tx, ctx, i, op, &mut out) {
            errs.append(&mut e);
        }
    }
    if errs.is_empty() {
        Ok(out)
    } else {
        errs.sort_by_key(|e| e.op);
        Err(errs)
    }
}

fn am(i: usize) -> impl Fn(automerge::AutomergeError) -> Vec<OpError> {
    move |e| vec![OpError::new(i, "internal", format!("Kernel write failed: {e}"), "Retry; report this if it repeats.")]
}

fn run_op(tx: &mut Tx, ctx: &Ctx, i: usize, op: &Op, out: &mut Outcome) -> Result<(), Vec<OpError>> {
    let p = ctx.principal;
    match op {
        Op::Add(add) => {
            add_element(tx, ctx, i, add, None, out)?;
        }
        Op::Patch(patch) => patch_element(tx, ctx, i, patch, out)?,
        Op::Remove { refs } => {
            let mut errs = vec![];
            let mut recs = vec![];
            for r in refs {
                match resolve(tx, p, r).and_then(|k| doc::live_record(tx, &k)) {
                    None => errs.push(unknown_id(tx, p, i, r, "ids")),
                    Some(rec) => match check_owner(p, &rec, i, r) {
                        Ok(()) => recs.push(rec),
                        Err(e) => errs.push(e),
                    },
                }
            }
            if !errs.is_empty() {
                return Err(errs);
            }
            for rec in recs {
                remove_record(tx, &rec, p, ctx.now_ms).map_err(am(i))?;
                out.edits.push(Edit::Delete { snapshot: rec.to_snapshot() });
            }
        }
        Op::Move { refs, by } => {
            let recs = owned_records(tx, p, i, refs)?;
            for rec in recs {
                let mut b = rec.bounds;
                b[0] = clamp_safe(b[0] + by[0]);
                b[1] = clamp_safe(b[1] + by[1]);
                write_bounds(tx, &rec, b, i, out)?;
            }
        }
        Op::Arrange { refs, layout, gap } => {
            let recs = owned_records(tx, p, i, refs)?;
            let (mut x, mut y) = (recs[0].bounds[0], recs[0].bounds[1]);
            for rec in recs {
                let mut b = rec.bounds;
                b[0] = x;
                b[1] = y;
                match layout {
                    Layout::Row => x = clamp_safe(x + b[2] + gap),
                    Layout::Column => y = clamp_safe(y + b[3] + gap),
                }
                write_bounds(tx, &rec, b, i, out)?;
            }
        }
        Op::Focus { value } => {
            let Principal::Agent(a) = p else {
                return Err(vec![OpError::new(i, "not_allowed", "focus is an Agent op.", "People move their own viewport on the device.")]);
            };
            // One register per Agent, so two paths writing focus never create
            // competing containers.
            let agents = doc::root(tx, "agents");
            tx.put(&agents, a.as_str(), json!({ "focus": value }).to_string()).map_err(am(i))?;
        }
        Op::Define { kind, name, params, template } => {
            if ctx.space_kind != "library" {
                return Err(vec![OpError::new(
                    i,
                    "wrong_space",
                    "define saves to the Library, and this Space is not the Library.",
                    "Send define ops to the Space of kind \"library\".",
                )]);
            }
            let key = format!("{kind}:{name}");
            let library = doc::root(tx, "library");
            let old = doc::get_str(tx, &library, &key);
            let entry = json!({ "kind": kind, "name": name, "params": params, "template": template, "by": p.to_json() }).to_string();
            tx.put(&library, key.as_str(), entry.as_str()).map_err(am(i))?;
            out.edits.push(Edit::Library { key, old, new: Some(entry) });
        }
        Op::ErasePrecise { target, fragments } => {
            let rec = owned_records(tx, p, i, std::slice::from_ref(target))?.remove(0);
            if rec.typ != "ink" {
                return Err(vec![OpError::new(i, "bad_type", format!("'{target}' is not Ink."), "Use erase for Elements that are not Ink.")]);
            }
            remove_record(tx, &rec, p, ctx.now_ms).map_err(am(i))?;
            out.edits.push(Edit::Delete { snapshot: rec.to_snapshot() });
            for f in fragments {
                add_element(tx, ctx, i, f, Some(&rec), out)?;
            }
        }
    }
    Ok(())
}

fn owned_records(tx: &Tx, p: &Principal, i: usize, refs: &[String]) -> Result<Vec<Record>, Vec<OpError>> {
    let mut errs = vec![];
    let mut recs = vec![];
    for r in refs {
        match resolve(tx, p, r).and_then(|k| doc::live_record(tx, &k)) {
            None => errs.push(unknown_id(tx, p, i, r, "ids")),
            Some(rec) => match check_owner(p, &rec, i, r) {
                Ok(()) => recs.push(rec),
                Err(e) => errs.push(e),
            },
        }
    }
    if errs.is_empty() {
        Ok(recs)
    } else {
        Err(errs)
    }
}

fn write_bounds(tx: &mut Tx, rec: &Record, b: [i64; 4], i: usize, out: &mut Outcome) -> Result<(), Vec<OpError>> {
    let old = doc::bounds_json(&rec.bounds);
    let new = doc::bounds_json(&b);
    if old != new {
        set_field(tx, &rec.key, "bounds", Some(&new)).map_err(am(i))?;
        out.edits.push(Edit::Field { key: rec.key.clone(), field: "bounds".into(), old: Some(old), new: Some(new) });
    }
    Ok(())
}

fn add_element(tx: &mut Tx, ctx: &Ctx, i: usize, add: &AddOp, parent: Option<&Record>, out: &mut Outcome) -> Result<String, Vec<OpError>> {
    let p = ctx.principal;
    let mut errs = vec![];
    // The ID: generated if missing, repaired if it collides.
    let local = match &add.id {
        Some(id) => {
            let bad = id.is_empty() || id.len() > 128 || id.contains('/') || id.chars().any(char::is_whitespace);
            if bad {
                return Err(vec![OpError::new(i, "bad_id", format!("'{id}' is not a valid Element ID."), "Use a short ID of letters, digits, '-' or '_', such as \"n-auth\".")]);
            }
            id.clone()
        }
        None => {
            let id = format!("{}-{}", add.typ, &sha_hex(&[ctx.tag.as_bytes(), &(i as u64).to_le_bytes()])[..6]);
            out.ids.insert(format!("ops[{i}]"), id.clone());
            id
        }
    };
    let scope = |l: &str| match p {
        Principal::Agent(a) => format!("{a}/{l}"),
        Principal::Person(_) => l.to_string(),
    };
    let mut local_final = local.clone();
    if doc::element_obj(tx, &scope(&local)).is_some() {
        if matches!(p, Principal::Person(_)) {
            // A device re-sending a stroke it already committed is a no-op.
            return Ok(scope(&local));
        }
        let mut n = 2;
        while doc::element_obj(tx, &scope(&format!("{local}-{n}"))).is_some() {
            n += 1;
        }
        local_final = format!("{local}-{n}");
        out.repaired.push(format!("ops[{i}]: id '{local}' already existed; used '{local_final}'"));
        out.ids.insert(format!("ops[{i}]"), local_final.clone());
    }
    let key = scope(&local_final);

    let mut fields = BTreeMap::new();
    if let Some(s) = &add.shape {
        fields.insert("shape".to_string(), Value::String(s.clone()).to_string());
    } else if add.typ == "shape" {
        fields.insert("shape".to_string(), "\"rect\"".to_string());
    }
    if let Some(c) = &add.color {
        fields.insert("color".to_string(), Value::String(c.clone()).to_string());
    }
    if let Some(props) = &add.props {
        fields.insert("props".to_string(), props.to_string());
    }
    let mut ends = None;
    if add.typ == "connector" {
        let from = add.from.as_deref().and_then(|r| resolve(tx, p, r).map(|k| (r, k)));
        let to = add.to.as_deref().and_then(|r| resolve(tx, p, r).map(|k| (r, k)));
        if from.is_none() {
            errs.push(unknown_id(tx, p, i, add.from.as_deref().unwrap_or(""), "from"));
        }
        if to.is_none() {
            errs.push(unknown_id(tx, p, i, add.to.as_deref().unwrap_or(""), "to"));
        }
        if let (Some((_, f)), Some((_, t))) = (from, to) {
            fields.insert("ends".to_string(), json!({ "from": f, "to": t }).to_string());
            ends = Some((f, t));
        }
    }

    let size = (add.size.0.unwrap_or_else(|| default_size(add).0).max(1), add.size.1.unwrap_or_else(|| default_size(add).1).max(1));
    let bounds = if add.typ == "ink" {
        let stroke = add.stroke.clone().unwrap_or(Value::Null);
        let b = stroke_bounds(&stroke);
        fields.insert("stroke".to_string(), stroke.to_string());
        fields.insert("origin".to_string(), json!([b[0], b[1]]).to_string());
        b
    } else if let Some((f, t)) = &ends {
        connector_bounds(tx, f, t)
    } else {
        let (x, y) = match &add.at {
            None => (0, 0),
            Some(at @ At::Abs { .. }) => place(at, [0; 4], size),
            Some(at @ At::Rel { target, .. }) => match resolve(tx, p, target).and_then(|k| doc::live_record(tx, &k)) {
                Some(t) => place(at, connector_aware_bounds(tx, &t), size),
                None => {
                    errs.push(unknown_id(tx, p, i, target, "at"));
                    (0, 0)
                }
            },
        };
        [clamp_safe(x), clamp_safe(y), clamp_safe(size.0), clamp_safe(size.1)]
    };
    if let Some(parent) = parent {
        fields.insert("parent".to_string(), Value::String(parent.key.clone()).to_string());
    }
    let data = data_json(&add.data);
    if data_size(&data) > DATA_LIMIT_BYTES {
        errs.push(OpError::new(i, "data_too_large", format!("data is over the {DATA_LIMIT_BYTES}-byte limit."), "Store large values in a file Element and keep a reference in data."));
    }
    if !errs.is_empty() {
        return Err(errs);
    }
    let incarnation = new_incarnation(ctx, &key, i);
    let rec = Record {
        key: key.clone(),
        typ: add.typ.clone(),
        type_version: 1,
        owner: p.clone(),
        order: order_key(ctx.now_ms, &incarnation),
        incarnation,
        bounds,
        text: if has_text(&add.typ) { Some(add.text.clone().unwrap_or_default()) } else { None },
        fields,
        data,
    };
    doc::write_record(tx, &rec).map_err(am(i))?;
    out.edits.push(Edit::Create { snapshot: rec.to_snapshot() });
    Ok(key)
}

/// A connector's box spans the centers of its two ends.
pub fn connector_bounds<R: ReadDoc>(doc: &R, from: &str, to: &str) -> [i64; 4] {
    let c = |k: &str| {
        doc::live_record(doc, k).map(|r| (r.bounds[0] + r.bounds[2] / 2, r.bounds[1] + r.bounds[3] / 2))
    };
    match (c(from), c(to)) {
        (Some((x0, y0)), Some((x1, y1))) => [x0.min(x1), y0.min(y1), (x1 - x0).abs().max(1), (y1 - y0).abs().max(1)],
        _ => [0, 0, 1, 1],
    }
}

pub fn connector_aware_bounds<R: ReadDoc>(doc: &R, rec: &Record) -> [i64; 4] {
    if rec.typ == "connector" {
        if let Some(ends) = rec.field_json("ends") {
            if let (Some(f), Some(t)) = (ends["from"].as_str(), ends["to"].as_str()) {
                return connector_bounds(doc, f, t);
            }
        }
    }
    rec.bounds
}

fn patch_element(tx: &mut Tx, ctx: &Ctx, i: usize, patch: &PatchOp, out: &mut Outcome) -> Result<(), Vec<OpError>> {
    let p = ctx.principal;
    let rec = owned_records(tx, p, i, std::slice::from_ref(&patch.target))?.remove(0);
    let key = rec.key.clone();
    let mut errs = vec![];
    let text_ok = has_text(&rec.typ);
    let mut bounds = rec.bounds;
    let mut field_writes: Vec<(String, Option<String>)> = vec![];
    for (k, v) in &patch.set {
        match k.as_str() {
            "text" if text_ok => match v.as_str() {
                Some(_) => {}
                None => errs.push(OpError::new(i, "bad_value", "set.text must be a string.", "Pass text as a string.")),
            },
            "text" => errs.push(OpError::new(i, "bad_field", format!("'{}' ({}) has no text.", patch.target, rec.typ), "Add a text or note Element next to it instead.")),
            "x" | "y" | "w" | "h" => match crate::ops::as_int(v) {
                Some(n) => {
                    let idx = ["x", "y", "w", "h"].iter().position(|f| f == k).unwrap();
                    bounds[idx] = if idx >= 2 { clamp_safe(n.max(1)) } else { clamp_safe(n) };
                }
                None => errs.push(OpError::new(i, "bad_value", format!("set.{k} must be an integer."), format!("Pass {k} as a whole number."))),
            },
            "color" => field_writes.push(("color".into(), Some(v.to_string()))),
            "shape" if rec.typ == "shape" => match v.as_str() {
                Some(s) if crate::model::SHAPES.contains(&s) => field_writes.push(("shape".into(), Some(v.to_string()))),
                _ => errs.push(OpError::new(i, "bad_value", format!("Unknown shape {v}."), format!("Use one of: {}.", crate::model::SHAPES.join(", ")))),
            },
            "from" | "to" if rec.typ == "connector" => {}
            "props" if !crate::model::BUILTIN_TYPES.contains(&rec.typ.as_str()) => field_writes.push(("props".into(), Some(v.to_string()))),
            other => errs.push(OpError::new(i, "bad_field", format!("'{}' ({}) has no field '{other}'.", patch.target, rec.typ), "Call read_me with the type name to see its fields.")),
        }
    }
    if rec.typ == "ink" && bounds != rec.bounds && (bounds[2] != rec.bounds[2] || bounds[3] != rec.bounds[3]) {
        errs.push(OpError::new(i, "bad_field", "Ink cannot be resized.", "Move it with x and y."));
    }
    // A connector's two ends are one atomic register (ARCHITECTURE §7.1).
    let set_from = patch.set.iter().find(|(k, _)| k == "from").map(|(_, v)| v.clone());
    let set_to = patch.set.iter().find(|(k, _)| k == "to").map(|(_, v)| v.clone());
    if rec.typ == "connector" && (set_from.is_some() || set_to.is_some()) {
        let cur = rec.field_json("ends").unwrap_or(json!({}));
        let mut ends = cur.clone();
        for (name, v) in [("from", set_from), ("to", set_to)] {
            if let Some(v) = v {
                match v.as_str().and_then(|r| resolve(tx, p, r)) {
                    Some(k) => ends[name] = Value::String(k),
                    None => errs.push(unknown_id(tx, p, i, v.as_str().unwrap_or(""), name)),
                }
            }
        }
        field_writes.push(("ends".into(), Some(ends.to_string())));
    }
    for k in &patch.unset {
        field_writes.push((k.clone(), None));
    }
    if (patch.text_insert.is_some() || patch.text_delete.is_some()) && !text_ok {
        errs.push(OpError::new(i, "bad_field", format!("'{}' ({}) has no text.", patch.target, rec.typ), "Add a text or note Element next to it instead."));
    }
    let len16 = rec.text.as_deref().unwrap_or("").encode_utf16().count();
    let after_delete = len16 - patch.text_delete.map(|(_, l)| l).unwrap_or(0).min(len16);
    if let Some((at, _)) = &patch.text_insert {
        if *at > after_delete {
            errs.push(OpError::new(i, "out_of_range", format!("text_insert.at {at} is past the end of the text ({after_delete} UTF-16 units after any delete)."), format!("Use an index from 0 to {after_delete}.")));
        }
    }
    if let Some((at, len)) = &patch.text_delete {
        if at + len > len16 {
            errs.push(OpError::new(i, "out_of_range", format!("text_delete covers {at}..{} but the text has {len16} UTF-16 units.", at + len), format!("Keep at + len at most {len16}.")));
        }
    }
    let mut data = rec.data.clone();
    for (k, v) in &patch.map_put {
        data.insert(k.clone(), v.to_string());
    }
    for k in &patch.map_delete {
        data.remove(k);
    }
    if data_size(&data) > DATA_LIMIT_BYTES {
        errs.push(OpError::new(i, "data_too_large", format!("data would be over the {DATA_LIMIT_BYTES}-byte limit."), "Store large values in a file Element and keep a reference in data."));
    }
    if !errs.is_empty() {
        return Err(errs);
    }

    // Writes.
    if let Some((_, v)) = patch.set.iter().find(|(k, _)| k == "text") {
        let new = v.as_str().unwrap_or("").to_string();
        let old = rec.text.clone().unwrap_or_default();
        if old != new {
            let t = doc::text_obj(tx, &key).map_err(am(i))?.expect("live");
            tx.update_text(&t, &new).map_err(am(i))?;
            out.edits.push(Edit::Text { key: key.clone(), old, new });
        }
    }
    if patch.text_insert.is_some() || patch.text_delete.is_some() {
        let t = doc::text_obj(tx, &key).map_err(am(i))?.expect("live");
        let old = tx.text(&t).map_err(am(i))?;
        if let Some((at, len)) = patch.text_delete {
            tx.splice_text(&t, at, len as isize, "").map_err(am(i))?;
        }
        if let Some((at, s)) = &patch.text_insert {
            // Insert positions count in the text after the delete.
            tx.splice_text(&t, *at, 0, s).map_err(am(i))?;
        }
        let new = tx.text(&t).map_err(am(i))?;
        out.edits.push(Edit::Text { key: key.clone(), old, new });
    }
    write_bounds(tx, &rec, bounds, i, out)?;
    for (field, value) in field_writes {
        let old = field_value(&rec, &field);
        if old != value {
            set_field(tx, &key, &field, value.as_deref()).map_err(am(i))?;
            out.edits.push(Edit::Field { key: key.clone(), field, old, new: value });
        }
    }
    let d = doc::data_obj(tx, &key).map_err(am(i))?.expect("live");
    for (k, v) in &patch.map_put {
        let old = rec.data.get(k).cloned();
        let new = v.to_string();
        tx.put(&d, k.as_str(), new.as_str()).map_err(am(i))?;
        out.edits.push(Edit::Data { key: key.clone(), name: k.clone(), old, new: Some(new) });
    }
    for k in &patch.map_delete {
        if let Some(old) = rec.data.get(k) {
            tx.delete(&d, k.as_str()).map_err(am(i))?;
            out.edits.push(Edit::Data { key: key.clone(), name: k.clone(), old: Some(old.clone()), new: None });
        }
    }
    Ok(())
}

/// Replays one edit for undo or redo. It only takes effect when the Element
/// still holds what the edit expects, and returns whether it did anything.
pub fn replay(tx: &mut Tx, edit: &Edit, ctx: &Ctx, i: usize) -> AmResult<bool> {
    match edit {
        Edit::Create { snapshot } => {
            let Some(mut rec) = Record::from_snapshot(snapshot) else { return Ok(false) };
            if doc::element_obj(tx, &rec.key).is_some() {
                return Ok(false);
            }
            // Restoring creates a new incarnation, so it can never collide with
            // the removal record of the old one (gpt-sol §1.2).
            rec.incarnation = new_incarnation(ctx, &rec.key, i);
            doc::write_record(tx, &rec)?;
            Ok(true)
        }
        Edit::Delete { snapshot } => {
            let key = snapshot.get("key").and_then(|k| k.as_str()).unwrap_or("");
            match doc::live_record(tx, key) {
                Some(rec) => {
                    remove_record(tx, &rec, ctx.principal, ctx.now_ms)?;
                    Ok(true)
                }
                None => Ok(false),
            }
        }
        Edit::Field { key, field, old, new } => {
            let Some(rec) = doc::live_record(tx, key) else { return Ok(false) };
            if &field_value(&rec, field) != old {
                return Ok(false);
            }
            set_field(tx, key, field, new.as_deref())?;
            Ok(true)
        }
        Edit::Text { key, old, new } => {
            let Some(rec) = doc::live_record(tx, key) else { return Ok(false) };
            if rec.text.as_deref().unwrap_or("") != old {
                return Ok(false);
            }
            let t = doc::text_obj(tx, key)?.expect("live");
            tx.update_text(&t, new)?;
            Ok(true)
        }
        Edit::Data { key, name, old, new } => {
            let Some(rec) = doc::live_record(tx, key) else { return Ok(false) };
            if rec.data.get(name) != old.as_ref() {
                return Ok(false);
            }
            let d = doc::data_obj(tx, key)?.expect("live");
            match new {
                Some(v) => tx.put(&d, name.as_str(), v.as_str())?,
                None => tx.delete(&d, name.as_str())?,
            }
            Ok(true)
        }
        Edit::Library { key, old, new } => {
            let library = doc::root(tx, "library");
            if &doc::get_str(tx, &library, key) != old {
                return Ok(false);
            }
            match new {
                Some(v) => tx.put(&library, key.as_str(), v.as_str())?,
                None => tx.delete(&library, key.as_str())?,
            }
            Ok(true)
        }
    }
}
