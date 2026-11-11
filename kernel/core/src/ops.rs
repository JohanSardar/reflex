//! Parsing `apply` batches and user intents into the kernel's internal ops.
//!
//! Agent ops are parsed through the protocol types generated from
//! `protocol/schema/apply.input.schema.json` (see `protocol.rs`), so the kernel
//! accepts exactly the shapes in the protocol. Each op is parsed on its own, so
//! every failing op is reported, each with a `fix`.
//!
//! User intents come from devices (the iPad), not from Agents. They are the
//! kernel's own API: a finished stroke, a move, an erase. Adds and patches from
//! a device use the protocol's op shapes too.

use crate::model::has_text;
use crate::protocol::{self as p, Code, UnionError};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct OpError {
    pub op: usize,
    /// A JSON Pointer into the op, such as `/from`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub code: Code,
    pub msg: String,
    pub fix: String,
}

impl OpError {
    pub fn new(op: usize, code: Code, msg: impl Into<String>, fix: impl Into<String>) -> Self {
        OpError {
            op,
            field: None,
            code,
            msg: msg.into(),
            fix: fix.into(),
        }
    }

    pub fn at(mut self, field: &str) -> Self {
        self.field = Some(field.to_string());
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rel {
    RightOf,
    LeftOf,
    Below,
    Above,
    Near,
    Inside,
}

#[derive(Clone, Debug, PartialEq)]
pub enum At {
    Abs {
        x: i64,
        y: i64,
    },
    Rel {
        rel: Rel,
        target: String,
        gap: Option<i64>,
    },
}

/// A new Element. `fields` holds every typed field other than the envelope,
/// under its protocol name; each becomes one CRDT register.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AddOp {
    pub id: Option<String>,
    pub typ: String,
    pub at: Option<At>,
    pub size: (Option<i64>, Option<i64>),
    pub text: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub data: BTreeMap<String, Value>,
    pub fields: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PatchOp {
    pub target: String,
    pub set: Vec<(String, Value)>,
    pub unset: Vec<String>,
    pub text_insert: Vec<(String, usize, String)>,
    pub text_delete: Vec<(String, usize, usize)>,
    pub list_insert: Vec<(String, usize, Value)>,
    pub list_move: Vec<(String, usize, usize)>,
    pub list_remove: Vec<(String, usize)>,
    pub map_put: Vec<(String, String, Value)>,
    pub map_delete: Vec<(String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Layout {
    Row,
    Column,
    Grid,
    Tree,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Add(AddOp),
    Patch(PatchOp),
    Remove {
        refs: Vec<String>,
    },
    Move {
        refs: Vec<String>,
        by: [i64; 2],
    },
    Arrange {
        refs: Vec<String>,
        layout: Layout,
        gap: i64,
        columns: Option<i64>,
        align: Option<String>,
        at: Option<At>,
    },
    Focus {
        value: Value,
    },
    Define {
        kind: String,
        name: String,
        entry: Value,
    },
    ErasePrecise {
        target: String,
        fragments: Vec<AddOp>,
    },
}

/// Every Element type the protocol defines.
pub fn builtin_types() -> impl Iterator<Item = &'static str> {
    p::ELEMENT_FIELDS
        .iter()
        .map(|(t, _)| *t)
        .filter(|t| *t != "extension")
}

/// The fields an Element of `typ` carries, from the protocol's Element schema.
pub fn element_fields(typ: &str) -> &'static [&'static str] {
    let name = if builtin_types().any(|t| t == typ) {
        typ
    } else {
        "extension"
    };
    p::ELEMENT_FIELDS
        .iter()
        .find(|(t, _)| *t == name)
        .map(|(_, f)| *f)
        .unwrap_or(&[])
}

pub fn as_int(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    // Accept whole floats such as 120.0; round others (a common model habit).
    v.as_f64()
        .filter(|f| f.is_finite())
        .map(|f| f.round() as i64)
}

pub fn placement(i: usize, pl: &p::Placement, field: &str) -> Result<At, OpError> {
    let rels: Vec<(Rel, &String)> = [
        (Rel::RightOf, &pl.right_of),
        (Rel::LeftOf, &pl.left_of),
        (Rel::Above, &pl.above),
        (Rel::Below, &pl.below),
        (Rel::Near, &pl.near),
        (Rel::Inside, &pl.inside),
    ]
    .into_iter()
    .filter_map(|(r, t)| t.as_ref().map(|t| (r, t)))
    .collect();
    let bad = |msg: &str| {
        OpError::new(
            i,
            Code::InvalidPlacement,
            format!("ops[{i}].{field}: {msg}"),
            "Use one relation, such as {\"right_of\": \"n-1\", \"gap\": 40}, or {\"x\": 100, \"y\": 80}.",
        )
        .at(&format!("/{field}"))
    };
    match (rels.as_slice(), pl.x, pl.y) {
        ([(rel, target)], None, None) => Ok(At::Rel {
            rel: *rel,
            target: (*target).clone(),
            gap: pl.gap,
        }),
        ([], Some(x), Some(y)) => Ok(At::Abs { x, y }),
        ([], None, None) => Err(bad("no position.")),
        ([], _, _) => Err(bad("x and y go together.")),
        ([_], _, _) => Err(bad("a relation and x/y can't be combined.")),
        _ => Err(bad("set exactly one relation.")),
    }
}

/// Turns a serde error message into an error the Agent can act on.
fn serde_error(i: usize, variant: &str, error: &str) -> OpError {
    let ticked =
        |s: &str| -> Vec<String> { s.split('`').skip(1).step_by(2).map(String::from).collect() };
    let parts = ticked(error);
    if error.starts_with("unknown field") {
        let f = parts.first().cloned().unwrap_or_default();
        let allowed = parts[1..].join(", ");
        OpError::new(
            i,
            Code::InvalidInput,
            format!("ops[{i}] ({variant}) has no field '{f}'."),
            format!("Remove '{f}'. Fields for {variant}: {allowed}."),
        )
        .at(&format!("/{f}"))
    } else if error.starts_with("missing field") {
        let f = parts.first().cloned().unwrap_or_default();
        OpError::new(
            i,
            Code::InvalidInput,
            format!("ops[{i}] ({variant}) needs '{f}'."),
            format!("Add '{f}'."),
        )
        .at(&format!("/{f}"))
    } else if error.starts_with("unknown variant") {
        let v = parts.first().cloned().unwrap_or_default();
        let allowed = parts[1..].join(", ");
        OpError::new(
            i,
            Code::InvalidInput,
            format!("ops[{i}] ({variant}): '{v}' is not an allowed value."),
            format!("Use one of: {allowed}."),
        )
    } else {
        OpError::new(
            i,
            Code::InvalidInput,
            format!("ops[{i}] ({variant}): {error}."),
            "Fix the value's type. read_me with the type name lists its fields.",
        )
    }
}

fn union_error(i: usize, v: &Value, e: UnionError) -> OpError {
    let ops = "add, patch, remove, arrange, focus, define";
    match e {
        UnionError::NotAnObject => OpError::new(
            i,
            Code::InvalidInput,
            format!("ops[{i}] is not an object."),
            "Each op is an object with an \"op\" field.",
        ),
        UnionError::NoVariant { .. } => match v.get("op").and_then(Value::as_str) {
            None => OpError::new(
                i,
                Code::InvalidInput,
                format!("ops[{i}] has no op."),
                format!("Set op to one of: {ops}."),
            )
            .at("/op"),
            Some("add") => OpError::new(
                i,
                Code::InvalidInput,
                format!("ops[{i}] adds an Element without a type."),
                format!(
                    "Set type to one of: {}.",
                    builtin_types()
                        .filter(|t| !["ink", "file"].contains(t))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )
            .at("/type"),
            Some("define") => OpError::new(
                i,
                Code::InvalidInput,
                format!("ops[{i}] defines something without a known kind."),
                "Set kind to \"recipe\" or \"embed\".",
            )
            .at("/kind"),
            Some(other) => OpError::new(
                i,
                Code::InvalidInput,
                format!("ops[{i}].op '{other}' is not an op."),
                format!("Use one of: {ops}."),
            )
            .at("/op"),
        },
        UnionError::Invalid { variant, error } => {
            let typ = v.get("type").and_then(Value::as_str).unwrap_or("");
            if variant == "add extension" && v.get("props").is_none() {
                return OpError::new(
                    i,
                    Code::UnknownType,
                    format!("ops[{i}]: '{typ}' is not a built-in Element type."),
                    format!(
                        "Use one of: {}. Extension types need props; read_me(\"index\") lists them.",
                        builtin_types()
                            .filter(|t| !["ink", "file"].contains(t))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )
                .at("/type");
            }
            serde_error(i, variant, &error)
        }
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// An add op, from its protocol form re-serialized as JSON.
fn add_from(i: usize, v: Value) -> Result<AddOp, OpError> {
    let mut m = obj(v);
    m.remove("op");
    let typ = m
        .remove("type")
        .and_then(|t| t.as_str().map(String::from))
        .unwrap_or_default();
    let at = match m.remove("at") {
        Some(a) => {
            let pl: p::Placement = serde_json::from_value(a).map_err(|e| {
                OpError::new(i, Code::InvalidPlacement, e.to_string(), "Fix at.").at("/at")
            })?;
            Some(placement(i, &pl, "at")?)
        }
        None => None,
    };
    let int = |m: &mut Map<String, Value>, k: &str| m.remove(k).as_ref().and_then(as_int);
    let size = (int(&mut m, "w"), int(&mut m, "h"));
    let id = m.remove("id").and_then(|v| v.as_str().map(String::from));
    let text = if has_text(&typ) {
        m.remove("text").and_then(|v| v.as_str().map(String::from))
    } else {
        None
    };
    let from = m.remove("from").and_then(|v| v.as_str().map(String::from));
    let to = m.remove("to").and_then(|v| v.as_str().map(String::from));
    let data = obj(m.remove("data").unwrap_or(Value::Null))
        .into_iter()
        .collect();
    Ok(AddOp {
        id,
        typ,
        at,
        size,
        text,
        from,
        to,
        data,
        fields: m.into_iter().collect(),
    })
}

fn patch_from(op: &p::OpPatch) -> PatchOp {
    PatchOp {
        target: op.id.clone(),
        set: op
            .set
            .as_ref()
            .map(|s| obj(serde_json::to_value(s).unwrap_or(Value::Null)))
            .unwrap_or_default()
            .into_iter()
            .collect(),
        unset: op
            .unset
            .iter()
            .flatten()
            .map(|u| u.as_str().to_string())
            .collect(),
        text_insert: op
            .text_insert
            .iter()
            .flatten()
            .map(|t| {
                (
                    t.field.as_str().into(),
                    t.at.max(0) as usize,
                    t.text.clone(),
                )
            })
            .collect(),
        text_delete: op
            .text_delete
            .iter()
            .flatten()
            .map(|t| {
                (
                    t.field.as_str().into(),
                    t.at.max(0) as usize,
                    t.len.max(0) as usize,
                )
            })
            .collect(),
        list_insert: op
            .list_insert
            .iter()
            .flatten()
            .map(|l| {
                (
                    l.field.as_str().into(),
                    l.index.max(0) as usize,
                    l.value.clone(),
                )
            })
            .collect(),
        list_move: op
            .list_move
            .iter()
            .flatten()
            .map(|l| {
                (
                    l.field.as_str().into(),
                    l.from.max(0) as usize,
                    l.to.max(0) as usize,
                )
            })
            .collect(),
        list_remove: op
            .list_remove
            .iter()
            .flatten()
            .map(|l| (l.field.as_str().into(), l.index.max(0) as usize))
            .collect(),
        map_put: op
            .map_put
            .iter()
            .flatten()
            .map(|m| (m.field.as_str().into(), m.key.clone(), m.value.clone()))
            .collect(),
        map_delete: op
            .map_delete
            .iter()
            .flatten()
            .map(|m| (m.field.as_str().into(), m.key.clone()))
            .collect(),
    }
}

/// One protocol op into the kernel's internal op.
fn convert(i: usize, op: &p::Op) -> Result<Op, OpError> {
    let value = || serde_json::to_value(op).unwrap_or(Value::Null);
    Ok(match op {
        p::Op::AddText(_)
        | p::Op::AddNote(_)
        | p::Op::AddMath(_)
        | p::Op::AddShape(_)
        | p::Op::AddConnector(_)
        | p::Op::AddImage(_)
        | p::Op::AddFrame(_)
        | p::Op::AddRegion(_)
        | p::Op::AddEmbed(_)
        | p::Op::AddExtension(_) => Op::Add(add_from(i, value())?),
        p::Op::Patch(pt) => Op::Patch(patch_from(pt)),
        p::Op::Remove(r) => Op::Remove {
            refs: r.ids.clone(),
        },
        p::Op::Arrange(a) => Op::Arrange {
            refs: a.ids.clone(),
            layout: match a.layout {
                p::OpArrangeLayout::Row => Layout::Row,
                p::OpArrangeLayout::Column => Layout::Column,
                p::OpArrangeLayout::Grid => Layout::Grid,
                p::OpArrangeLayout::Tree => Layout::Tree,
            },
            gap: a.gap.unwrap_or(40),
            columns: a.columns,
            align: a.align.map(|al| al.as_str().to_string()),
            at: a.at.as_ref().map(|pl| placement(i, pl, "at")).transpose()?,
        },
        p::Op::Focus(_) => {
            let mut m = obj(value());
            m.remove("op");
            Op::Focus {
                value: Value::Object(m),
            }
        }
        p::Op::DefineRecipe(_) | p::Op::DefineEmbed(_) => {
            let mut m = obj(value());
            m.remove("op");
            Op::Define {
                kind: m["kind"].as_str().unwrap_or("").to_string(),
                name: m["name"].as_str().unwrap_or("").to_string(),
                entry: Value::Object(m),
            }
        }
    })
}

/// Parses an Agent's `apply` ops. Returns one slot per op (None where the op
/// failed to parse) and every parse error.
pub fn parse_agent_ops(ops: &[Value]) -> (Vec<Option<Op>>, Vec<OpError>) {
    let mut errs = vec![];
    let mut out = vec![];
    for (i, v) in ops.iter().enumerate() {
        let parsed = p::Op::parse(v)
            .map_err(|e| union_error(i, v, e))
            .and_then(|op| convert(i, &op));
        match parsed {
            Ok(op) => out.push(Some(op)),
            Err(e) => {
                errs.push(e);
                out.push(None);
            }
        }
    }
    (out, errs)
}

fn point_ok(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        (2..=4).contains(&a.len()) && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
    })
}

/// A finished stroke from a device: `{id, stroke: {points, width?}, tool?, color?, width?}`.
/// Points are `[x, y]`, `[x, y, pressure]` or `[x, y, t, pressure]`.
fn parse_ink(o: &Map<String, Value>, errs: &mut Vec<OpError>) -> Option<AddOp> {
    for k in o.keys() {
        if !["intent", "id", "stroke", "tool", "color", "width"].contains(&k.as_str()) {
            errs.push(OpError::new(
                0,
                Code::InvalidInput,
                format!("A stroke has no field '{k}'."),
                "Pass id, stroke, tool, color and width.",
            ));
        }
    }
    let id = o.get("id").and_then(Value::as_str).map(String::from);
    if id.is_none() {
        errs.push(OpError::new(
            0,
            Code::InvalidInput,
            "A finished stroke needs its stable stroke ID.",
            "Pass the PencilKit stroke ID as \"id\".",
        ));
    }
    let stroke = o.get("stroke").cloned().unwrap_or(Value::Null);
    match stroke.get("points").and_then(Value::as_array) {
        Some(pts) if !pts.is_empty() && pts.iter().all(point_ok) => {}
        _ => errs.push(OpError::new(
            0,
            Code::InvalidInput,
            "Ink needs stroke.points, a list of [x, y], [x, y, pressure] or [x, y, t, pressure].",
            "Add \"stroke\": {\"points\": [[0,0],[10,12]], \"width\": 3}.",
        )),
    }
    let mut fields = BTreeMap::new();
    fields.insert("stroke".to_string(), stroke.clone());
    fields.insert(
        "tool".to_string(),
        o.get("tool")
            .cloned()
            .unwrap_or(Value::String("pen".into())),
    );
    for k in ["color", "width"] {
        if let Some(v) = o.get(k) {
            fields.insert(k.to_string(), v.clone());
        }
    }
    if !fields.contains_key("width") {
        if let Some(w) = stroke.get("width") {
            fields.insert("width".to_string(), w.clone());
        }
    }
    Some(AddOp {
        id,
        typ: "ink".into(),
        fields,
        ..Default::default()
    })
}

fn refs(o: &Map<String, Value>, k: &str, errs: &mut Vec<OpError>) -> Vec<String> {
    match o.get(k) {
        Some(Value::Array(a)) if !a.is_empty() && a.iter().all(|v| v.is_string()) => a
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => {
            errs.push(OpError::new(
                0,
                Code::InvalidInput,
                format!("The intent needs '{k}', a non-empty list of Element IDs."),
                format!("Add \"{k}\": [\"n-1\"]."),
            ));
            vec![]
        }
    }
}

/// A device's add or patch, in the protocol's op shape (with `intent` in place of `op`).
fn protocol_op(o: &Map<String, Value>, op: &str) -> Result<Op, OpError> {
    let mut m = o.clone();
    m.remove("intent");
    m.insert("op".into(), Value::String(op.into()));
    let v = Value::Object(m);
    let parsed = p::Op::parse(&v).map_err(|e| union_error(0, &v, e))?;
    convert(0, &parsed)
}

/// Parses one user intent from a device. Undo and redo are handled by the caller.
pub fn parse_intent(v: &Value) -> Result<Op, Vec<OpError>> {
    let mut errs = vec![];
    let Some(o) = v.as_object() else {
        return Err(vec![OpError::new(
            0,
            Code::InvalidInput,
            "The intent is not an object.",
            "Pass {\"intent\": \"add_stroke\", ...}.",
        )]);
    };
    let kind = o.get("intent").and_then(Value::as_str).unwrap_or("");
    let op = match kind {
        "add_stroke" => parse_ink(o, &mut errs).map(Op::Add),
        "add" => match protocol_op(o, "add") {
            Ok(Op::Add(a)) if a.id.is_some() => Some(Op::Add(a)),
            Ok(_) => {
                errs.push(OpError::new(
                    0,
                    Code::InvalidInput,
                    "A device-added Element needs an ID.",
                    "Generate a UUID on the device and pass it as \"id\".",
                ));
                None
            }
            Err(e) => {
                errs.push(e);
                None
            }
        },
        "patch" => match protocol_op(o, "patch") {
            Ok(op) => Some(op),
            Err(e) => {
                errs.push(e);
                None
            }
        },
        "move" => {
            let r = refs(o, "ids", &mut errs);
            match o.get("by").and_then(Value::as_array) {
                Some(a) if a.len() == 2 => match (as_int(&a[0]), as_int(&a[1])) {
                    (Some(dx), Some(dy)) => Some(Op::Move {
                        refs: r,
                        by: [dx, dy],
                    }),
                    _ => None,
                },
                _ => {
                    errs.push(OpError::new(
                        0,
                        Code::InvalidInput,
                        "move needs 'by': [dx, dy].",
                        "Add \"by\": [120, 0].",
                    ));
                    None
                }
            }
        }
        "erase" | "remove" => Some(Op::Remove {
            refs: refs(o, "ids", &mut errs),
        }),
        "erase_precise" => {
            let target = o.get("id").and_then(Value::as_str).map(String::from);
            if target.is_none() {
                errs.push(OpError::new(
                    0,
                    Code::InvalidInput,
                    "erase_precise needs the erased stroke's id.",
                    "Pass \"id\": \"<stroke id>\".",
                ));
            }
            let mut fragments = vec![];
            match o.get("fragments").and_then(Value::as_array) {
                Some(a) => {
                    for f in a {
                        let m = f.as_object().cloned().unwrap_or_default();
                        if let Some(add) = parse_ink(&m, &mut errs) {
                            fragments.push(add);
                        }
                    }
                }
                None => errs.push(OpError::new(
                    0,
                    Code::InvalidInput,
                    "erase_precise needs fragments (possibly empty).",
                    "Pass \"fragments\": [] when nothing is left.",
                )),
            }
            target.map(|target| Op::ErasePrecise { target, fragments })
        }
        other => {
            errs.push(OpError::new(
                0,
                Code::InvalidInput,
                format!("'{other}' is not a user intent."),
                "Use add_stroke, add, patch, move, erase, erase_precise, undo or redo.",
            ));
            None
        }
    };
    match op {
        Some(op) if errs.is_empty() => Ok(op),
        _ => Err(errs),
    }
}

/// A file the person added from the device (SPEC §5, "User imports"):
/// `{intent: "add_file", id, name, mime, size, src, at?, w?, h?, pages?}`.
/// A photo (an `image/*` mime) becomes one image Element; a PDF with `pages`
/// (`[{id, src, page, at?, w?, h?}]`, each page rendered by the device) becomes
/// one image Element per page; anything else becomes a file Element. Returns
/// the ops and what the import was, for the next Send's `added_file` change.
pub fn parse_add_file(v: &Value) -> Result<(Vec<Op>, Value), Vec<OpError>> {
    let bad = |m: &str, fix: &str| vec![OpError::new(0, Code::InvalidInput, m, fix)];
    let o = v.as_object().cloned().unwrap_or_default();
    for k in o.keys() {
        if ![
            "intent", "id", "name", "mime", "size", "src", "at", "w", "h", "pages",
        ]
        .contains(&k.as_str())
        {
            return Err(bad(
                &format!("add_file has no field '{k}'."),
                "Pass id, name, mime, size, src, at, w, h and, for a PDF, pages.",
            ));
        }
    }
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    let (Some(id), Some(name), Some(mime)) = (s("id"), s("name"), s("mime")) else {
        return Err(bad(
            "add_file needs id, name and mime.",
            "Pass the file's name and mime type and a device-made ID.",
        ));
    };
    let pick = |m: &Map<String, Value>, ks: &[&str]| -> Value {
        Value::Object(
            ks.iter()
                .filter_map(|k| m.get(*k).map(|v| ((*k).to_string(), v.clone())))
                .collect(),
        )
    };
    let image = |mut el: Value, alt: String| -> Result<Op, Vec<OpError>> {
        el["op"] = json!("add");
        el["type"] = json!("image");
        el["alt"] = json!(alt);
        let parsed = p::Op::parse(&el).map_err(|e| vec![union_error(0, &el, e)])?;
        convert(0, &parsed).map_err(|e| vec![e])
    };
    let mut info = json!({ "file": name, "mime": mime, "id": id });
    let ops: Vec<Op> = if let Some(pages) = o.get("pages").and_then(Value::as_array) {
        if pages.is_empty() {
            return Err(bad("pages is empty.", "Pass one entry per rendered page."));
        }
        info["pages"] = json!(pages.len());
        info["id"] = pages[0].get("id").cloned().unwrap_or(json!(id));
        pages
            .iter()
            .map(|pg| {
                let m = pg.as_object().cloned().unwrap_or_default();
                let n = m.get("page").and_then(as_int).unwrap_or(1);
                image(
                    pick(&m, &["id", "src", "page", "at", "w", "h"]),
                    format!("{name}, page {n}"),
                )
            })
            .collect::<Result<_, _>>()?
    } else if mime.starts_with("image/") {
        vec![image(
            pick(&o, &["id", "src", "at", "w", "h"]),
            name.clone(),
        )?]
    } else {
        let mut el = pick(&o, &["id", "name", "mime", "size", "src", "at", "w", "h"]);
        el["type"] = json!("file");
        if el.get("size").is_none() {
            el["size"] = json!(0);
        }
        vec![Op::Add(add_from(0, el).map_err(|e| vec![e])?)]
    };
    Ok((ops, info))
}
