#!/usr/bin/env node
// T15: when the surface decides the session has no channel, it must not also tell the
// Agent that Sends are pushed to it.
//
// `reflex mcp --channel` opens no push target unless the session's command line has a
// channels flag (agent/src/surfaces/mcp.ts, sessionHasChannels), because Claude Code drops
// a channel it wasn't told to load. The instructions it sends in the initialize response
// say "Sends are also pushed to you ... You don't need to sit in wait_for_user to hear from
// the person" whenever --channel is given. A session with --channel but started without the
// flag therefore tells the Agent not to wait, while nothing is ever pushed: the person's Send
// then sits in the Inbox with nobody to read it. wait_for_user is the guarantee (ADR-0002),
// so the instructions must match what the surface decided.
//
//   node tests/t15-push-instructions.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reflex-t15-"));
const env = { ...process.env, REFLEX_HOME: dir };
const fail = (why, extra) => {
  console.log(`FAIL: ${why}${extra ? `\n${extra}` : ""}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};
const stop = () => rmSync(dir, { recursive: true, force: true });

// No channels flag anywhere in this process's ancestry: this is `claude` started without it.
const mcp = spawn(process.execPath, ["agent/bin/reflex.mjs", "mcp", "--channel"], { env, stdio: ["pipe", "pipe", "inherit"] });
const timer = setTimeout(() => fail("the MCP surface never answered initialize"), 30000);
let buf = "";
const frames = [];
mcp.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    try {
      frames.push(JSON.parse(buf.slice(0, i)));
    } catch {}
    buf = buf.slice(i + 1);
  }
});
mcp.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.322" } } }) + "\n",
);
for (let i = 0; i < 200 && !frames.length; i++) await new Promise((r) => setTimeout(r, 100));
clearTimeout(timer);
const init = frames.find((f) => f.id === 1)?.result;
if (!init) fail("no initialize response", buf);

mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
await new Promise((r) => setTimeout(r, 800));
const events = readFileSync(join(dir, "mcp.log"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((l) => /^channel_/.test(l.event))
  .map((l) => l.event);
mcp.kill("SIGKILL");

if (!events.includes("channel_off")) fail(`the surface did not decide the channel is off: ${JSON.stringify(events)}`);
const advertises = /Sends are also pushed to you/i.test(init.instructions ?? "");
if (advertises)
  fail(
    "the surface logged channel_off (no push target, as intended) but its instructions still tell the Agent that Sends are pushed to it and that it need not sit in wait_for_user",
    JSON.stringify((init.instructions ?? "").slice(-420)),
  );
console.log("PASS: with no channel the instructions leave wait_for_user as the way to hear from the person");
stop();
process.exit(0);
