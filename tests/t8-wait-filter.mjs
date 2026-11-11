#!/usr/bin/env node
// T8: wait_for_user's filters must match the Element IDs the Agent itself uses.
//
// protocol/tool-text/wait_for_user.md and extensions/guides/behaviors.md tell an Agent:
// "Notify arrives through wait_for_user; wait with element: 't-auth' to wait for a tap on
// that Element only." An Agent names its own Elements by their short IDs.
//
//   node tests/t8-wait-filter.mjs
import { spawn } from "node:child_process";
import { AGENT, startLink } from "./t8-link.mjs";

const { env, json, person, stop } = await startLink(7457);
const fail = (why, extra) => {
  console.log(`FAIL: ${why}${extra ? `\n${extra}` : ""}`);
  stop();
  process.exit(1);
};

try {
  json(["spaces", "create", "plan"]);
  json([
    "elements",
    "apply",
    "plan",
    "--ops",
    JSON.stringify([
      { op: "add", type: "note", id: "btn", text: "press me", at: { x: 100, y: 100 }, w: 200, h: 80, behaviors: [{ on: "tap", do: "notify", payload: { pressed: true } }] },
    ]),
  ]);

  // The Agent waits for a tap on its own Element, named the way it named it.
  const waiting = spawn(process.execPath, ["agent/bin/reflex.mjs", "wait", "--element", "btn", "--timeout", "8", "--json"], {
    env: { ...env, REFLEX_AGENT_NAME: AGENT },
    encoding: "utf8",
  });
  let out = "";
  waiting.stdout.on("data", (d) => (out += d));
  await new Promise((r) => setTimeout(r, 2500));

  const fired = person(["tap", "plan", "btn"]);
  if (fired.kind !== "tap") fail(`the tap froze as kind '${fired.kind}'`, JSON.stringify(fired));

  await new Promise((r) => waiting.on("exit", r));
  const got = JSON.parse(out.trim().split("\n").pop());
  if (got.status === "still_waiting")
    fail(
      `wait_for_user(element: 'btn') returned still_waiting although the tap ${fired.send} on 'btn' is in this Agent's Inbox (pending_sends: ${got.pending_sends})`,
      JSON.stringify(got),
    );
  if (got.element !== "btn") fail(`the tap Bundle names its Element '${got.element}', not 'btn'`, JSON.stringify(got));
  console.log(`PASS: wait_for_user(element: 'btn') returned the tap ${got.send} on ${got.element}`);
  stop();
  process.exit(0);
} catch (e) {
  fail(String(e?.stack ?? e));
}
