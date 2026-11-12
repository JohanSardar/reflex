//! An Embed that holds prose says whether a flat line across its text is a strike or an
//! underline (extensions/embeds/document/index.html: `gesture: "strike" | "underline"`;
//! extensions/guides/writing-review.md: "a strike or underline: quote is the words it runs
//! along; gesture: "strike" usually means cut or replace them, gesture: "underline" questions or
//! stresses them"). A long underline under a sentence in the middle of the page also reads
//! as "a straight line through the middle of one Element", so the Embed's answer has to win.

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
fn an_underline_the_embed_reports_is_not_a_strike() {
    let mut sp = Space::create("paper", "space", &actor("p")).unwrap();
    let batch = json!({ "ops": [
        { "op": "add", "type": "embed", "id": "essay", "template": "document",
          "w": 820, "h": 760, "at": { "x": 100, "y": 100 } },
    ] });
    let r = sp
        .apply_agent_batch("a1", "r1", &batch.to_string(), 1_700_000_000_000)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&r).unwrap()["ok"],
        true,
        "{r}"
    );

    // The person underlines a long sentence in the middle of the page: one straight, flat
    // stroke 500 wide at y = 480, inside the page.
    let intent = json!({
        "intent": "add_stroke",
        "id": "s1",
        "stroke": { "points": [[150, 480], [350, 480], [650, 480]] },
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

    // The document Embed answers what the stroke is on, as its `resolve` does for a flat
    // line along the bottom of the words.
    let send = json!({
        "send": "send1",
        "trigger": "button",
        "viewport": [0, 0, 1366, 1024],
        "embed_anchors": [{
            "element": "a1:essay",
            "strokes": ["s1"],
            "anchor": { "kind": "text", "paragraphs": ["p1"], "sentences": ["p1.s1"],
                        "quote": "a sentence the person underlined", "gesture": "underline",
                        "label": "underlined p1.s1" }
        }]
    });
    sp.freeze_send("p1", "dev", &send.to_string(), 1_700_000_200_000)
        .unwrap();

    let m: Value = serde_json::from_str(&sp.marks("send1", "{}").unwrap()).unwrap();
    let mark = m["marks"]
        .as_array()
        .and_then(|a| a.first())
        .unwrap_or(&Value::Null)
        .clone();
    assert_eq!(
        mark["kind"], "underline",
        "the Embed said the person underlined the words, so the Mark has to be an underline; got {mark}"
    );
}
