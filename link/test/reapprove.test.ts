// A revoked Agent asks the person again. `admin.key` can only deny and revoke
// (an Agent with the user's shell must not approve itself), so the person's
// second chance is the iPad's Allow or `y` in the Link's terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { startAgentHost } from "../agent-host.ts";
import { Catalog, type AgentRecord } from "../pairing/catalog.ts";
import { newDeviceKey } from "../pairing/crypto.ts";
import { AssetStore } from "../storage/assets.ts";
import { openDb } from "../storage/db.ts";
import { Inbox } from "../storage/inbox.ts";
import { SpaceStore } from "../storage/journal.ts";

// These tests are about asking again, not about how long the Link waits before it may (agent-host.ts).
process.env.REFLEX_REASK_S = "0";

/** What `reflex mcp` and the CLI do on the Agent layer's socket. */
class Surface {
  #sock: ReturnType<typeof connect>;
  #next = 1;
  #buf = "";
  #waiting = new Map<number, (f: Record<string, any>) => void>();
  #ready: Promise<void>;

  constructor(socket: string, token: string) {
    this.#sock = connect(socket);
    this.#ready = new Promise((resolve) => {
      this.#sock.on("data", (d) => {
        this.#buf += d;
        for (let i; (i = this.#buf.indexOf("\n")) >= 0; ) {
          const f = JSON.parse(this.#buf.slice(0, i));
          this.#buf = this.#buf.slice(i + 1);
          if (f.t === "ready") resolve();
          else this.#waiting.get(f.id)?.(f);
        }
      });
      this.#sock.on("error", () => {});
      this.#sock.write(JSON.stringify({ t: "hello", token, client: "test" }) + "\n");
    });
  }

  async call(tool: string, args: unknown, who: { name: string; credential: string }) {
    await this.#ready;
    const id = this.#next++;
    const answer = new Promise<Record<string, any>>((resolve) => this.#waiting.set(id, resolve));
    this.#sock.write(JSON.stringify({ t: "call", id, tool, args, who }) + "\n");
    return answer;
  }

  close() {
    this.#sock.destroy();
  }
}

test("a revoked Agent is asked about again, and the person can let it back in", async () => {
  const dir = mkdtempSync("/tmp/reflex-reapprove-");
  const db = openDb(join(dir, "link.db"));
  const inbox = new Inbox(db);
  const store = new SpaceStore(db, "aa".repeat(16), inbox);
  const catalog = new Catalog(db, newDeviceKey().key);
  const asked: AgentRecord[] = [];
  const host = await startAgentHost({
    db,
    home: dir,
    store,
    inbox,
    assets: new AssetStore(join(dir, "assets")),
    catalog,
    person: { id: "p_me", name: "Me" },
    socket: join(dir, "agent.sock"),
    token: "t".repeat(32),
    // The person, answering on the iPad or in the terminal.
    announce: (a) => {
      asked.push(a);
      setTimeout(() => catalog.decide(a.id, "approved", "terminal"), 10);
    },
    decision: async (id) => {
      const start = Date.now();
      while (catalog.agent(id)?.status === "pending" && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
    },
    log: () => {},
  });
  const who = { name: "Claude Code · test", credential: "c".repeat(40) };
  try {
    const first = new Surface(join(dir, "agent.sock"), "t".repeat(32));
    const r1 = await first.call("wait_for_user", { timeout_s: 0 }, who);
    assert.equal(r1.isError, false, `the person's Allow did not let the Agent in: ${JSON.stringify(r1.json)}`);
    first.close();

    // The person changes their mind: `reflex link revoke <agent>`.
    catalog.decide(asked[0].id, "revoked", "command");

    const second = new Surface(join(dir, "agent.sock"), "t".repeat(32));
    const r2 = await second.call("wait_for_user", { timeout_s: 0 }, who);
    second.close();
    assert.equal(asked.length, 2, "the person was never asked about the revoked Agent again");
    assert.equal(r2.isError, false, `the revoked Agent could not be let back in: ${JSON.stringify(r2.json)}`);
  } finally {
    await new Promise<void>((r) => host.server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
