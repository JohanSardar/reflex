// A Send that arrives between the view's waits is pushed to `reflex mcp`, which holds it for the view's
// next wait_for_user (link/adapters/mcp-app.ts, agent/src/surfaces/mcp.ts).
//
// The view's next wait is the one it makes right after posting a Send to the chat, and that one carries
// `after` (app-view.ts acknowledges the Send it just posted). It must still get the held Send; otherwise
// the push expires at its 5 s deadline and the person's Send only reaches the chat on some later wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { startAgentHost } from "../agent-host.ts";
import { recipient } from "../routing.ts";
import { Catalog } from "../pairing/catalog.ts";
import { newDeviceKey } from "../pairing/crypto.ts";
import { AssetStore } from "../storage/assets.ts";
import { openDb } from "../storage/db.ts";
import { Inbox } from "../storage/inbox.ts";
import { SpaceStore } from "../storage/journal.ts";

const TOKEN = "t".repeat(32);

/** What the person's iPad does through the Link: press Send (a Link started with --dev). */
class Person {
  #sock: ReturnType<typeof connect>;
  #next = 1;
  #buf = "";
  #waiting = new Map<number, (f: Record<string, any>) => void>();
  #ready: Promise<void>;

  constructor(socket: string) {
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
      this.#sock.write(JSON.stringify({ t: "hello", token: TOKEN, client: "person" }) + "\n");
    });
  }

  async send(space: string, said: string): Promise<string> {
    await this.#ready;
    const id = this.#next++;
    const answer = new Promise<Record<string, any>>((resolve) => this.#waiting.set(id, resolve));
    this.#sock.write(JSON.stringify({ t: "person", id, action: "send", args: { space, said } }) + "\n");
    return (await answer).json.send as string;
  }

  close() {
    this.#sock.destroy();
  }
}

/** A chat host that renders MCP Apps, speaking MCP to `reflex mcp` on stdio. */
class ChatHost {
  #child: ReturnType<typeof spawn>;
  #buf = "";
  #next = 1;
  #waiting = new Map<number, (f: Record<string, any>) => void>();

  constructor(home: string) {
    this.#child = spawn(process.execPath, [new URL("../../agent/bin/reflex.mjs", import.meta.url).pathname, "mcp"], {
      env: { ...process.env, REFLEX_HOME: home, REFLEX_AGENT_NAME: "Chat Host", REFLEX_PROGRESS_S: "30" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr!.on("data", () => {});
    this.#child.stdout!.on("data", (d) => {
      this.#buf += d;
      for (let i; (i = this.#buf.indexOf("\n")) >= 0; ) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        if (!line.trim()) continue;
        const f = JSON.parse(line);
        if (f.id !== undefined && f.method === undefined) this.#waiting.get(f.id)?.(f);
      }
    });
  }

  #write(msg: Record<string, any>) {
    this.#child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: unknown): Promise<Record<string, any>> {
    const id = this.#next++;
    const answer = new Promise<Record<string, any>>((resolve) => this.#waiting.set(id, resolve));
    this.#write({ jsonrpc: "2.0", id, method, params });
    return answer;
  }

  async start(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      // What an MCP Apps host (Claude Desktop, the reference host) declares.
      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
      clientInfo: { name: "test-chat-host", version: "0.1.0" },
    });
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  /** One `tools/call`, as the view makes it through its host. */
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const r = await this.request("tools/call", { name, arguments: args });
    return JSON.parse((r.result.content as any[]).find((c) => c.type === "text").text);
  }

  close() {
    this.#child.kill();
  }
}

/** What `reflex mcp` writes to <home>/mcp.log (agent/src/host/rpc.ts, logPath). */
const mcpLog = (home: string) => (existsSync(join(home, "mcp.log")) ? readFileSync(join(home, "mcp.log"), "utf8") : "");

const until = async (what: string, ms: number, p: () => boolean) => {
  const start = Date.now();
  while (!p()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("a Send pushed while the view posts the last one reaches the view's next wait", async () => {
  const dir = mkdtempSync("/tmp/reflex-app-push-");
  writeFileSync(join(dir, "rpc.key"), TOKEN, { mode: 0o600 });
  const db = openDb(join(dir, "link.db"));
  const inbox = new Inbox(db);
  const store = new SpaceStore(db, "aa".repeat(16), inbox);
  const catalog = new Catalog(db, newDeviceKey().key);
  const host = await startAgentHost({
    db,
    home: dir,
    store,
    inbox,
    assets: new AssetStore(join(dir, "assets")),
    catalog,
    person: { id: "p_me", name: "Me" },
    socket: join(dir, "agent.sock"),
    token: TOKEN,
    devPerson: true,
    announce: (a) => setTimeout(() => catalog.decide(a.id, "approved", "terminal"), 5),
    decision: async (id) => {
      const start = Date.now();
      while (catalog.agent(id)?.status === "pending" && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 5));
    },
    log: () => {},
  });
  const person = new Person(join(dir, "agent.sock"));
  const chat = new ChatHost(dir);
  try {
    await chat.start();
    const opened = await chat.call("open_space", { space: "s1", create: true });
    const agent = opened.you.agent as string;
    await until("the mcp-app push target to be live", 5000, () => host.pushes.all().some((t) => t.adapter === "mcp-app" && host.live(t)));

    // The person presses Send while the view sits in no wait: the Link pushes it, and `reflex mcp` holds it
    // for the view's next wait, which carries nothing to acknowledge.
    const first = await person.send("s1", "first");
    const gotFirst = await chat.call("wait_for_user", { space: "s1", timeout_s: 5 });
    assert.equal(gotFirst.send, first, "the view's wait did not get the Send the Link pushed for it");

    // The view posts `first` to the chat, so its next wait acknowledges it with `after` — what app-view.ts does.
    // The person presses Send again before that wait starts.
    const second = await person.send("s1", "second");
    await until("the push of the second Send to be under way", 5000, () => host.dispatcher.inFlight("s1", second, recipient(agent)));
    // The push frame has to reach `reflex mcp` (a second connection) before the wait is made.
    await until("reflex mcp to hold the pushed Send", 3000, () => mcpLog(dir).includes(`"app_push_held","send":"${second}"`));
    const gotSecond = await chat.call("wait_for_user", { space: "s1", timeout_s: 3, after: first });

    assert.equal(
      gotSecond.send,
      second,
      `the view's next wait (which acknowledges the last posted Send with after) did not get the Send pushed for it: ${JSON.stringify(gotSecond)}`,
    );
  } finally {
    chat.close();
    person.close();
    // Let the Link finish recording a push the view took, so nothing touches the database after it closes.
    await new Promise((r) => setTimeout(r, 300));
    await new Promise<void>((r) => host.server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
