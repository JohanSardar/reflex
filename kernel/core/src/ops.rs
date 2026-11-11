//! Parsing `apply` batches and user intents into the kernel's internal ops.
//!
//! STAND-IN: the op shapes follow ARCHITECTURE §4.2 until T1's schemas land.
//! Parsing never stops at the first problem: every failing op is reported, each
//! with a `fix` (repair first, warn second, reject last).

use crate::model::{BUILTIN_TYPES, SHAPES};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct OpError {
    pub op: usize,
    pub code: String,
    pub msg: String,
    pub fix: String,
}

impl OpError {
    pub fn new(op: usize, code: &str, msg: impl Into<String>, fix: impl Into<String>) -> Self {
        OpError {
            op,
            code: code.into(),
            msg: msg.into(),
            fix: fix.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rel {
    RightOf,
    LeftOf,
    Below,
    Above,
    Near,
}

#[derive(Clone, Debug, PartialEq)]
pub enum At {
    Abs { x: i64, y: i64 },
    Rel { rel: Rel, target: String, gap: i64 },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AddOp {
    pub id: Option<String>,
    pub typ: String,
    pub text: Option<String>,
    pub shape: Option<String>,
    pub color: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub at: Option<At>,
    pub size: (Option<i64>, Option<i64>),
    pub data: BTreeMap<String, Value>,
    pub stroke: Option<Value>,
    pub props: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PatchOp {
    pub target: String,
    pub set: Vec<(String, Value)>,
    pub unset: Vec<String>,
    pub text_insert: Option<(usize, String)>,
    pub text_delete: Option<(usize, usize)>,
    pub map_put: Vec<(String, Value)>,
    pub map_delete: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Layout {
    Row,
    Column,
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
    },
    Focus {
        value: Value,
    },
    Define {
        kind: String,
        name: String,
        params: Value,
        template: Value,
    },
    ErasePrecise {
        target: String,
        fragments: Vec<AddOp>,
    },
}

/// Fields `patch.set` accepts.
pub const SETTABLE: &[&str] = &[
    "text", "color", "shape", "from", "to", "x", "y", "w", "h", "props",
];

struct P<'a> {
    i: usize,
    o: &'a Map<String, Value>,
    errs: &'a mut Vec<OpError>,
}

impl P<'_> {
    fn err(&mut self, code: &str, msg: impl Into<String>, fix: impl Into<String>) {
        self.errs.push(OpError::new(self.i, code, msg, fix));
    }
    fn allow(&mut self, allowed: &[&str]) {
        for k in self.o.keys() {
            if !allowed.contains(&k.as_str()) {
                let list = allowed.join(", ");
                self.err(
                    "unknown_field",
                    format!("ops[{}] has an unknown field '{k}'.", self.i),
                    format!("Remove '{k}'. Allowed fields: {list}."),
                );
            }
        }
    }
    fn str_opt(&mut self, k: &str) -> Option<String> {
        match self.o.get(k) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                self.err(
                    "bad_value",
                    format!("ops[{}].{k} must be a string.", self.i),
                    format!("Pass {k} as a string."),
                );
                None
            }
        }
    }
    fn str_req(&mut self, k: &str, example: &str) -> Option<String> {
        if !self.o.contains_key(k) {
            self.err(
                "missing_field",
                format!("ops[{}] needs '{k}'.", self.i),
                format!("Add \"{k}\": {example}."),
            );
            return None;
        }
        self.str_opt(k)
    }
    fn int_opt(&mut self, k: &str) -> Option<i64> {
        match self.o.get(k) {
            None | Some(Value::Null) => None,
            Some(v) => match as_int(v) {
                Some(i) => Some(i),
                None => {
                    self.err(
                        "bad_value",
                        format!("ops[{}].{k} must be an integer.", self.i),
                        format!("Pass {k} as a whole number."),
                    );
                    None
                }
            },
        }
    }
    fn refs(&mut self, k: &str) -> Vec<String> {
        match self.o.get(k) {
            Some(Value::Array(a)) if !a.is_empty() && a.iter().all(|v| v.is_string()) => a
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => {
                self.err(
                    "missing_field",
                    format!(
                        "ops[{}] needs '{k}', a non-empty list of Element IDs.",
                        self.i
                    ),
                    format!("Add \"{k}\": [\"n-1\"]."),
                );
                vec![]
            }
        }
    }
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

fn parse_at(p: &mut P) -> Option<At> {
    let v = p.o.get("at")?;
    let Some(o) = v.as_object() else {
        p.err(
            "bad_value",
            format!("ops[{}].at must be an object.", p.i),
            "Use at: {\"x\": 100, \"y\": 80} or at: {\"right_of\": \"n-1\"}.",
        );
        return None;
    };
    let gap = o.get("gap").and_then(as_int).unwrap_or(40);
    for (name, rel) in [
        ("right_of", Rel::RightOf),
        ("left_of", Rel::LeftOf),
        ("below", Rel::Below),
        ("above", Rel::Above),
        ("near", Rel::Near),
    ] {
        if let Some(t) = o.get(name) {
            return match t.as_str() {
                Some(t) => Some(At::Rel {
                    rel,
                    target: t.to_string(),
                    gap,
                }),
                None => {
                    p.err(
                        "bad_value",
                        format!("ops[{}].at.{name} must be an Element ID.", p.i),
                        format!("Use at: {{\"{name}\": \"n-1\"}}."),
                    );
                    None
                }
            };
        }
    }
    match (o.get("x").and_then(as_int), o.get("y").and_then(as_int)) {
        (Some(x), Some(y)) => Some(At::Abs { x, y }),
        _ => {
            p.err(
                "bad_value",
                format!("ops[{}].at has no position.", p.i),
                "Use at: {\"x\": 100, \"y\": 80}, or one of right_of, left_of, below, above, near.",
            );
            None
        }
    }
}

fn parse_data(p: &mut P, k: &str) -> BTreeMap<String, Value> {
    match p.o.get(k) {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(_) => {
            p.err(
                "bad_value",
                format!("ops[{}].{k} must be an object.", p.i),
                format!("Pass {k} as a JSON object, e.g. {{\"task\": \"T-12\"}}."),
            );
            BTreeMap::new()
        }
    }
}

pub fn parse_add(
    i: usize,
    o: &Map<String, Value>,
    errs: &mut Vec<OpError>,
    extra: &[&str],
) -> Option<AddOp> {
    let mut p = P { i, o, errs };
    let mut allowed = vec![
        "op", "intent", "id", "type", "text", "shape", "color", "from", "to", "at", "w", "h",
        "data", "stroke", "props",
    ];
    allowed.extend_from_slice(extra);
    p.allow(&allowed);
    let typ = p.str_req("type", "\"shape\"")?;
    let builtin = BUILTIN_TYPES.contains(&typ.as_str());
    let add = AddOp {
        id: p.str_opt("id"),
        text: p.str_opt("text"),
        shape: p.str_opt("shape"),
        color: p.str_opt("color"),
        from: p.str_opt("from"),
        to: p.str_opt("to"),
        at: parse_at(&mut p),
        size: (p.int_opt("w"), p.int_opt("h")),
        data: parse_data(&mut p, "data"),
        stroke: p.o.get("stroke").cloned(),
        props: p.o.get("props").cloned(),
        typ,
    };
    if builtin && add.props.is_some() {
        p.err(
            "bad_field",
            format!(
                "ops[{i}]: built-in type '{}' has typed fields, not props.",
                add.typ
            ),
            "Move the values out of props to top-level fields.",
        );
    }
    if let Some(s) = &add.shape {
        if !SHAPES.contains(&s.as_str()) {
            p.err(
                "bad_value",
                format!("ops[{i}]: unknown shape '{s}'."),
                format!("Use one of: {}.", SHAPES.join(", ")),
            );
        }
    }
    match add.typ.as_str() {
        "connector" => {
            if add.from.is_none() || add.to.is_none() {
                p.err(
                    "missing_field",
                    format!("ops[{i}]: a connector needs 'from' and 'to'."),
                    "Add \"from\": \"n-a\", \"to\": \"n-b\".",
                );
            }
        }
        "ink" => match add
            .stroke
            .as_ref()
            .and_then(|s| s.get("points"))
            .and_then(|v| v.as_array())
        {
            Some(pts) if !pts.is_empty() && pts.iter().all(point_ok) => {}
            _ => p.err(
                "missing_field",
                format!("ops[{i}]: Ink needs stroke.points, a list of [x, y] or [x, y, pressure]."),
                "Add \"stroke\": {\"points\": [[0,0],[10,12]], \"width\": 3}.",
            ),
        },
        _ => {}
    }
    if !builtin && add.props.as_ref().is_some_and(|v| !v.is_object()) {
        p.err(
            "bad_value",
            format!("ops[{i}]: props must be an object."),
            "Pass props as a JSON object.",
        );
    }
    Some(add)
}

fn point_ok(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        (2..=4).contains(&a.len()) && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
    })
}

fn parse_patch(i: usize, o: &Map<String, Value>, errs: &mut Vec<OpError>) -> Option<PatchOp> {
    let mut p = P { i, o, errs };
    p.allow(&[
        "op",
        "intent",
        "id",
        "set",
        "unset",
        "text_insert",
        "text_delete",
        "map_put",
        "map_delete",
        "list_insert",
        "list_move",
        "list_remove",
    ]);
    for k in ["list_insert", "list_move", "list_remove"] {
        if p.o.contains_key(k) {
            p.err(
                "no_list_field",
                format!("ops[{i}].{k}: no v0 Element type has a list field."),
                "Use set for scalar fields or map_put for data.",
            );
        }
    }
    let target = p.str_req("id", "\"n-1\"")?;
    let mut patch = PatchOp {
        target,
        ..Default::default()
    };
    if let Some(v) = p.o.get("set") {
        match v.as_object() {
            Some(m) => {
                for (k, v) in m {
                    if SETTABLE.contains(&k.as_str()) {
                        patch.set.push((k.clone(), v.clone()));
                    } else {
                        p.err(
                            "bad_field",
                            format!("ops[{i}].set.{k} is not a field that set can change."),
                            format!(
                                "Settable fields: {}. Use map_put for your own data.",
                                SETTABLE.join(", ")
                            ),
                        );
                    }
                }
            }
            None => p.err(
                "bad_value",
                format!("ops[{i}].set must be an object."),
                "Use set: {\"text\": \"Postgres\"}.",
            ),
        }
    }
    if let Some(v) = p.o.get("unset") {
        match v.as_array() {
            Some(a) => {
                for k in a.iter().filter_map(|v| v.as_str()) {
                    if ["color", "props"].contains(&k) {
                        patch.unset.push(k.to_string());
                    } else {
                        p.err(
                            "bad_field",
                            format!("ops[{i}].unset: '{k}' cannot be unset."),
                            "Only color and props can be unset.",
                        );
                    }
                }
            }
            None => p.err(
                "bad_value",
                format!("ops[{i}].unset must be a list of field names."),
                "Use unset: [\"color\"].",
            ),
        }
    }
    if let Some(v) = p.o.get("text_insert") {
        match (
            v.get("at").and_then(as_int),
            v.get("text").and_then(|t| t.as_str()),
        ) {
            (Some(at), Some(t)) if at >= 0 => {
                patch.text_insert = Some((at as usize, t.to_string()))
            }
            _ => p.err(
                "bad_value",
                format!("ops[{i}].text_insert needs at (a UTF-16 index) and text."),
                "Use text_insert: {\"at\": 0, \"text\": \"Hello \"}.",
            ),
        }
    }
    if let Some(v) = p.o.get("text_delete") {
        match (v.get("at").and_then(as_int), v.get("len").and_then(as_int)) {
            (Some(at), Some(len)) if at >= 0 && len >= 0 => {
                patch.text_delete = Some((at as usize, len as usize))
            }
            _ => p.err(
                "bad_value",
                format!("ops[{i}].text_delete needs at and len (UTF-16 units)."),
                "Use text_delete: {\"at\": 0, \"len\": 5}.",
            ),
        }
    }
    patch.map_put = parse_data(&mut p, "map_put").into_iter().collect();
    if let Some(v) = p.o.get("map_delete") {
        match v.as_array() {
            Some(a) => {
                patch.map_delete = a
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            }
            None => p.err(
                "bad_value",
                format!("ops[{i}].map_delete must be a list of keys."),
                "Use map_delete: [\"score\"].",
            ),
        }
    }
    Some(patch)
}

fn parse_by(p: &mut P) -> Option<[i64; 2]> {
    match p.o.get("by").and_then(|v| v.as_array()) {
        Some(a) if a.len() == 2 => Some([as_int(&a[0])?, as_int(&a[1])?]),
        _ => {
            p.err(
                "missing_field",
                format!("ops[{}] needs 'by': [dx, dy].", p.i),
                "Add \"by\": [120, 0].",
            );
            None
        }
    }
}

/// Parses an Agent's `apply` ops.
pub fn parse_agent_ops(ops: &[Value]) -> (Vec<Option<Op>>, Vec<OpError>) {
    let mut errs = vec![];
    let mut out = vec![];
    for (i, v) in ops.iter().enumerate() {
        let Some(o) = v.as_object() else {
            errs.push(OpError::new(
                i,
                "bad_op",
                format!("ops[{i}] is not an object."),
                "Each op is an object with an \"op\" field.",
            ));
            out.push(None);
            continue;
        };
        let kind = o.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let op = match kind {
            "add" => parse_add(i, o, &mut errs, &[]).map(Op::Add),
            "patch" => parse_patch(i, o, &mut errs).map(Op::Patch),
            "remove" => {
                let mut p = P {
                    i,
                    o,
                    errs: &mut errs,
                };
                p.allow(&["op", "ids"]);
                Some(Op::Remove {
                    refs: p.refs("ids"),
                })
            }
            "arrange" => {
                let mut p = P {
                    i,
                    o,
                    errs: &mut errs,
                };
                p.allow(&["op", "ids", "layout", "gap"]);
                let refs = p.refs("ids");
                let layout = match p.str_opt("layout").as_deref() {
                    None | Some("row") => Some(Layout::Row),
                    Some("column") => Some(Layout::Column),
                    Some(other) => {
                        p.err(
                            "bad_value",
                            format!("ops[{i}]: unknown layout '{other}'."),
                            "Use layout \"row\" or \"column\".",
                        );
                        None
                    }
                };
                let gap = p.int_opt("gap").unwrap_or(40);
                layout.map(|layout| Op::Arrange { refs, layout, gap })
            }
            "focus" => {
                let mut p = P {
                    i,
                    o,
                    errs: &mut errs,
                };
                p.allow(&["op", "ids", "bounds"]);
                let mut m = o.clone();
                m.remove("op");
                Some(Op::Focus {
                    value: Value::Object(m),
                })
            }
            "define" => {
                let mut p = P {
                    i,
                    o,
                    errs: &mut errs,
                };
                p.allow(&["op", "kind", "name", "params", "template"]);
                let kind = p.str_req("kind", "\"recipe\"");
                let name = p.str_req("name", "\"check-my-work\"");
                if let Some(k) = &kind {
                    if k != "recipe" && k != "embed" {
                        p.err(
                            "bad_value",
                            format!("ops[{i}]: define kind '{k}' is unknown."),
                            "Use kind \"recipe\" or \"embed\".",
                        );
                    }
                }
                if !o.contains_key("template") {
                    p.err(
                        "missing_field",
                        format!("ops[{i}]: define needs a template."),
                        "Add \"template\": the ops or HTML to save.",
                    );
                }
                match (kind, name) {
                    (Some(kind), Some(name)) => Some(Op::Define {
                        kind,
                        name,
                        params: o
                            .get("params")
                            .cloned()
                            .unwrap_or(Value::Object(Map::new())),
                        template: o.get("template").cloned().unwrap_or(Value::Null),
                    }),
                    _ => None,
                }
            }
            other => {
                errs.push(OpError::new(
                    i,
                    "unknown_op",
                    format!("ops[{i}].op '{other}' is not an op."),
                    "Use one of: add, patch, remove, arrange, focus, define.",
                ));
                None
            }
        };
        out.push(op);
    }
    (out, errs)
}

/// Parses one user intent from a device. Undo and redo are handled by the caller.
pub fn parse_intent(v: &Value) -> Result<Op, Vec<OpError>> {
    let mut errs = vec![];
    let Some(o) = v.as_object() else {
        return Err(vec![OpError::new(
            0,
            "bad_intent",
            "The intent is not an object.",
            "Pass {\"intent\": \"add_stroke\", ...}.",
        )]);
    };
    let kind = o.get("intent").and_then(|v| v.as_str()).unwrap_or("");
    let op = match kind {
        "add_stroke" => {
            let mut m = o.clone();
            m.insert("type".into(), Value::String("ink".into()));
            let add = parse_add(0, &m, &mut errs, &[]);
            if add.as_ref().is_some_and(|a| a.id.is_none()) {
                errs.push(OpError::new(
                    0,
                    "missing_field",
                    "A finished stroke needs its stable stroke ID.",
                    "Pass the PencilKit stroke ID as \"id\".",
                ));
            }
            add.map(Op::Add)
        }
        "add" => {
            let add = parse_add(0, o, &mut errs, &[]);
            if add.as_ref().is_some_and(|a| a.id.is_none()) {
                errs.push(OpError::new(
                    0,
                    "missing_field",
                    "A device-added Element needs an ID.",
                    "Generate a UUID on the device and pass it as \"id\".",
                ));
            }
            add.map(Op::Add)
        }
        "patch" => parse_patch(0, o, &mut errs).map(Op::Patch),
        "move" => {
            let mut p = P {
                i: 0,
                o,
                errs: &mut errs,
            };
            p.allow(&["intent", "ids", "by"]);
            let refs = p.refs("ids");
            parse_by(&mut p).map(|by| Op::Move { refs, by })
        }
        "erase" | "remove" => {
            let mut p = P {
                i: 0,
                o,
                errs: &mut errs,
            };
            p.allow(&["intent", "ids"]);
            Some(Op::Remove {
                refs: p.refs("ids"),
            })
        }
        "erase_precise" => {
            let mut p = P {
                i: 0,
                o,
                errs: &mut errs,
            };
            p.allow(&["intent", "id", "fragments"]);
            let target = p.str_req("id", "\"stroke-id\"");
            let mut fragments = vec![];
            match o.get("fragments").and_then(|v| v.as_array()) {
                Some(a) => {
                    for f in a {
                        let mut m = f.as_object().cloned().unwrap_or_default();
                        m.insert("type".into(), Value::String("ink".into()));
                        if let Some(add) = parse_add(0, &m, &mut errs, &[]) {
                            if add.id.is_none() {
                                errs.push(OpError::new(
                                    0,
                                    "missing_field",
                                    "Each fragment needs its stable stroke ID.",
                                    "Pass the fragment's PencilKit stroke ID as \"id\".",
                                ));
                            }
                            fragments.push(add);
                        }
                    }
                }
                None => errs.push(OpError::new(
                    0,
                    "missing_field",
                    "erase_precise needs fragments (possibly empty).",
                    "Pass \"fragments\": [] when nothing is left.",
                )),
            }
            target.map(|target| Op::ErasePrecise { target, fragments })
        }
        other => {
            errs.push(OpError::new(
                0,
                "unknown_intent",
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
