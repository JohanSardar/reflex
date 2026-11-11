//! Executing ops inside one Automerge transaction.
//!
//! Every write is recorded as an `Edit`. Edits are what undo (per person) and
//! revert (per Agent batch, T8) are planned from. Each edit carries both the old
//! and the new value, and replaying an edit only takes effect when the current
//! value still matches what the edit expects, so one person's undo never
//! clobbers another person's later change.
//!
//! Every typed field of an Element is one register holding its JSON, under its
//! protocol name. The text of text, notes, shapes and connector labels is a
//! collaborative CRDT text. After each write the Element is checked against the
//! protocol's Element schema, so the kernel never stores one it couldn't return.

use crate::doc::{self, sha_hex};
use crate::model::{clamp_safe, has_text, Principal, Record, DATA_LIMIT_BYTES};
use crate::ops::{as_int, element_fields, AddOp, At, Layout, Op, OpError, PatchOp, Rel};
use crate::protocol::Code;
use automerge::transaction::{Transactable, Transaction};
use automerge::{ObjType, ReadDoc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "e", rename_all = "snake_case")]
pub enum Edit {
    Create {
        snapshot: Value,
    },
    Delete {
        snapshot: Value,
    },
    Field {
        key: String,
        field: String,
        old: Option<String>,
        new: Option<String>,
    },
    Text {
        key: String,
        old: String,
        new: String,
    },
    Data {
        key: String,
        name: String,
        old: Option<String>,
        new: Option<String>,
    },
    Library {
        key: String,
        old: Option<String>,
        new: Option<String>,
    },
}

impl Edit {
    pub fn inverse(&self) -> Edit {
        match self.clone() {
            Edit::Create { snapshot } => Edit::Delete { snapshot },
            Edit::Delete { snapshot } => Edit::Create { snapshot },
            Edit::Field {
                key,
                field,
                old,
                new,
            } => Edit::Field {
                key,
                field,
                old: new,
                new: old,
            },
            Edit::Text { key, old, new } => Edit::Text {
                key,
                old: new,
                new: old,
            },
            Edit::Data {
                key,
                name,
                old,
                new,
            } => Edit::Data {
                key,
                name,
                old: new,
                new: old,
            },
            Edit::Library { key, old, new } => Edit::Library {
                key,
                old: new,
                new: old,
            },
        }
    }

    pub fn key(&self) -> String {
        match self {
            Edit::Create { snapshot } | Edit::Delete { snapshot } => snapshot
                .get("key")
                .and_then(|k| k.as_str())
                .unwrap_or("")
                .to_string(),
            Edit::Field { key, .. }
            | Edit::Text { key, .. }
            | Edit::Data { key, .. }
            | Edit::Library { key, .. } => key.clone(),
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
/// Agents' own IDs are scoped to them (stored as `<agent>/<id>`). Other
/// Agents' Elements are shown as `<agent>:<id>`, because `/` is not in the
/// protocol's ID alphabet; both forms resolve.
pub fn resolve<R: ReadDoc>(doc: &R, p: &Principal, r: &str) -> Option<String> {
    if let Principal::Agent(a) = p {
        if !r.contains('/') {
            let own = format!("{a}/{r}");
            if doc::live_record(doc, &own).is_some() {
                return Some(own);
            }
        }
    }
    if doc::live_record(doc, r).is_some() {
        return Some(r.to_string());
    }
    let (agent, local) = r.split_once(':')?;
    let key = format!("{agent}/{local}");
    doc::live_record(doc, &key).map(|_| key)
}

/// The ID a principal sees for a key: Agents see their own Elements by local
/// ID, and everyone sees other Agents' Elements as `<agent>:<id>`.
pub fn display_id(viewer: Option<&Principal>, key: &str) -> String {
    if let Some(Principal::Agent(a)) = viewer {
        if let Some(local) = key.strip_prefix(&format!("{a}/")) {
            return local.to_string();
        }
    }
    key.replacen('/', ":", 1)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != *cb))
                .min(prev[j + 1] + 1)
                .min(cur[j] + 1);
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
    let e = match best {
        Some((_, id)) => OpError::new(
            i,
            Code::UnknownId,
            format!("No Element '{r}'. Closest: '{id}'."),
            format!("Set {field} to '{id}'."),
        ),
        None => OpError::new(
            i,
            Code::UnknownId,
            format!("No Element '{r}'."),
            "Call read to see the Element IDs in this Space.",
        ),
    };
    e.at(&format!("/{}", field.replace('.', "/")))
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
                Code::NotYours,
                format!("'{shown}' is {whose}. Agents can only change their own Elements."),
                format!("Add a note next to it instead: {{\"op\": \"add\", \"type\": \"note\", \"text\": \"...\", \"at\": {{\"near\": \"{shown}\"}}}}."),
            ))
        }
        Principal::Person(_) if rec.typ == "ink" && &rec.owner != p => Err(OpError::new(
            i,
            Code::NotYours,
            format!("'{shown}' is another person's Ink."),
            "Only the person who drew a stroke can change or erase it.",
        )),
        _ => Ok(()),
    }
}

fn utf16_len(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}

fn default_size(typ: &str, text: &str, fields: &BTreeMap<String, Value>) -> (i64, i64) {
    let longest = text.lines().map(utf16_len).max().unwrap_or(0);
    let lines = text.lines().count().max(1) as i64;
    match typ {
        "shape" => ((longest * 10 + 40).max(160), (lines * 24 + 32).max(80)),
        "note" => (200, (lines * 24 + 48).max(120)),
        "text" => {
            let scale = match fields.get("size").and_then(Value::as_str) {
                Some("s") => 8,
                Some("l") => 14,
                Some("xl") => 20,
                _ => 10,
            };
            ((longest * scale).max(40), lines * scale * 12 / 5)
        }
        "math" => {
            let latex = fields.get("latex").and_then(Value::as_str).unwrap_or("");
            ((utf16_len(latex) * 11).max(40), 48)
        }
        "image" => (320, 240),
        "frame" => (480, 320),
        "region" => (600, 400),
        "embed" => (480, 320),
        _ => (200, 120),
    }
}

fn stroke_bounds(stroke: &Value) -> [i64; 4] {
    let pts: Vec<(f64, f64)> = stroke
        .get("points")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .map(|p| (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)))
                .collect()
        })
        .unwrap_or_default();
    let w = stroke.get("width").and_then(|w| w.as_f64()).unwrap_or(2.0);
    poly_bounds(&pts, (w / 2.0).ceil())
}

fn poly_bounds(pts: &[(f64, f64)], pad: f64) -> [i64; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (x, y) in pts {
        x0 = x0.min(*x);
        y0 = y0.min(*y);
        x1 = x1.max(*x);
        y1 = y1.max(*y);
    }
    if pts.is_empty() {
        return [0, 0, 1, 1];
    }
    [
        clamp_safe((x0 - pad).floor() as i64),
        clamp_safe((y0 - pad).floor() as i64),
        clamp_safe(((x1 - x0 + 2.0 * pad).ceil() as i64).max(1)),
        clamp_safe(((y1 - y0 + 2.0 * pad).ceil() as i64).max(1)),
    ]
}

fn points_bounds(points: &Value) -> [i64; 4] {
    let pts: Vec<(f64, f64)> = points
        .as_array()
        .map(|a| {
            a.iter()
                .map(|p| (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)))
                .collect()
        })
        .unwrap_or_default();
    poly_bounds(&pts, 0.0)
}

/// Where something of `size` goes, relative to `target`'s bounds.
fn place(at: &At, target: [i64; 4], size: (i64, i64)) -> (i64, i64) {
    let [x, y, w, h] = target;
    match at {
        At::Abs { x, y } => (*x, *y),
        At::Rel { rel, gap, .. } => {
            let gap = gap.unwrap_or(if *rel == Rel::Inside { 24 } else { 40 });
            match rel {
                Rel::RightOf | Rel::Near => (x + w + gap, y),
                Rel::LeftOf => (x - gap - size.0, y),
                Rel::Below => (x, y + h + gap),
                Rel::Above => (x, y - gap - size.1),
                Rel::Inside => (x + gap, y + gap),
            }
        }
    }
}

/// Resolves a placement to a top-left corner.
fn position(
    tx: &Tx,
    p: &Principal,
    i: usize,
    at: &At,
    size: (i64, i64),
    field: &str,
) -> Result<(i64, i64), OpError> {
    match at {
        At::Abs { .. } => Ok(place(at, [0; 4], size)),
        At::Rel { target, .. } => {
            match resolve(tx, p, target).and_then(|k| doc::live_record(tx, &k)) {
                Some(t) => Ok(place(at, connector_aware_bounds(tx, &t), size)),
                None => Err(unknown_id(tx, p, i, target, field)),
            }
        }
    }
}

fn overlaps(a: [i64; 4], b: [i64; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

/// Agents may not write inside a Region marked agents_read_only (SPEC §9).
fn check_region(tx: &Tx, p: &Principal, i: usize, key: &str, b: [i64; 4]) -> Result<(), OpError> {
    if !matches!(p, Principal::Agent(_)) {
        return Ok(());
    }
    let hit = doc::live_records(tx).into_iter().find(|r| {
        r.typ == "region"
            && r.key != key
            && r.field_json("agents_read_only") == Some(Value::Bool(true))
            && overlaps(r.bounds, b)
    });
    match hit {
        None => Ok(()),
        Some(r) => {
            let rid = display_id(Some(p), &r.key);
            Err(OpError::new(
                i,
                Code::RegionReadOnly,
                format!(
                    "'{}' would be inside Region '{rid}', where Agents can't write.",
                    display_id(Some(p), key)
                ),
                format!(
                    "Place it outside the Region, for example at: {{\"right_of\": \"{rid}\"}}."
                ),
            ))
        }
    }
}

fn data_json(data: &BTreeMap<String, Value>) -> BTreeMap<String, String> {
    data.iter()
        .map(|(k, v)| (k.clone(), v.to_string()))
        .collect()
}

fn data_size(data: &BTreeMap<String, String>) -> usize {
    data.iter().map(|(k, v)| k.len() + v.len() + 4).sum()
}

fn new_incarnation(ctx: &Ctx, key: &str, i: usize) -> String {
    match ctx.principal {
        // Agent requests are idempotent (ARCHITECTURE §7.3): the same request
        // accepted on two paths yields the same incarnation.
        Principal::Agent(_) => sha_hex(&[
            ctx.tag.as_bytes(),
            key.as_bytes(),
            &(i as u64).to_le_bytes(),
        ])[..16]
            .to_string(),
        Principal::Person(_) => sha_hex(&[
            ctx.actor_hex.as_bytes(),
            ctx.tag.as_bytes(),
            key.as_bytes(),
            &(i as u64).to_le_bytes(),
        ])[..16]
            .to_string(),
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
    let Some(el) = doc::element_obj(tx, key) else {
        return Ok(());
    };
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
pub fn run(
    tx: &mut Tx,
    ctx: &Ctx,
    ops: &[Option<Op>],
    parse_errs: Vec<OpError>,
) -> Result<Outcome, Vec<OpError>> {
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
    move |e| {
        vec![OpError::new(
            i,
            Code::Internal,
            format!("Kernel write failed: {e}"),
            "Retry; report this if it repeats.",
        )]
    }
}

fn run_op(
    tx: &mut Tx,
    ctx: &Ctx,
    i: usize,
    op: &Op,
    out: &mut Outcome,
) -> Result<(), Vec<OpError>> {
    let p = ctx.principal;
    match op {
        Op::Add(add) => {
            add_element(tx, ctx, i, add, None, out)?;
        }
        Op::Patch(patch) => patch_element(tx, ctx, i, patch, out)?,
        Op::Remove { refs } => {
            let recs = owned_records(tx, p, i, refs, "ids")?;
            for rec in recs {
                remove_record(tx, &rec, p, ctx.now_ms).map_err(am(i))?;
                out.edits.push(Edit::Delete {
                    snapshot: rec.to_snapshot(),
                });
            }
        }
        Op::Move { refs, by } => {
            let recs = owned_records(tx, p, i, refs, "ids")?;
            for rec in recs {
                let mut b = rec.bounds;
                b[0] = clamp_safe(b[0] + by[0]);
                b[1] = clamp_safe(b[1] + by[1]);
                write_bounds(tx, p, &rec, b, i, out)?;
            }
        }
        Op::Arrange {
            refs,
            layout,
            gap,
            columns,
            align,
            at,
        } => arrange(
            tx,
            p,
            i,
            refs,
            *layout,
            *gap,
            *columns,
            align.as_deref(),
            at.as_ref(),
            out,
        )?,
        Op::Focus { value } => {
            let Principal::Agent(a) = p else {
                return Err(vec![OpError::new(
                    i,
                    Code::InvalidInput,
                    "focus is an Agent op.",
                    "People move their own viewport on the device.",
                )]);
            };
            // One register per Agent, so two paths writing focus never create
            // competing containers.
            let agents = doc::root(tx, "agents");
            tx.put(&agents, a.as_str(), json!({ "focus": value }).to_string())
                .map_err(am(i))?;
        }
        Op::Define { kind, name, entry } => {
            if ctx.space_kind != "library" {
                return Err(vec![OpError::new(
                    i,
                    Code::InvalidInput,
                    "define saves to the Library, and this Space is not the Library.",
                    "Send define ops to the Space of kind \"library\".",
                )]);
            }
            let key = format!("{kind}:{name}");
            let library = doc::root(tx, "library");
            let old = doc::get_str(tx, &library, &key);
            let mut e = entry.clone();
            e["by"] = p.to_json();
            let entry = e.to_string();
            tx.put(&library, key.as_str(), entry.as_str())
                .map_err(am(i))?;
            out.edits.push(Edit::Library {
                key,
                old,
                new: Some(entry),
            });
        }
        Op::ErasePrecise { target, fragments } => {
            let rec = owned_records(tx, p, i, std::slice::from_ref(target), "id")?.remove(0);
            if rec.typ != "ink" {
                return Err(vec![OpError::new(
                    i,
                    Code::InvalidInput,
                    format!("'{target}' is not Ink."),
                    "Use erase for Elements that are not Ink.",
                )]);
            }
            remove_record(tx, &rec, p, ctx.now_ms).map_err(am(i))?;
            out.edits.push(Edit::Delete {
                snapshot: rec.to_snapshot(),
            });
            for f in fragments {
                add_element(tx, ctx, i, f, Some(&rec), out)?;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn arrange(
    tx: &mut Tx,
    p: &Principal,
    i: usize,
    refs: &[String],
    layout: Layout,
    gap: i64,
    columns: Option<i64>,
    align: Option<&str>,
    at: Option<&At>,
    out: &mut Outcome,
) -> Result<(), Vec<OpError>> {
    let recs = owned_records(tx, p, i, refs, "ids")?;
    let first = recs[0].bounds;
    let (bx, by) = match at {
        None => (first[0], first[1]),
        Some(at) => position(tx, p, i, at, (first[2], first[3]), "at").map_err(|e| vec![e])?,
    };
    let maxw = recs.iter().map(|r| r.bounds[2]).max().unwrap_or(0);
    let maxh = recs.iter().map(|r| r.bounds[3]).max().unwrap_or(0);
    let off = |room: i64| match align {
        Some("middle") => room / 2,
        Some("end") => room,
        _ => 0,
    };
    let n = recs.len() as i64;
    // Tree: levels follow the connectors between the arranged Elements.
    let mut level = vec![0i64; recs.len()];
    if layout == Layout::Tree {
        let index: BTreeMap<&str, usize> = recs
            .iter()
            .enumerate()
            .map(|(j, r)| (r.key.as_str(), j))
            .collect();
        let edges: Vec<(usize, usize)> = doc::live_records(tx)
            .iter()
            .filter(|r| r.typ == "connector")
            .filter_map(|r| r.field_json("ends"))
            .filter_map(|e| {
                let f = *index.get(e["from"].as_str()?)?;
                let t = *index.get(e["to"].as_str()?)?;
                Some((f, t))
            })
            .collect();
        let mut seen = vec![false; recs.len()];
        let mut queue: Vec<usize> = (0..recs.len())
            .filter(|j| !edges.iter().any(|(_, t)| t == j))
            .collect();
        if queue.is_empty() {
            queue.push(0);
        }
        for &r in &queue {
            seen[r] = true;
        }
        let mut qi = 0;
        while qi < queue.len() {
            let u = queue[qi];
            qi += 1;
            for &(f, t) in &edges {
                if f == u && !seen[t] {
                    seen[t] = true;
                    level[t] = level[u] + 1;
                    queue.push(t);
                }
            }
        }
    }
    let cols = columns
        .unwrap_or_else(|| (n as f64).sqrt().ceil() as i64)
        .max(1);
    let mut cursor = BTreeMap::<i64, i64>::new();
    let (mut x, mut y) = (bx, by);
    for (j, rec) in recs.iter().enumerate() {
        let [_, _, w, h] = rec.bounds;
        let (nx, ny) = match layout {
            Layout::Row => {
                let pos = (x, by + off(maxh - h));
                x = clamp_safe(x + w + gap);
                pos
            }
            Layout::Column => {
                let pos = (bx + off(maxw - w), y);
                y = clamp_safe(y + h + gap);
                pos
            }
            Layout::Grid => {
                let (c, r) = (j as i64 % cols, j as i64 / cols);
                (
                    bx + c * (maxw + gap) + off(maxw - w),
                    by + r * (maxh + gap) + off(maxh - h),
                )
            }
            Layout::Tree => {
                let lx = cursor.entry(level[j]).or_insert(bx);
                let pos = (*lx, by + level[j] * (maxh + gap));
                *lx = clamp_safe(*lx + w + gap);
                pos
            }
        };
        write_bounds(tx, p, rec, [clamp_safe(nx), clamp_safe(ny), w, h], i, out)?;
    }
    Ok(())
}

fn owned_records(
    tx: &Tx,
    p: &Principal,
    i: usize,
    refs: &[String],
    field: &str,
) -> Result<Vec<Record>, Vec<OpError>> {
    let mut errs = vec![];
    let mut recs = vec![];
    for r in refs {
        match resolve(tx, p, r).and_then(|k| doc::live_record(tx, &k)) {
            None => errs.push(unknown_id(tx, p, i, r, field)),
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

fn write_bounds(
    tx: &mut Tx,
    p: &Principal,
    rec: &Record,
    b: [i64; 4],
    i: usize,
    out: &mut Outcome,
) -> Result<(), Vec<OpError>> {
    let old = doc::bounds_json(&rec.bounds);
    let new = doc::bounds_json(&b);
    if old != new {
        if rec.typ != "connector" {
            check_region(tx, p, i, &rec.key, b).map_err(|e| vec![e])?;
        }
        set_field(tx, &rec.key, "bounds", Some(&new)).map_err(am(i))?;
        out.edits.push(Edit::Field {
            key: rec.key.clone(),
            field: "bounds".into(),
            old: Some(old),
            new: Some(new),
        });
    }
    Ok(())
}

/// After a write, the Element must still be a valid protocol Element.
fn check_valid(tx: &Tx, i: usize, key: &str) -> Result<(), Vec<OpError>> {
    let Some(rec) = doc::live_record(tx, key) else {
        return Ok(());
    };
    let v = crate::scene::element_value(tx, &rec, None, &BTreeMap::new());
    match crate::protocol::Element::parse(&v) {
        Ok(_) => Ok(()),
        Err(e) => Err(vec![OpError::new(
            i,
            Code::InvalidInput,
            format!(
                "ops[{i}] would leave '{}' invalid: {e}.",
                display_id(None, key)
            ),
            "Keep the fields its type requires; read_me with the type name lists them.",
        )]),
    }
}

fn add_element(
    tx: &mut Tx,
    ctx: &Ctx,
    i: usize,
    add: &AddOp,
    parent: Option<&Record>,
    out: &mut Outcome,
) -> Result<String, Vec<OpError>> {
    let p = ctx.principal;
    let mut errs = vec![];
    // The ID: generated if missing, repaired if it collides.
    let local = match &add.id {
        Some(id) => {
            let bad = id.is_empty()
                || id.len() > 128
                || id.contains('/')
                || id.chars().any(char::is_whitespace);
            if bad {
                return Err(vec![OpError::new(
                    i,
                    Code::InvalidInput,
                    format!("'{id}' is not a valid Element ID."),
                    "Use a short ID of letters, digits, '-' or '_', such as \"n-auth\".",
                )
                .at("/id")]);
            }
            id.clone()
        }
        None => {
            let id = format!(
                "{}-{}",
                add.typ,
                &sha_hex(&[ctx.tag.as_bytes(), &(i as u64).to_le_bytes()])[..6]
            );
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
        out.repaired.push(format!(
            "ops[{i}]: id '{local}' already existed; used '{local_final}'"
        ));
        out.ids.insert(format!("ops[{i}]"), local_final.clone());
    }
    let key = scope(&local_final);

    let mut fields: BTreeMap<String, String> = add
        .fields
        .iter()
        .map(|(k, v)| (k.clone(), v.to_string()))
        .collect();
    let mut ends = None;
    if add.typ == "connector" {
        match (&add.from, &add.to) {
            (Some(fr), Some(to)) => {
                let f = resolve(tx, p, fr);
                let t = resolve(tx, p, to);
                if f.is_none() {
                    errs.push(unknown_id(tx, p, i, fr, "from"));
                }
                if t.is_none() {
                    errs.push(unknown_id(tx, p, i, to, "to"));
                }
                if let (Some(f), Some(t)) = (f, t) {
                    fields.insert(
                        "ends".to_string(),
                        json!({ "from": f, "to": t }).to_string(),
                    );
                    ends = Some((f, t));
                }
            }
            (None, None) if add.fields.contains_key("points") => {}
            _ => errs.push(OpError::new(
                i,
                Code::InvalidInput,
                format!("ops[{i}]: a connector needs both from and to, or points."),
                "Add \"from\": \"n-a\", \"to\": \"n-b\", or \"points\": [[0, 0], [100, 0]].",
            )),
        }
    }

    let text = add.text.clone().unwrap_or_default();
    let dflt = default_size(&add.typ, &text, &add.fields);
    let size = (
        add.size.0.unwrap_or(dflt.0).max(1),
        add.size.1.unwrap_or(dflt.1).max(1),
    );
    let bounds = if add.typ == "ink" {
        let stroke = add.fields.get("stroke").cloned().unwrap_or(Value::Null);
        let b = stroke_bounds(&stroke);
        fields.insert("origin".to_string(), json!([b[0], b[1]]).to_string());
        b
    } else if let Some((f, t)) = &ends {
        connector_bounds(tx, f, t)
    } else if let (true, Some(pts)) = (add.typ == "connector", add.fields.get("points")) {
        points_bounds(pts)
    } else {
        let (x, y) = match &add.at {
            None => (0, 0),
            Some(at) => match position(tx, p, i, at, size, "at") {
                Ok(xy) => xy,
                Err(e) => {
                    errs.push(e);
                    (0, 0)
                }
            },
        };
        [
            clamp_safe(x),
            clamp_safe(y),
            clamp_safe(size.0),
            clamp_safe(size.1),
        ]
    };
    if add.typ != "connector" && add.typ != "ink" {
        if let Err(e) = check_region(tx, p, i, &key, bounds) {
            errs.push(e);
        }
    }
    if let Some(parent) = parent {
        fields.insert(
            "parent".to_string(),
            Value::String(parent.key.clone()).to_string(),
        );
    }
    let data = data_json(&add.data);
    if data_size(&data) > DATA_LIMIT_BYTES {
        errs.push(OpError::new(
            i,
            Code::TooLarge,
            format!("data is over the {DATA_LIMIT_BYTES}-byte limit."),
            "Store large values in a file Element and keep a reference in data.",
        ));
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
        text: if has_text(&add.typ) { Some(text) } else { None },
        fields,
        data,
    };
    doc::write_record(tx, &rec).map_err(am(i))?;
    check_valid(tx, i, &key)?;
    out.edits.push(Edit::Create {
        snapshot: rec.to_snapshot(),
    });
    Ok(key)
}

/// A connector's box spans the centers of its two ends.
pub fn connector_bounds<R: ReadDoc>(doc: &R, from: &str, to: &str) -> [i64; 4] {
    let c = |k: &str| {
        doc::live_record(doc, k)
            .map(|r| (r.bounds[0] + r.bounds[2] / 2, r.bounds[1] + r.bounds[3] / 2))
    };
    match (c(from), c(to)) {
        (Some((x0, y0)), Some((x1, y1))) => [
            x0.min(x1),
            y0.min(y1),
            (x1 - x0).abs().max(1),
            (y1 - y0).abs().max(1),
        ],
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

/// Splices a string in UTF-16 code units, as every text range in the protocol is.
fn splice16(s: &str, at: usize, del: usize, ins: &str) -> Option<String> {
    let mut u: Vec<u16> = s.encode_utf16().collect();
    if at + del > u.len() {
        return None;
    }
    u.splice(at..at + del, ins.encode_utf16());
    String::from_utf16(&u).ok()
}

fn patch_element(
    tx: &mut Tx,
    ctx: &Ctx,
    i: usize,
    patch: &PatchOp,
    out: &mut Outcome,
) -> Result<(), Vec<OpError>> {
    let p = ctx.principal;
    let rec = owned_records(tx, p, i, std::slice::from_ref(&patch.target), "id")?.remove(0);
    let key = rec.key.clone();
    let shown = patch.target.as_str();
    let typ = rec.typ.as_str();
    let allowed = element_fields(typ);
    let mut errs = vec![];
    let no_field = |k: &str, path: &str| {
        OpError::new(
            i,
            Code::InvalidInput,
            format!("'{shown}' ({typ}) has no field '{k}'."),
            format!(
                "Fields for {typ}: {}.",
                allowed
                    .iter()
                    .filter(|f| !["id", "type", "owner", "bounds", "type_version"].contains(f))
                    .copied()
                    .chain(["at", "w", "h"])
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .at(path)
    };
    let field_ok = |k: &str| allowed.contains(&k) || ["at", "w", "h"].contains(&k);

    // Pending register values, starting from what is stored.
    let mut regs: BTreeMap<String, Option<Value>> = BTreeMap::new();
    let reg = |regs: &BTreeMap<String, Option<Value>>, name: &str| -> Option<Value> {
        match regs.get(name) {
            Some(v) => v.clone(),
            None => rec.field_json(name),
        }
    };
    let mut bounds = rec.bounds;
    let mut text: Option<String> = None; // a whole-text replacement
    let mut data = rec.data.clone();
    let mut place_at: Option<At> = None;
    let mut ends: Option<Value> = None;
    let mut default_w = false;
    let mut default_h = false;

    for (k, v) in &patch.set {
        if !field_ok(k) {
            errs.push(no_field(k, &format!("/set/{k}")));
            continue;
        }
        match k.as_str() {
            "text" if has_text(typ) => text = v.as_str().map(String::from),
            "at" => match serde_json::from_value::<crate::protocol::Placement>(v.clone())
                .map_err(|e| OpError::new(i, Code::InvalidPlacement, e.to_string(), "Fix set.at."))
                .and_then(|pl| crate::ops::placement(i, &pl, "set.at"))
            {
                Ok(at) => place_at = Some(at),
                Err(e) => errs.push(e),
            },
            "w" => bounds[2] = clamp_safe(as_int(v).unwrap_or(1).max(1)),
            "h" => bounds[3] = clamp_safe(as_int(v).unwrap_or(1).max(1)),
            "from" | "to" if typ == "connector" => {
                let mut e = ends
                    .clone()
                    .or_else(|| rec.field_json("ends"))
                    .unwrap_or(json!({}));
                match v.as_str().and_then(|r| resolve(tx, p, r)) {
                    Some(target) => e[k.as_str()] = Value::String(target),
                    None => errs.push(unknown_id(
                        tx,
                        p,
                        i,
                        v.as_str().unwrap_or(""),
                        &format!("set.{k}"),
                    )),
                }
                ends = Some(e);
            }
            "data" => {
                data = v
                    .as_object()
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v.to_string())).collect())
                    .unwrap_or_default();
            }
            _ => {
                regs.insert(k.clone(), Some(v.clone()));
            }
        }
    }
    for k in &patch.unset {
        if !field_ok(k) {
            errs.push(no_field(k, "/unset"));
            continue;
        }
        match k.as_str() {
            "text" if has_text(typ) => text = Some(String::new()),
            "data" => data.clear(),
            "w" => default_w = true,
            "h" => default_h = true,
            "from" | "to" => errs.push(
                OpError::new(
                    i,
                    Code::InvalidInput,
                    "A connector's ends can be changed with set, not unset.",
                    "Use set: {\"from\": \"n-1\"}, or remove the connector.",
                )
                .at("/unset"),
            ),
            _ => {
                regs.insert(k.clone(), None);
            }
        }
    }
    if let Some(e) = ends {
        if e.get("from").is_some() && e.get("to").is_some() {
            regs.insert("ends".into(), Some(e));
        } else {
            errs.push(OpError::new(
                i,
                Code::InvalidInput,
                format!("'{shown}' is a free line; binding it needs both from and to."),
                "Set both from and to.",
            ));
        }
    }

    // Text edits: deletes first, then inserts, each against the text as it is by then.
    let mut new_text = text
        .clone()
        .or_else(|| rec.text.clone())
        .unwrap_or_default();
    let mut text_splices: Vec<(usize, usize, String)> = vec![];
    let mut text_edits: Vec<(&str, usize, usize, &str)> = patch
        .text_delete
        .iter()
        .map(|(f, at, len)| (f.as_str(), *at, *len, ""))
        .collect();
    text_edits.extend(
        patch
            .text_insert
            .iter()
            .map(|(f, at, s)| (f.as_str(), *at, 0, s.as_str())),
    );
    for (f, at, len, ins) in text_edits {
        if !allowed.contains(&f) {
            errs.push(no_field(f, "/text_insert"));
            continue;
        }
        let collaborative = f == "text" && has_text(typ);
        let cur = if collaborative {
            new_text.clone()
        } else {
            reg(&regs, f)
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default()
        };
        match splice16(&cur, at, len, ins) {
            Some(next) => {
                if collaborative {
                    new_text = next;
                    text_splices.push((at, len, ins.to_string()));
                } else {
                    regs.insert(f.to_string(), Some(Value::String(next)));
                }
            }
            None => errs.push(OpError::new(
                i,
                Code::InvalidInput,
                format!(
                    "{f}: {at}..{} is outside the text ({} UTF-16 units).",
                    at + len,
                    utf16_len(&cur)
                ),
                format!("Keep at + len at most {}.", utf16_len(&cur)),
            )),
        }
    }

    // List edits on behaviors, points and allow.
    let list = |regs: &mut BTreeMap<String, Option<Value>>,
                f: &str,
                edit: &dyn Fn(&mut Vec<Value>) -> bool,
                errs: &mut Vec<OpError>| {
        if !allowed.contains(&f) {
            errs.push(no_field(f, "/list"));
            return;
        }
        let mut a = reg(regs, f)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        if edit(&mut a) {
            regs.insert(f.to_string(), Some(Value::Array(a)));
        } else {
            errs.push(OpError::new(
                i,
                Code::InvalidInput,
                format!("{f}: index out of range."),
                format!("Read '{shown}' with detail: \"full\" to see the list."),
            ));
        }
    };
    for (f, idx, v) in &patch.list_insert {
        list(
            &mut regs,
            f,
            &|a| {
                (*idx <= a.len())
                    .then(|| a.insert(*idx, v.clone()))
                    .is_some()
            },
            &mut errs,
        );
    }
    for (f, from, to) in &patch.list_move {
        list(
            &mut regs,
            f,
            &|a| {
                if *from < a.len() && *to < a.len() {
                    let x = a.remove(*from);
                    a.insert(*to, x);
                    true
                } else {
                    false
                }
            },
            &mut errs,
        );
    }
    for (f, idx) in &patch.list_remove {
        list(
            &mut regs,
            f,
            &|a| (*idx < a.len()).then(|| a.remove(*idx)).is_some(),
            &mut errs,
        );
    }

    // Map edits: data is a CRDT map; props and params are registers.
    for (f, k, v) in &patch.map_put {
        if f == "data" {
            data.insert(k.clone(), v.to_string());
        } else if allowed.contains(&f.as_str()) {
            let mut m = reg(&regs, f)
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            m.insert(k.clone(), v.clone());
            regs.insert(f.clone(), Some(Value::Object(m)));
        } else {
            errs.push(no_field(f, "/map_put"));
        }
    }
    for (f, k) in &patch.map_delete {
        if f == "data" {
            data.remove(k);
        } else if allowed.contains(&f.as_str()) {
            let mut m = reg(&regs, f)
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            m.remove(k);
            regs.insert(f.clone(), Some(Value::Object(m)));
        } else {
            errs.push(no_field(f, "/map_delete"));
        }
    }

    // Geometry.
    if default_w || default_h {
        let fields: BTreeMap<String, Value> = rec
            .fields
            .keys()
            .filter_map(|k| reg(&regs, k).map(|v| (k.clone(), v)))
            .collect();
        let d = default_size(typ, &new_text, &fields);
        if default_w {
            bounds[2] = d.0;
        }
        if default_h {
            bounds[3] = d.1;
        }
    }
    if typ == "ink" && (bounds[2] != rec.bounds[2] || bounds[3] != rec.bounds[3]) {
        errs.push(OpError::new(
            i,
            Code::InvalidInput,
            "Ink cannot be resized.",
            "Move it with at.",
        ));
    }
    if let Some(at) = &place_at {
        match position(tx, p, i, at, (bounds[2], bounds[3]), "set.at") {
            Ok((x, y)) => {
                bounds[0] = clamp_safe(x);
                bounds[1] = clamp_safe(y);
            }
            Err(e) => errs.push(e),
        }
    }
    if typ == "connector" && reg(&regs, "ends").is_none() {
        if let Some(Some(pts)) = regs.get("points") {
            bounds = points_bounds(pts);
        }
    }
    if data_size(&data) > DATA_LIMIT_BYTES {
        errs.push(OpError::new(
            i,
            Code::TooLarge,
            format!("data would be over the {DATA_LIMIT_BYTES}-byte limit."),
            "Store large values in a file Element and keep a reference in data.",
        ));
    }
    if !errs.is_empty() {
        return Err(errs);
    }

    // Writes.
    if has_text(typ) {
        let old = rec.text.clone().unwrap_or_default();
        if let Some(t) = &text {
            if *t != old {
                let obj = doc::text_obj(tx, &key).map_err(am(i))?.expect("live");
                tx.update_text(&obj, t).map_err(am(i))?;
            }
        }
        if !text_splices.is_empty() {
            let obj = doc::text_obj(tx, &key).map_err(am(i))?.expect("live");
            for (at, len, ins) in &text_splices {
                tx.splice_text(&obj, *at, *len as isize, ins)
                    .map_err(am(i))?;
            }
        }
        let obj = doc::text_obj(tx, &key).map_err(am(i))?.expect("live");
        let now = tx.text(&obj).map_err(am(i))?;
        if now != old {
            out.edits.push(Edit::Text {
                key: key.clone(),
                old,
                new: now,
            });
        }
    }
    write_bounds(tx, p, &rec, bounds, i, out)?;
    for (field, value) in regs {
        let old = field_value(&rec, &field);
        let new = value.map(|v| v.to_string());
        if old != new {
            set_field(tx, &key, &field, new.as_deref()).map_err(am(i))?;
            out.edits.push(Edit::Field {
                key: key.clone(),
                field,
                old,
                new,
            });
        }
    }
    let d = doc::data_obj(tx, &key).map_err(am(i))?.expect("live");
    let names: std::collections::BTreeSet<&String> = rec.data.keys().chain(data.keys()).collect();
    for k in names {
        let old = rec.data.get(k).cloned();
        let new = data.get(k).cloned();
        if old == new {
            continue;
        }
        match &new {
            Some(v) => tx.put(&d, k.as_str(), v.as_str()).map_err(am(i))?,
            None => tx.delete(&d, k.as_str()).map_err(am(i))?,
        }
        out.edits.push(Edit::Data {
            key: key.clone(),
            name: k.clone(),
            old,
            new,
        });
    }
    check_valid(tx, i, &key)
}

/// Replays one edit for undo or redo. It only takes effect when the Element
/// still holds what the edit expects, and returns whether it did anything.
pub fn replay(tx: &mut Tx, edit: &Edit, ctx: &Ctx, i: usize) -> AmResult<bool> {
    match edit {
        Edit::Create { snapshot } => {
            let Some(mut rec) = Record::from_snapshot(snapshot) else {
                return Ok(false);
            };
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
        Edit::Field {
            key,
            field,
            old,
            new,
        } => {
            let Some(rec) = doc::live_record(tx, key) else {
                return Ok(false);
            };
            if &field_value(&rec, field) != old {
                return Ok(false);
            }
            set_field(tx, key, field, new.as_deref())?;
            Ok(true)
        }
        Edit::Text { key, old, new } => {
            let Some(rec) = doc::live_record(tx, key) else {
                return Ok(false);
            };
            if rec.text.as_deref().unwrap_or("") != old {
                return Ok(false);
            }
            let t = doc::text_obj(tx, key)?.expect("live");
            tx.update_text(&t, new)?;
            Ok(true)
        }
        Edit::Data {
            key,
            name,
            old,
            new,
        } => {
            let Some(rec) = doc::live_record(tx, key) else {
                return Ok(false);
            };
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
