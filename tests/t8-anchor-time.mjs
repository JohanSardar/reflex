#!/usr/bin/env node
// T8: a Mark's Anchors are frozen when it is drawn (ARCHITECTURE §4.3, §7.5).
//
// "Anchors are frozen when the Mark is drawn. If the target moves before the Send, the
// Bundle shows both the original and the current position, plus a moved_since_marked flag."
// So circling a node, dragging it, then pressing Send must still come back as a circle on
// that node, with marked_at where it was.
//
//   node tests/t8-anchor-time.mjs
import { startLink } from "./t8-link.mjs";

const { json, person, stop } = await startLink(7459);
const fail = (why, extra) => {
  console.log(`FAIL: ${why}${extra ? `\n${extra}` : ""}`);
  stop();
  process.exit(1);
};

try {
  json(["spaces", "create", "plan"]);
  json(["elements", "apply", "plan", "--ops", JSON.stringify([{ op: "add", type: "note", id: "node", text: "the auth node", at: { x: 100, y: 100 }, w: 180, h: 80 }])]);
  // The person circles the node, then nudges it down, then presses Send.
  person(["circle", "plan", "node"]);
  person(["move", "plan", "node", "--by", "0,600"]);
  const sent = person(["send", "plan"]);
  const bundle = json(["wait", "--timeout", "5"]);
  if (bundle.send !== sent.send) fail(`waited for ${bundle.send}, not the Send ${sent.send}`);
  const m = (bundle.marks ?? [])[0];
  if (!m) fail("the Send has no Marks", JSON.stringify(bundle.marks));
  if (m.kind !== "circle") fail(`the circle came back as '${m.kind}'`, JSON.stringify(m));
  if (!(m.on ?? []).includes("node")) fail(`the circle names no Anchor (on: ${JSON.stringify(m.on)}), so the Agent cannot tell what was circled`, JSON.stringify(m));
  if (m.moved_since_marked !== true) fail("the Mark does not say the node moved after it was drawn", JSON.stringify(m));
  console.log(`PASS: ${m.id} circle on ${m.on.join(", ")} moved_since_marked, marked_at ${JSON.stringify(m.marked_at)}`);
  stop();
  process.exit(0);
} catch (e) {
  fail(String(e?.stack ?? e));
}
