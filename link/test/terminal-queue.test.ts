// A person who turned an Agent away with `reflex link deny` (or on their iPad) must
// still be asked, in the Link's own terminal, when that Agent asks again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { connect } from "node:net";
import { join } from "node:path";
import { Link } from "../link.ts";
import { LinkClient } from "../rpc/client.ts";

// These tests are about asking again, not about how long the Link waits before it may (agent-host.ts).
process.env.REFLEX_REASK_S = "0";

/** Stands in for the person's terminal: a TTY stdin, and its output captured. */
function terminal(): { out: () => string; restore: () => void } {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: true });
  const realIn = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  const chunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => (chunks.push(String(c)), true)) as typeof process.stdout.write;
  return {
    out: () => chunks.join(""),
    restore: () => {
      process.stdout.write = realOut as typeof process.stdout.write;
      Object.defineProperty(process, "stdin", realIn);
    },
  };
}

const until = async (what: string, ms: number, p: () => boolean): Promise<void> => {
  const start = Date.now();
  while (!p()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** What `reflex mcp` and the CLI do on the Agent layer's socket. */
async function surface(dir: string, who: { name: string; credential: string }) {
  const s = connect(join(dir, "agent.sock"));
  const frames: string[] = [];
  let buf = "";
  s.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      frames.push(JSON.parse(buf.slice(0, i)).t);
      buf = buf.slice(i + 1);
    }
  });
  s.on("error", () => {});
  s.write(JSON.stringify({ t: "hello", token: readFileSync(join(dir, "rpc.key"), "utf8").trim(), client: "terminal-test" }) + "\n");
  await until("the surface to be ready", 2000, () => frames.includes("ready"));
  s.write(JSON.stringify({ t: "call", id: 1, tool: "list_spaces", args: {}, who }) + "\n");
  return { close: () => s.destroy() };
}

test("the terminal asks again when a denied Agent asks again, after the person answered elsewhere", async () => {
  const dir = mkdtempSync("/tmp/reflex-terminal-queue-");
  const t = terminal();
  const link = new Link({ dir, port: 0, prompt: true, log: () => {} });
  const who = { name: "Claude Code · one", credential: "c".repeat(40) };
  const surfaces: { close: () => void }[] = [];
  try {
    await link.start();
    surfaces.push(await surface(dir, who));
    await until("the Link's terminal to ask about the Agent", 3000, () => t.out().includes('Allow "Claude Code · one"'));

    // The person answers somewhere other than this terminal: `reflex link deny <agent>`.
    const admin = await LinkClient.connect(dir, "admin");
    const [{ id }] = await admin.call<{ id: string }[]>("agents.list");
    await admin.call("agents.decide", { id, status: "denied" });
    admin.close();

    // The Agent asks again, as it is told to.
    const before = t.out().length;
    surfaces.push(await surface(dir, who));
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(
      t.out().slice(before).includes('Allow "Claude Code · one"'),
      `the Link's terminal never asked about the Agent again, so a person without an iPad cannot let it back in:\n${JSON.stringify(t.out().slice(before))}`,
    );
  } finally {
    for (const s of surfaces) s.close();
    t.restore();
    await link.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
