//! Mark grouping and Anchor resolution (ARCHITECTURE §3, §4.3, §7.4–§7.5).
//!
//! A frozen Send names the strokes the person drew since their last Send.
//! Here they are grouped into Marks, each Mark is read as a gesture (a circle,
//! an arrow from one Element to another, a strikethrough, an underline, a
//! check, a cross, or writing), and its Anchors are resolved: the Element IDs
//! it points at. Everything is computed against the Send's pinned frontier, so
//! the answer never changes however the Space changes later. When a target
//! has moved since, the Mark says so (`moved_since_marked`, `marked_at`).
//!
//! The device's handwriting hints (`hints`: strokes, recognized text and a
//! confidence, from Apple's on-device recognizer) group strokes into writing
//! and carry the text. Embed answers (`embed_anchors`) give a Mark its
//! `target` inside an Embed. Recognition is heuristic and never final: raw
//! strokes are always kept, and an unrecognized group is reported as `ink`.

use crate::apply::{connector_aware_bounds, display_id, resolve, Edit};
use crate::doc;
use crate::model::{Principal, Record};
use automerge::{Automerge, ChangeHash, ObjId as ExId, ReadDoc};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::str::FromStr;

type B = [f64; 4];

fn fb(b: [i64; 4]) -> B {
    [b[0] as f64, b[1] as f64, b[2] as f64, b[3] as f64]
}

fn ib(b: B) -> [i64; 4] {
    [
        b[0].floor() as i64,
        b[1].floor() as i64,
        (b[2].ceil() as i64).max(1),
        (b[3].ceil() as i64).max(1),
    ]
}

fn union(a: B, b: B) -> B {
    let x0 = a[0].min(b[0]);
    let y0 = a[1].min(b[1]);
    let x1 = (a[0] + a[2]).max(b[0] + b[2]);
    let y1 = (a[1] + a[3]).max(b[1] + b[3]);
    [x0, y0, x1 - x0, y1 - y0]
}

fn pad(b: B, p: f64) -> B {
    [b[0] - p, b[1] - p, b[2] + 2.0 * p, b[3] + 2.0 * p]
}

fn overlaps(a: B, b: B) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

fn inter_area(a: B, b: B) -> f64 {
    let w = (a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0]);
    let h = (a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1]);
    if w <= 0.0 || h <= 0.0 {
        0.0
    } else {
        w * h
    }
}

fn center(b: B) -> (f64, f64) {
    (b[0] + b[2] / 2.0, b[1] + b[3] / 2.0)
}

fn inside_box(b: B, x: f64, y: f64) -> bool {
    x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]
}

/// Distance from a point to a box (0 inside).
fn box_dist(b: B, x: f64, y: f64) -> f64 {
    let dx = (b[0] - x).max(0.0).max(x - b[0] - b[2]);
    let dy = (b[1] - y).max(0.0).max(y - b[1] - b[3]);
    dx.hypot(dy)
}

/// Gap between two boxes (0 when they touch or overlap).
fn box_gap(a: B, b: B) -> f64 {
    let dx = (b[0] - (a[0] + a[2])).max(a[0] - (b[0] + b[2])).max(0.0);
    let dy = (b[1] - (a[1] + a[3])).max(a[1] - (b[1] + b[3])).max(0.0);
    dx.hypot(dy)
}

/// Even-odd point-in-polygon over a stroke's path.
fn in_path(pts: &[(f64, f64)], x: f64, y: f64) -> bool {
    let mut hit = false;
    let n = pts.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = pts[i];
        let (xj, yj) = pts[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            hit = !hit;
        }
        j = i;
    }
    hit
}

fn path_len(pts: &[(f64, f64)]) -> f64 {
    pts.windows(2)
        .map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1))
        .sum()
}

/// One stroke of the Send, as it was at the frontier.
struct Stroke {
    key: String,
    pts: Vec<(f64, f64)>,
    bounds: B,
    /// Start and end, in the device's milliseconds since the epoch.
    start: i64,
    end: i64,
}

impl Stroke {
    fn size(&self) -> f64 {
        self.bounds[2].max(self.bounds[3])
    }
    fn first(&self) -> (f64, f64) {
        self.pts.first().copied().unwrap_or((0.0, 0.0))
    }
    fn last(&self) -> (f64, f64) {
        self.pts.last().copied().unwrap_or((0.0, 0.0))
    }
    /// How straight it is: 1 for a line, near 0 for a scribble.
    fn straightness(&self) -> f64 {
        let l = path_len(&self.pts);
        if l <= 0.0 {
            return 0.0;
        }
        let (a, b) = (self.first(), self.last());
        (b.0 - a.0).hypot(b.1 - a.1) / l
    }
    /// A path that comes back near where it started.
    fn closed(&self) -> bool {
        if self.pts.len() < 8 {
            return false;
        }
        let size = self.size();
        let (x0, y0) = self.first();
        let near = 0.3 * size;
        self.pts[self.pts.len() / 2..]
            .iter()
            .any(|(x, y)| (x - x0).hypot(y - y0) < near)
            && path_len(&self.pts) > 2.2 * size
    }
}

struct Group {
    strokes: Vec<usize>,
    bounds: B,
    hint: Option<Hint>,
}

#[derive(Clone)]
struct Hint {
    text: String,
    confidence: f64,
}

/// What a Mark can point at: a live, non-Ink Element at the frontier.
struct Target {
    key: String,
    typ: String,
    bounds: B,
}

fn targets<R: ReadDoc>(d: &R) -> Vec<Target> {
    doc::live_records(d)
        .into_iter()
        .filter(|r| r.typ != "ink")
        .map(|r| Target {
            bounds: fb(connector_aware_bounds(d, &r)),
            key: r.key,
            typ: r.typ,
        })
        .collect()
}

/// The Space as it was when the stroke `key` was drawn: forked at the change that added it.
fn drawn_at(d: &Automerge, key: &str) -> Option<Automerge> {
    let elements = doc::root(d, "elements");
    let ExId::Id(counter, actor, _) = doc::obj(d, &elements, key)? else {
        return None;
    };
    let change = d.get_changes(&[]).into_iter().find(|c| {
        let start = c.start_op().get();
        c.actor_id() == &actor && counter >= start && counter < start + c.len() as u64
    })?;
    d.fork_at(&[change.hash()]).ok()
}

fn is_container(t: &Target) -> bool {
    t.typ == "frame" || t.typ == "region"
}

fn stroke_points(rec: &Record) -> Vec<(f64, f64, f64)> {
    rec.field_json("stroke")
        .and_then(|s| s.get("points").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_array)
        .map(|a| {
            let n = |i: usize| a.get(i).and_then(Value::as_f64).unwrap_or(0.0);
            let t = if a.len() >= 4 { n(2) } else { 0.0 };
            (n(0), n(1), t)
        })
        .collect()
}

/// When each of this person's strokes was committed (their history entry's time).
fn stroke_times<R: ReadDoc>(d: &R, person: &str) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    for e in crate::history_entries(d, person) {
        for ed in &e.edits {
            if let Edit::Create { .. } = ed {
                out.entry(ed.key()).or_insert(e.at);
            }
        }
    }
    out
}

/// The Element the point is on, or the nearest within `reach`, preferring the smallest.
fn target_at(ts: &[Target], x: f64, y: f64, reach: f64) -> Option<usize> {
    let mut best: Option<(f64, f64, usize)> = None;
    for (i, t) in ts.iter().enumerate() {
        if t.typ == "connector" {
            continue;
        }
        let d = box_dist(t.bounds, x, y);
        if d > reach {
            continue;
        }
        // Inside a small Element beats inside the frame around it.
        let area = t.bounds[2] * t.bounds[3] * if is_container(t) { 1e6 } else { 1.0 };
        if best.is_none_or(|(bd, ba, _)| d < bd - 1.0 || (d <= bd + 1.0 && area < ba)) {
            best = Some((d, area, i));
        }
    }
    best.map(|(_, _, i)| i)
}

fn group_strokes(strokes: &[Stroke], hints: &[(Vec<usize>, Hint)]) -> Vec<Group> {
    let mut groups: Vec<Group> = vec![];
    let mut taken = vec![false; strokes.len()];
    for (members, h) in hints {
        let members: Vec<usize> = members.iter().copied().filter(|&i| !taken[i]).collect();
        if members.is_empty() {
            continue;
        }
        let mut b = strokes[members[0]].bounds;
        for &i in &members {
            taken[i] = true;
            b = union(b, strokes[i].bounds);
        }
        groups.push(Group {
            strokes: members,
            bounds: b,
            hint: Some(h.clone()),
        });
    }
    // The rest, in drawing order: a stroke joins the group drawn just before it when it
    // follows quickly and is either small and close (letters, an arrowhead) or lies over
    // the last stroke (the second line of a cross).
    let mut order: Vec<usize> = (0..strokes.len()).filter(|&i| !taken[i]).collect();
    order.sort_by_key(|&i| (strokes[i].start, i));
    let mut open: Option<usize> = None;
    for i in order {
        let s = &strokes[i];
        let join = open.and_then(|g| {
            let grp = &groups[g];
            if grp.hint.is_some() {
                return None;
            }
            let last = &strokes[*grp.strokes.last()?];
            let quick = s.start - last.end <= 1500;
            let small = s.size() <= 90.0 && overlaps(pad(grp.bounds, 50.0), s.bounds);
            let smaller = s.bounds[2] * s.bounds[3];
            let over = smaller > 0.0
                && inter_area(s.bounds, last.bounds)
                    >= 0.5 * smaller.min(last.bounds[2] * last.bounds[3]);
            (quick && (small || over)).then_some(g)
        });
        match join {
            Some(g) => {
                groups[g].strokes.push(i);
                groups[g].bounds = union(groups[g].bounds, s.bounds);
            }
            None => {
                groups.push(Group {
                    strokes: vec![i],
                    bounds: s.bounds,
                    hint: None,
                });
                open = Some(groups.len() - 1);
            }
        }
    }
    groups.sort_by_key(|g| {
        g.strokes
            .iter()
            .map(|&i| strokes[i].start)
            .min()
            .unwrap_or(0)
    });
    groups
}

enum Kind {
    Circle(Vec<usize>),
    Arrow(Option<usize>, Option<usize>),
    Strike(usize),
    Underline(usize),
    Check(Option<usize>),
    Cross(Option<usize>),
    Writing,
    Ink,
}

/// The Element under a small gesture (a check or cross): the one it overlaps most.
fn under(ts: &[Target], b: B) -> Option<usize> {
    ts.iter()
        .enumerate()
        .filter(|(_, t)| t.typ != "connector")
        .map(|(i, t)| {
            (
                inter_area(t.bounds, b) / (t.bounds[2] * t.bounds[3]).max(1.0),
                i,
            )
        })
        .filter(|(a, _)| *a > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, i)| i)
        .or_else(|| {
            let (cx, cy) = center(b);
            target_at(ts, cx, cy, 30.0)
        })
}

fn is_check(s: &Stroke) -> bool {
    let n = s.pts.len();
    if n < 4 || s.size() > 220.0 {
        return false;
    }
    let (k, low) = s
        .pts
        .iter()
        .enumerate()
        .max_by(|a, b| a.1 .1.total_cmp(&b.1 .1))
        .map(|(i, p)| (i, *p))
        .unwrap();
    let (a, z) = (s.first(), s.last());
    let h = s.bounds[3].max(1.0);
    let frac = k as f64 / (n - 1) as f64;
    (0.1..=0.6).contains(&frac)
        && a.1 < low.1 - 0.2 * h
        && z.1 < a.1
        && z.0 > low.0
        && low.0 > a.0
        && (z.1 - low.1).abs() > 1.3 * (low.1 - a.1).abs()
}

fn classify(g: &Group, strokes: &[Stroke], ts: &[Target]) -> Kind {
    let ss: Vec<&Stroke> = g.strokes.iter().map(|&i| &strokes[i]).collect();
    let main = ss
        .iter()
        .max_by(|a, b| path_len(&a.pts).total_cmp(&path_len(&b.pts)))
        .copied()
        .expect("a group has a stroke");
    let size = g.bounds[2].max(g.bounds[3]);

    // A closed loop around Elements: a circle.
    if main.closed() {
        let mut on: Vec<usize> = ts
            .iter()
            .enumerate()
            .filter(|(_, t)| t.typ != "connector")
            .filter(|(_, t)| {
                let (cx, cy) = center(t.bounds);
                in_path(&main.pts, cx, cy)
                    && t.bounds[2] <= main.bounds[2] * 1.3
                    && t.bounds[3] <= main.bounds[3] * 1.3
            })
            .map(|(i, _)| i)
            .collect();
        // A frame or Region only when nothing smaller is inside.
        if on.iter().any(|&i| !is_container(&ts[i])) {
            on.retain(|&i| !is_container(&ts[i]));
        }
        if !on.is_empty() {
            return Kind::Circle(on);
        }
    }

    // Two crossing strokes of a similar size: a cross.
    if ss.len() == 2
        && ss.iter().all(|s| s.straightness() > 0.8 && s.size() > 20.0)
        && inter_area(ss[0].bounds, ss[1].bounds)
            >= 0.5 * (ss[0].bounds[2] * ss[0].bounds[3]).min(ss[1].bounds[2] * ss[1].bounds[3])
    {
        return Kind::Cross(under(ts, g.bounds));
    }
    if ss.len() == 1 && is_check(main) {
        return Kind::Check(under(ts, g.bounds));
    }

    let long = path_len(&main.pts) >= 50.0;
    if long && main.straightness() > 0.55 {
        let (a, _) = (main.first(), main.last());
        // The tip is where the shaft got furthest from its start (a head drawn in the same stroke comes back).
        let tip = main
            .pts
            .iter()
            .copied()
            .max_by(|p, q| {
                (p.0 - a.0)
                    .hypot(p.1 - a.1)
                    .total_cmp(&(q.0 - a.0).hypot(q.1 - a.1))
            })
            .unwrap_or(a);
        let from = target_at(ts, a.0, a.1, 40.0);
        let to = target_at(ts, tip.0, tip.1, 40.0);
        let headed = ss.len() > 1 || main.straightness() < 0.92;
        if from.is_some() && to.is_some() && from != to {
            return Kind::Arrow(from, to);
        }
        // A straight line through the middle of one Element: a strikethrough.
        let mid = ((a.0 + tip.0) / 2.0, (a.1 + tip.1) / 2.0);
        let flat = main.bounds[3] <= (0.35 * main.bounds[2]).max(30.0);
        if ss.len() == 1 && main.straightness() > 0.85 {
            let through = ts
                .iter()
                .enumerate()
                .filter(|(_, t)| t.typ != "connector" && !is_container(t))
                .filter(|(_, t)| {
                    let inner = [
                        t.bounds[0],
                        t.bounds[1] + 0.2 * t.bounds[3],
                        t.bounds[2],
                        0.6 * t.bounds[3],
                    ];
                    inside_box(inner, mid.0, mid.1)
                        && (tip.0 - a.0).hypot(tip.1 - a.1)
                            >= 0.45 * t.bounds[2].min(main.bounds[2].max(t.bounds[2]))
                })
                .min_by(|x, y| {
                    (x.1.bounds[2] * x.1.bounds[3]).total_cmp(&(y.1.bounds[2] * y.1.bounds[3]))
                })
                .map(|(i, _)| i);
            if let Some(t) = through {
                return Kind::Strike(t);
            }
            // A flat line just under an Element: an underline.
            if flat {
                let top = main.bounds[1];
                let below = ts
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.typ != "connector" && !is_container(t))
                    .filter(|(_, t)| {
                        let bottom = t.bounds[1] + t.bounds[3];
                        top >= t.bounds[1] + 0.65 * t.bounds[3]
                            && top <= bottom + 30.0
                            && inter_area(
                                [main.bounds[0], t.bounds[1], main.bounds[2], t.bounds[3]],
                                t.bounds,
                            ) >= 0.4 * t.bounds[2] * t.bounds[3]
                    })
                    .min_by(|x, y| {
                        (top - x.1.bounds[1] - x.1.bounds[3])
                            .abs()
                            .total_cmp(&(top - y.1.bounds[1] - y.1.bounds[3]).abs())
                    })
                    .map(|(i, _)| i);
                if let Some(t) = below {
                    return Kind::Underline(t);
                }
            }
        }
        // A headed line that points at something: an arrow, even if it starts in empty space.
        if headed && (to.is_some() || from.is_some()) && size >= 60.0 {
            return Kind::Arrow(from, to);
        }
    }

    // Several small strokes in a row: handwriting.
    let small = ss.iter().all(|s| s.size() <= 120.0);
    if ss.len() >= 2 && small {
        return Kind::Writing;
    }
    Kind::Ink
}

/// Groups a frozen Send's strokes into Marks and resolves their Anchors.
/// `send` is the stored frozen Send; `now` is the current document, used only
/// to tell whether a target moved after the Send.
pub fn marks(now: &Automerge, send: &Value, viewer: Option<&Principal>) -> Value {
    let heads: Vec<ChangeHash> = send
        .get("frontier")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|h| h.as_str().and_then(|s| ChangeHash::from_str(s).ok()))
                .collect()
        })
        .unwrap_or_default();
    let then = if heads.is_empty() {
        None
    } else {
        now.fork_at(&heads).ok()
    };
    let at: &Automerge = then.as_ref().unwrap_or(now);
    let person = send["from"]["person"].as_str().unwrap_or("");
    let times = stroke_times(at, person);

    let keys: Vec<String> = send
        .get("strokes")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let strokes: Vec<Stroke> = keys
        .iter()
        .filter_map(|k| doc::read_record(at, k))
        .filter(|r| r.typ == "ink")
        .map(|r| {
            let pts = stroke_points(&r);
            let dur = pts.iter().map(|p| p.2).fold(0.0, f64::max) as i64;
            let end = times.get(&r.key).copied().unwrap_or(0);
            Stroke {
                pts: pts.iter().map(|p| (p.0, p.1)).collect(),
                bounds: fb(r.bounds),
                start: end - dur,
                end,
                key: r.key,
            }
        })
        .collect();
    let index: BTreeMap<&str, usize> = strokes
        .iter()
        .enumerate()
        .map(|(i, s)| (s.key.as_str(), i))
        .collect();

    // The device's handwriting hints, by the strokes they cover.
    let hints: Vec<(Vec<usize>, Hint)> = send
        .get("hints")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|h| {
                    let text = h.get("text")?.as_str()?.trim().to_string();
                    let members: Vec<usize> = h
                        .get("strokes")?
                        .as_array()?
                        .iter()
                        .filter_map(|s| s.as_str())
                        .filter_map(|s| {
                            index
                                .get(s)
                                .or_else(|| index.get(s.replacen(':', "/", 1).as_str()))
                                .copied()
                        })
                        .collect();
                    let confidence = h
                        .get("confidence")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.5)
                        .clamp(0.0, 1.0);
                    (!members.is_empty() && !text.is_empty())
                        .then_some((members, Hint { text, confidence }))
                })
                .collect()
        })
        .unwrap_or_default();

    let ts = targets(at);
    let current: BTreeMap<String, B> = doc::live_records(now)
        .into_iter()
        .map(|r| (r.key.clone(), fb(connector_aware_bounds(now, &r))))
        .collect();
    let show = |k: &str| display_id(viewer, k);
    let groups = group_strokes(&strokes, &hints);

    // Embed answers, by stroke.
    let embed: Vec<(Vec<String>, String, Value)> = send
        .get("embed_anchors")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let ss: Vec<String> = e
                        .get("strokes")?
                        .as_array()?
                        .iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect();
                    let el = e.get("element")?.as_str()?;
                    let key = resolve(at, &Principal::Person(person.to_string()), el)?;
                    Some((ss, key, e.get("anchor")?.clone()))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut out: Vec<Value> = vec![];
    let mut placed: Vec<(String, B)> = vec![];
    for (n, g) in groups.iter().enumerate() {
        let id = format!("m{}", n + 1);
        // Anchors are frozen when the Mark is drawn: resolve them against the Space as it was then.
        let last = g.strokes.iter().max_by_key(|&&i| strokes[i].end);
        let drawn: Option<Vec<Target>> = last
            .and_then(|&i| drawn_at(at, &strokes[i].key))
            .map(|d| targets(&d));
        let ts: &Vec<Target> = drawn.as_ref().unwrap_or(&ts);
        let gesture = classify(g, &strokes, ts);
        let mut m = Map::new();
        m.insert("id".into(), json!(id));
        let mut anchored: Vec<usize> = vec![];
        let hint_wins = g.hint.as_ref().is_some_and(|h| {
            h.confidence >= 0.8 && h.text.chars().filter(|c| c.is_alphanumeric()).count() >= 3
        });
        let kind = match (&gesture, &g.hint) {
            (Kind::Ink | Kind::Writing, Some(_)) => Kind::Writing,
            (_, Some(_)) if hint_wins => Kind::Writing,
            _ => gesture,
        };
        match &kind {
            Kind::Circle(on) => {
                m.insert("kind".into(), json!("circle"));
                m.insert(
                    "on".into(),
                    json!(on.iter().map(|&i| show(&ts[i].key)).collect::<Vec<_>>()),
                );
                anchored.extend(on);
            }
            Kind::Arrow(f, t) => {
                m.insert("kind".into(), json!("arrow"));
                if let Some(f) = f {
                    m.insert("from".into(), json!(show(&ts[*f].key)));
                    anchored.push(*f);
                }
                if let Some(t) = t {
                    m.insert("to".into(), json!(show(&ts[*t].key)));
                    anchored.push(*t);
                }
            }
            Kind::Strike(t) | Kind::Underline(t) => {
                m.insert(
                    "kind".into(),
                    json!(if matches!(kind, Kind::Strike(_)) {
                        "strike"
                    } else {
                        "underline"
                    }),
                );
                m.insert("on".into(), json!([show(&ts[*t].key)]));
                anchored.push(*t);
            }
            Kind::Check(t) | Kind::Cross(t) => {
                m.insert(
                    "kind".into(),
                    json!(if matches!(kind, Kind::Check(_)) {
                        "check"
                    } else {
                        "cross"
                    }),
                );
                if let Some(t) = t {
                    m.insert("on".into(), json!([show(&ts[*t].key)]));
                    anchored.push(*t);
                }
            }
            Kind::Writing | Kind::Ink => {
                m.insert(
                    "kind".into(),
                    json!(if matches!(kind, Kind::Writing) {
                        "writing"
                    } else {
                        "ink"
                    }),
                );
                if let Some(h) = &g.hint {
                    m.insert("text_guess".into(), json!(h.text));
                    m.insert(
                        "confidence".into(),
                        json!((h.confidence * 100.0).round() / 100.0),
                    );
                }
                // Near the closest Mark or Element: a note beside an arrow is about the arrow.
                let el = ts
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.typ != "connector")
                    .map(|(i, t)| {
                        (
                            box_gap(t.bounds, g.bounds) + if is_container(t) { 200.0 } else { 0.0 },
                            i,
                        )
                    })
                    .min_by(|a, b| a.0.total_cmp(&b.0));
                let mk = placed
                    .iter()
                    .map(|(mid, b)| (box_gap(*b, g.bounds), mid))
                    .min_by(|a, b| a.0.total_cmp(&b.0));
                match (el, mk) {
                    (_, Some((d, mid))) if d <= 120.0 && el.is_none_or(|(e, _)| d < e) => {
                        m.insert("near".into(), json!(mid));
                    }
                    (Some((d, i)), _) if d <= 400.0 => {
                        m.insert("near".into(), json!(show(&ts[i].key)));
                    }
                    _ => {}
                }
            }
        }
        m.insert("bounds".into(), json!(ib(g.bounds)));
        // Say when a target moved or went away after the Mark was drawn.
        for &i in &anchored {
            match current.get(&ts[i].key) {
                Some(b) if ib(*b) != ib(ts[i].bounds) => {
                    m.insert("moved_since_marked".into(), json!(true));
                    m.insert("marked_at".into(), json!(ib(ts[i].bounds)));
                    break;
                }
                None => {
                    m.insert(
                        "note".into(),
                        json!(format!(
                            "'{}' was removed after this was marked.",
                            show(&ts[i].key)
                        )),
                    );
                    break;
                }
                _ => {}
            }
        }
        let skeys: Vec<&str> = g.strokes.iter().map(|&i| strokes[i].key.as_str()).collect();
        if let Some((_, el, anchor)) = embed.iter().find(|(ss, el, _)| {
            ss.iter().any(|s| skeys.contains(&s.as_str()))
                && anchored.iter().any(|&i| &ts[i].key == el)
        }) {
            let _ = el;
            m.insert("target".into(), anchor.clone());
        }
        m.insert(
            "strokes".into(),
            json!(skeys.iter().map(|k| show(k)).collect::<Vec<_>>()),
        );
        m.insert(
            "at".into(),
            json!(g
                .strokes
                .iter()
                .map(|&i| strokes[i].start)
                .min()
                .unwrap_or(0)),
        );
        m.insert(
            "end".into(),
            json!(g.strokes.iter().map(|&i| strokes[i].end).max().unwrap_or(0)),
        );
        placed.push((id, g.bounds));
        out.push(Value::Object(m));
    }
    json!({ "send": send.get("send"), "marks": out })
}
