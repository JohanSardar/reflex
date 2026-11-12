//! A draggable Element's `snap.to` names the Elements it drops into
//! (extensions/guides/planning.md, extensions/recipes/week-planner.md: the block's
//! `snap: { to: ["day-mon", …], grid: 25 }`). The iPad matches those IDs against the
//! IDs in the scene the kernel projects for the person
//! (apps/ipad/Reflex/SpaceSession.swift `snapped`, LinkSync.swift `scene`), so every
//! ID in `snap.to` has to name an Element as the person sees it.

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
fn a_draggable_blocks_snap_targets_are_the_ids_the_person_sees() {
    let mut sp = Space::create("week", "space", &actor("p")).unwrap();
    // The Agent lays out the week and adds a block that snaps into the Monday column.
    let batch = json!({ "ops": [
        { "op": "add", "type": "frame", "id": "day-mon", "title": "Mon", "w": 150, "h": 600, "at": { "x": 100, "y": 100 } },
        { "op": "add", "type": "shape", "id": "evt-standup", "shape": "rounded", "text": "Standup",
          "w": 138, "h": 25, "at": { "x": 106, "y": 135 }, "draggable": true,
          "snap": { "to": ["day-mon"], "grid": 25 } },
    ] });
    let r = sp
        .apply_agent_batch("a1", "r1", &batch.to_string(), 1_700_000_000_000)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&r).unwrap()["ok"],
        true,
        "{r}"
    );

    // Exactly what the iPad asks for: the scene for this person (LinkSync.swift `scene`).
    let q = json!({ "detail": "full", "viewer": { "person": "p1" } });
    let scene: Value = serde_json::from_str(&sp.scene(&q.to_string()).unwrap()).unwrap();
    let elements = scene["elements"].as_array().unwrap();
    let ids: Vec<&str> = elements.iter().filter_map(|e| e["id"].as_str()).collect();
    let block = elements
        .iter()
        .find(|e| e["type"] == "shape")
        .expect("the block is in the scene");
    let to = block["snap"]["to"].as_array().expect("snap.to is set");
    for t in to {
        let id = t.as_str().unwrap();
        assert!(
            ids.contains(&id),
            "snap.to names '{id}', which is not an ID in the person's scene ({ids:?}); the iPad's snapped() matches snap.to against the scene's IDs, so the block never snaps into its column"
        );
    }
}
