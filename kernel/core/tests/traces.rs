//! Runs the kernel convergence traces in `tests/traces/`.
//!
//! Each trace is a list of steps over named replicas: Agent batches, user
//! intents, sync (the Automerge sync protocol, pairwise until quiet), restarts
//! (save, drop, load) and expectations. Expected values come from the rules in
//! ARCHITECTURE §3 and §7 and ADR-0008, written by hand in each trace.

use reflex_kernel::Space;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

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

fn sync_pair(a: &mut Space, an: &str, b: &mut Space, bn: &str) {
    for _ in 0..20 {
        let m1 = a.sync_message(bn);
        if let Some(m) = &m1 {
            b.receive_sync_message(an, m).unwrap();
        }
        let m2 = b.sync_message(an);
        if let Some(m) = &m2 {
            a.receive_sync_message(bn, m).unwrap();
        }
        if m1.is_none() && m2.is_none() {
            return;
        }
    }
    panic!("sync between {an} and {bn} did not settle");
}

fn ids(space: &Space) -> Vec<String> {
    let s: Value = serde_json::from_str(&space.scene("{}").unwrap()).unwrap();
    s["elements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_string())
        .collect()
}

fn check_result(name: &str, i: usize, result: &str, expect: &Value) {
    let r: Value = serde_json::from_str(result).unwrap();
    assert_eq!(r["ok"], expect["ok"], "{name} step {i}: {result}");
    if let Some(code) = expect.get("code") {
        let codes: Vec<&Value> = r["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| &e["code"])
            .collect();
        assert!(
            codes.contains(&code),
            "{name} step {i}: expected {code}, got {result}"
        );
    }
    if let Some(d) = expect.get("duplicate") {
        assert_eq!(&r["duplicate"], d, "{name} step {i}: {result}");
    }
}

fn run(path: PathBuf) {
    let trace: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    let space_id = trace["space"].as_str().unwrap();
    let mut reps: BTreeMap<String, Space> = trace["replicas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let r = r.as_str().unwrap();
            (
                r.to_string(),
                Space::create(space_id, "space", &actor(r)).unwrap(),
            )
        })
        .collect();
    let mut now = 1_700_000_000_000i64;
    for (i, step) in trace["steps"].as_array().unwrap().iter().enumerate() {
        now += 1000;
        if let Some(names) = step.get("sync").and_then(|v| v.as_array()) {
            let names: Vec<String> = names
                .iter()
                .map(|n| n.as_str().unwrap().to_string())
                .collect();
            for _round in 0..2 {
                for x in 0..names.len() {
                    for y in x + 1..names.len() {
                        let mut a = reps.remove(&names[x]).unwrap();
                        let mut b = reps.remove(&names[y]).unwrap();
                        sync_pair(&mut a, &names[x], &mut b, &names[y]);
                        reps.insert(names[x].clone(), a);
                        reps.insert(names[y].clone(), b);
                    }
                }
            }
            continue;
        }
        if let Some(r) = step.get("restart").and_then(|v| v.as_str()) {
            let bytes = reps.remove(r).unwrap().save();
            reps.insert(r.to_string(), Space::load(&bytes, &actor(r)).unwrap());
            continue;
        }
        if step.get("converged").is_some() {
            let digests: Vec<(String, String, String)> = reps
                .iter()
                .map(|(n, s)| (n.clone(), s.digest(), s.heads()))
                .collect();
            for d in &digests[1..] {
                assert_eq!(
                    d.1, digests[0].1,
                    "{name} step {i}: {} and {} disagree",
                    d.0, digests[0].0
                );
                assert_eq!(d.2, digests[0].2, "{name} step {i}: heads differ");
            }
            continue;
        }
        let on = step["on"].as_str().unwrap();
        let sp = reps.get_mut(on).unwrap();
        if let Some(agent) = step.get("agent").and_then(|v| v.as_str()) {
            let r = sp
                .apply_agent_batch(
                    agent,
                    step["request"].as_str().unwrap(),
                    &step["batch"].to_string(),
                    now,
                )
                .unwrap();
            check_result(&name, i, &r, &step["expect"]);
        } else if let Some(person) = step.get("person").and_then(|v| v.as_str()) {
            let r = sp
                .apply_user_intent(
                    person,
                    step["device"].as_str().unwrap(),
                    &step["intent"].to_string(),
                    now,
                )
                .unwrap();
            check_result(&name, i, &r, &step["expect"]);
        } else if let Some(want) = step.get("expect_present") {
            let have = ids(sp);
            for w in want.as_array().unwrap() {
                assert!(
                    have.iter().any(|h| h == w.as_str().unwrap()),
                    "{name} step {i}: {w} missing from {have:?}"
                );
            }
        } else if let Some(want) = step.get("expect_absent") {
            let have = ids(sp);
            for w in want.as_array().unwrap() {
                assert!(
                    !have.iter().any(|h| h == w.as_str().unwrap()),
                    "{name} step {i}: {w} still in {have:?}"
                );
            }
        } else if let Some(n) = step.get("expect_count") {
            assert_eq!(
                ids(sp).len() as u64,
                n.as_u64().unwrap(),
                "{name} step {i}: {:?}",
                ids(sp)
            );
        } else if let Some(want) = step.get("expect_text").and_then(|v| v.as_object()) {
            let s: Value = serde_json::from_str(&sp.scene("{}").unwrap()).unwrap();
            for (id, text) in want {
                let el = s["elements"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["id"] == id.as_str())
                    .unwrap();
                assert_eq!(&el["text"], text, "{name} step {i}");
            }
        } else {
            panic!("{name} step {i}: unknown step {step}");
        }
    }
}

#[test]
fn traces() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/traces");
    let mut n = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "json") {
            run(path);
            n += 1;
        }
    }
    assert!(n > 0);
}
