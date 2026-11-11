// Stopping the Link while an Agent surface is connected (an MCP session holds
// `agent.sock` open for as long as the harness runs) must still finish: Ctrl-C
// in the Link's terminal is how a person restarts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Link } from "../link.ts";

test("stopping the Link with an Agent surface connected finishes", async () => {
  const dir = mkdtempSync("/tmp/reflex-link-stop-");
  const link = new Link({ dir, port: 0, prompt: false });
  let sock: ReturnType<typeof connect> | undefined;
  try {
    await link.start();
    sock = connect(join(dir, "agent.sock"));
    // What `reflex mcp` and the CLI do: present `rpc.key` and stay connected.
    const s = sock;
    s.write(JSON.stringify({ t: "hello", token: readFileSync(join(dir, "rpc.key"), "utf8").trim(), client: "stop-test" }) + "\n");
    await new Promise((resolve) => s.once("data", resolve));

    const stopped = await Promise.race([
      link.stop().then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("still running"), 5_000)),
    ]);
    assert.equal(stopped, "stopped", "`reflex link` never finishes stopping while an Agent surface is connected");
  } finally {
    sock?.destroy();
    await link.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
