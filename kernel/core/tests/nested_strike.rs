//! A plain line that starts on the page image and ends on the proposed mark the page holds is a
//! strike naming that mark, not an arrow and not a bare ink line
//! (extensions/guides/grading.md: "Rejected: a `strike` (or `cross`) Mark with `on: ["pm-q2"]`";
//! looks at the mark the same way kernel/core/src/marks.rs's `nested` branch does).

use reflex_kernel::Space;
use serde_json::{json, Value};

fn actor(name: &str) -> String {
    let mut h = format!("{:x}", name.len() + 0x10);
    for b in name.bytes() {
        h.push_str(&format!("{b:02x}"));
    }
    while h.len() < 16 {
        h.push('0');
    }
    h[..h.len().min(64)].to_string()
}

#[test]
fn a_line_from_a_page_onto_the_mark_it_holds_is_a_strike() {
    let mut sp = Space::create("grading-strike", "space", &actor("p")).unwrap();
    let batch = json!({ "ops": [
        // The scanned page the grade-paper recipe places.
        { "op": "add", "id": "paper", "type": "image", "src": "https://example.com/quiz.png", "w": 800, "h": 1000, "at": { "x": 0, "y": 0 } },
        // A proposed mark the Agent put on the page: [100, 200, 120, 40].
        { "op": "add", "id": "pm-q2", "type": "text", "text": "✗ −1 used d, not r", "size": "m", "w": 120, "h": 40, "at": { "x": 100, "y": 200 } },
    ] });
    let r = sp
        .apply_agent_batch("a1", "r1", &batch.to_string(), 1_700_000_000_000)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&r).unwrap()["ok"],
        true,
        "{r}"
    );

    // The teacher strikes it out: one straight pen stroke from the page (40, 220) that stops on the
    // mark (150, 220). A headless line, so it is not an arrow.
    let intent = json!({
        "intent": "add_stroke",
        "id": "s1",
        "stroke": { "points": [[40, 220], [100, 220], [150, 220]] },
        "color": "red",
    });
    let r = sp
        .apply_user_intent("p1", "dev", &intent.to_string(), 1_700_000_100_000)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&r).unwrap()["ok"],
        true,
        "{r}"
    );

    let send = json!({ "send": "send1", "trigger": "button", "viewport": [0, 0, 1366, 1024] });
    sp.freeze_send("p1", "dev", &send.to_string(), 1_700_000_200_000)
        .unwrap();

    let m: Value = serde_json::from_str(&sp.marks("send1", "{}").unwrap()).unwrap();
    let mark = m["marks"]
        .as_array()
        .and_then(|a| a.first())
        .unwrap_or(&Value::Null)
        .clone();
    assert_eq!(
        mark["kind"], "strike",
        "the rejected mark has to come back as a strike; got {mark}"
    );
    assert_eq!(
        mark["on"],
        json!(["a1:pm-q2"]),
        "the strike has to name the mark it was drawn on; got {mark}"
    );
}
