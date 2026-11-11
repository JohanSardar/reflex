//! A Send from a Region marks the lines an earlier Send from it carried
//! (`earlier: true`) in watch snapshots too, not only in a Region's Send button
//! (extensions/guides/marks.md: "trigger \"region\", or a watch snapshot").

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

/// One small stroke at `y`, as the person's handwriting on one line.
fn stroke(sp: &mut Space, id: &str, y: i64, now: i64) {
    let intent = json!({
        "intent": "add_stroke",
        "id": id,
        "stroke": { "points": [[40, y], [60, y - 10], [80, y]] },
        "color": "red",
    });
    let r = sp
        .apply_user_intent("p1", "dev", &intent.to_string(), now)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&r).unwrap()["ok"],
        true,
        "{r}"
    );
}

fn marks(sp: &Space, send: &str) -> Value {
    serde_json::from_str(&sp.marks(send, "{}").unwrap()).unwrap()
}

#[test]
fn watch_snapshot_marks_lines_an_earlier_send_carried() {
    let mut sp = Space::create("watch-earlier", "space", &actor("p")).unwrap();
    let mut now = 1_700_000_000_000i64;
    let batch = json!({ "ops": [{ "op": "add", "id": "work", "type": "region", "title": "Work", "w": 900, "h": 700, "watch": true }] });
    let r = sp
        .apply_agent_batch("a1", "r1", &batch.to_string(), now)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&r).unwrap()["ok"],
        true,
        "{r}"
    );

    now += 1000;
    stroke(&mut sp, "a", 200, now);
    now += 100;
    stroke(&mut sp, "b", 205, now);

    // The person presses the Region's Check: it carries line 1 and claims it.
    now += 1000;
    let check = json!({
        "send": "s1",
        "trigger": "region",
        "region": "a1:work",
        "hints": [{ "strokes": ["a", "b"], "text": "3x - 7 = 2x + 5", "confidence": 0.9 }],
    });
    sp.freeze_send("p1", "dev", &check.to_string(), now)
        .unwrap();

    // They write line 2, and the watched Region sends a snapshot with both lines.
    now += 1000;
    stroke(&mut sp, "c", 320, now);
    now += 100;
    stroke(&mut sp, "d", 325, now);
    now += 1000;
    let watch = json!({
        "send": "s2",
        "trigger": "watch",
        "region": "a1:work",
        "user_still_writing": false,
        "hints": [{ "strokes": ["c", "d"], "text": "x = 6", "confidence": 0.8 }],
    });
    sp.freeze_send("p1", "dev", &watch.to_string(), now)
        .unwrap();

    let m = marks(&sp, "s2");
    let ms = m["marks"].as_array().unwrap();
    assert_eq!(ms.len(), 2, "one Mark per line: {m}");
    assert_eq!(ms[0]["line"], 1, "{m}");
    assert_eq!(
        ms[0]["text_guess"], "3x - 7 = 2x + 5",
        "line 1 keeps the earlier Send's reading: {m}"
    );
    assert_eq!(
        ms[0]["earlier"],
        json!(true),
        "line 1 was carried by the earlier Check, so it is not new: {m}"
    );
    assert!(ms[1].get("earlier").is_none(), "line 2 is new: {m}");
    assert_eq!(ms[1]["text_guess"], "x = 6", "{m}");
}
