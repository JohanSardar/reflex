// A cloud session: one granted Space, decrypted and materialized, running the
// same kernel and Agent layer as the Link (ARCHITECTURE §8.4, ADR-0004).
//
// It exists only while its grant is live. It reads the Space from the log,
// writes every Agent change back to the log sealed with the Space key, and
// keeps a small Inbox of the Sends that arrive while it runs. When the grant
// ends, the log drops it and everything it held in memory.
import type { Space } from "@reflex/kernel/node";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Core, ReflexError } from "../../agent/src/capabilities/index.ts";
import { TOOLS, description, inputSchema, instructions } from "../../agent/src/protocol.ts";
import { serveApp, toolMeta } from "../../agent/src/surfaces/app.ts";
import type { Renderer } from "../../agent/src/render.ts";
import type { Assets, Bounds, Delivery, FrozenSend, Inbox, SpaceEntry, SpaceStore, WaitFilter, WriteOrigin } from "../../agent/src/store.ts";
import type { Bucket, Sql } from "./ports.ts";
import { assetId, hex, openAsset, openEntry, random, sealEntry, sha256hex, type SpaceKeys } from "./seal.ts";
import type { Grant } from "./wire.ts";

const CLOCK_SKEW_MS = 5 * 60_000;

/** The kernel binding: `@reflex/kernel/node` or `@reflex/kernel/workers`. */
export interface Kernel {
  create(id: string, kind: string, actor: string): Space;
  /** Opens a saved document (a snapshot) directly: far less memory than receiving it into a new replica. */
  load(bytes: Uint8Array, actor: string): Space;
  /** WASM linear memory in bytes, when the binding can say. */
  memoryBytes?(): number;
}

export interface SessionDeps {
  grant: Grant;
  keys: SpaceKeys;
  kernel: Kernel;
  sql: Sql;
  bucket: Bucket;
  renderer: Renderer;
  /** Entries after `seq`, oldest first, at most `limit`. */
  entries(after: number, limit: number): { seq: number; data: Uint8Array }[];
  /** The newest entry marked as a whole-Space snapshot, or 0. */
  lastSnapshot(): number;
  /** Appends one sealed entry durably and returns its sequence number. */
  append(sealed: Uint8Array): number;
  log: (m: string) => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS c_sends (gid TEXT NOT NULL, send TEXT NOT NULL, at INTEGER NOT NULL, routed INTEGER NOT NULL, PRIMARY KEY (gid, send));
CREATE TABLE IF NOT EXISTS c_receipts (gid TEXT NOT NULL, agent TEXT NOT NULL, send TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (gid, agent, send));
CREATE TABLE IF NOT EXISTS c_attached (gid TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (gid, agent));
`;

export class CloudSession {
  readonly grant: Grant;
  readonly core: Core;
  readonly stats = { entries: 0, change_bytes: 0, materialize_ms: 0, wasm_memory_bytes: 0 };
  #d: SessionDeps;
  #space: Space;
  #seq = 0;
  #assets = new Map<string, Buffer>();
  #missing = new Set<string>();
  #waiters = new Set<() => void>();

  constructor(d: SessionDeps) {
    this.#d = d;
    this.grant = d.grant;
    for (const stmt of SCHEMA.trim().split("\n")) d.sql.run(stmt);
    const t0 = Date.now();
    const actor = hex(random(16));
    const first = this.#sql<{ n: number }>("SELECT count(*) AS n FROM c_sends WHERE gid = ?", d.grant.grant)[0].n === 0;
    // Replay starts at the newest snapshot, if its sealed header agrees it is
    // one. Loading it directly, rather than receiving it into a new replica,
    // keeps the WASM memory near the size of the Space (a 5.5 MB snapshot
    // received took 290 MB; loaded, a fraction of that).
    let space: Space | null = null;
    const snap = d.lastSnapshot();
    if (snap > 0) {
      const e = d.entries(snap - 1, 1)[0];
      try {
        const opened = e && openEntry(d.keys, e.data);
        if (opened && opened.header.snapshot && opened.header.space === d.grant.space) {
          space = d.kernel.load(opened.bytes, actor);
          this.#seq = snap;
          this.stats.entries++;
          this.stats.change_bytes += opened.bytes.length;
        }
      } catch (err) {
        d.log(`the snapshot at entry ${snap} did not load (${(err as Error).message}); replaying the whole log`);
      }
    }
    this.#space = space ?? d.kernel.create(d.grant.space, d.grant.kind, actor);
    // Sends that were there before this grant began aren't news to its Agent.
    this.catchUp(!first);
    if (first) this.#index(false);
    this.stats.materialize_ms = Date.now() - t0;
    this.stats.wasm_memory_bytes = d.kernel.memoryBytes?.() ?? 0;
    const spaces = new CloudSpaces(this);
    this.core = new Core({
      spaces,
      inbox: new CloudInbox(this),
      assets: new CloudAssets(this.#assets),
      renderer: d.renderer,
      person: { person: d.grant.person.id, name: d.grant.person.name },
      names: { [d.grant.agent]: d.grant.name },
      progressEvery: 15,
      log: (event, data) => d.log(`session ${d.grant.grant}: ${event} ${JSON.stringify(data ?? {})}`),
    });
    d.log(`materialized '${d.grant.space}' for grant ${d.grant.grant}: ${this.stats.entries} entries, ${this.stats.change_bytes} bytes, ${this.stats.materialize_ms} ms, WASM memory ${this.stats.wasm_memory_bytes} bytes`);
  }

  #sql<T>(q: string, ...p: unknown[]): T[] {
    return this.#d.sql.all<T>(q, ...p);
  }

  get space(): Space {
    return this.#space;
  }

  /** Takes in log entries this session hasn't seen (from the person's devices). */
  catchUp(route = true): void {
    let changed = false;
    // Page by page, so a long log never sits in memory at once.
    for (let page = this.#d.entries(this.#seq, 32); page.length; page = this.#d.entries(this.#seq, 32))
    for (const e of page) {
      this.#seq = e.seq;
      let opened;
      try {
        opened = openEntry(this.#d.keys, e.data);
      } catch {
        this.#d.log(`entry ${e.seq} does not open with this grant's key; skipped`);
        continue;
      }
      if (opened.header.space !== this.grant.space) continue;
      // This grant's own entries too: a session that starts again needs them, and
      // receiving a change the Space already has does nothing.
      this.#space.receive(opened.bytes);
      this.stats.entries++;
      this.stats.change_bytes += opened.bytes.length;
      changed = true;
    }
    if (changed && route) this.#index(true);
  }

  #frozenAt(send: string): number {
    try {
      return Number(JSON.parse(this.#space.send(send)).at) || 0;
    } catch {
      return 0;
    }
  }

  /** Indexes Sends the Space holds that this session hasn't seen. */
  #index(route: boolean): void {
    const sends: string[] = JSON.parse(this.#space.scene(JSON.stringify({ detail: "full", ids: [] }))).sends ?? [];
    const g = this.grant.grant;
    const agents = this.#sql<{ agent: string }>("SELECT agent FROM c_attached WHERE gid = ?", g).map((r) => r.agent);
    let added = 0;
    for (const s of sends) {
      if (this.#sql("SELECT 1 FROM c_sends WHERE gid = ? AND send = ?", g, s).length) continue;
      // Sends frozen before this grant began are old news to its Agent (with
      // room for the devices' clocks to differ). Any other goes to the Agents
      // already attached, or waits for the first to attach.
      const old = !route && this.#frozenAt(s) < this.grant.issued - CLOCK_SKEW_MS;
      this.#d.sql.run("INSERT INTO c_sends (gid, send, at, routed) VALUES (?, ?, ?, ?)", g, s, Date.now(), old || agents.length ? 1 : 0);
      if (old) continue;
      for (const a of agents) this.#d.sql.run("INSERT OR IGNORE INTO c_receipts (gid, agent, send, state) VALUES (?, ?, ?, 'ready')", g, a, s);
      if (agents.length) added++;
    }
    if (added) this.#wake();
  }

  #wake(): void {
    for (const w of [...this.#waiters]) w();
  }

  /** An Agent change: sealed and appended to the log before the call returns. */
  write<T>(origin: WriteOrigin, fn: (s: Space) => T): T {
    const before = this.#space.heads();
    const out = fn(this.#space);
    if (this.#space.heads() === before) return out;
    const bytes = this.#space.changesSince(before);
    const sealed = sealEntry(this.#d.keys, { v: 0, space: this.grant.space, kind: this.grant.kind, author: `grant:${this.grant.grant}`, at: Date.now() }, bytes);
    // `#seq` stays put: entries from devices may sit before this one, and catchUp reads them all.
    this.#d.append(sealed);
    if (origin === "send") this.#index(true);
    return out;
  }

  attach(agent: string): void {
    const g = this.grant.grant;
    this.#d.sql.run("INSERT OR IGNORE INTO c_attached (gid, agent, at) VALUES (?, ?, ?)", g, agent, Date.now());
    // Sends that arrived before any Agent opened the Space go to the first that does.
    const unrouted = this.#sql<{ send: string }>("SELECT send FROM c_sends WHERE gid = ? AND routed = 0", g);
    for (const { send } of unrouted) this.#d.sql.run("INSERT OR IGNORE INTO c_receipts (gid, agent, send, state) VALUES (?, ?, ?, 'ready')", g, agent, send);
    this.#d.sql.run("UPDATE c_sends SET routed = 1 WHERE gid = ? AND routed = 0", g);
    if (unrouted.length) this.#wake();
  }

  attached(): string[] {
    return this.#sql<{ agent: string }>("SELECT agent FROM c_attached WHERE gid = ?", this.grant.grant).map((r) => r.agent);
  }

  receipts(agent: string): { send: string; state: string }[] {
    return this.#sql("SELECT r.send, r.state FROM c_receipts r JOIN c_sends s ON s.gid = r.gid AND s.send = r.send WHERE r.gid = ? AND r.agent = ? AND r.state != 'acknowledged' ORDER BY s.at", this.grant.grant, agent);
  }

  mark(agent: string, send: string, state: "delivered" | "acknowledged"): void {
    this.#d.sql.run("UPDATE c_receipts SET state = ? WHERE gid = ? AND agent = ? AND send = ?", state, this.grant.grant, agent, send);
  }

  recipients(send: string): string[] {
    return this.#sql<{ agent: string }>("SELECT agent FROM c_receipts WHERE gid = ? AND send = ?", this.grant.grant, send).map((r) => r.agent);
  }

  arrival(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.#waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    }).then(() => this.prefetch());
  }

  /** Fetches and opens the crops the Space's Sends refer to, so the Agent layer can read them synchronously. */
  async prefetch(): Promise<void> {
    const sends: string[] = JSON.parse(this.#space.scene(JSON.stringify({ detail: "full", ids: [] }))).sends ?? [];
    const want = new Set<string>();
    for (const s of sends) {
      const f = JSON.parse(this.#space.send(s)) as FrozenSend | null;
      for (const c of f?.crops ?? []) if (!this.#assets.has(c.asset) && !this.#missing.has(c.asset)) want.add(c.asset);
    }
    await Promise.all(
      [...want].map(async (hash) => {
        const sealed = await this.#d.bucket.get(`${this.#d.keys.log}/${assetId(this.#d.keys, hash)}`);
        if (!sealed) return; // not uploaded yet; asked again next call
        try {
          const bytes = openAsset(this.#d.keys, sealed);
          if (sha256hex(bytes) === hash) this.#assets.set(hash, Buffer.from(bytes));
          else this.#missing.add(hash);
        } catch {
          this.#missing.add(hash);
        }
      }),
    );
  }

  /** Answers one remote MCP request (stateless Streamable HTTP). */
  async mcp(req: Request): Promise<Response> {
    const server = new Server(
      { name: "reflex-relay", version: "0.1.0" },
      // The SDK validates only elicitation results with this; the Agent layer validates tool input itself (Ajv).
      { capabilities: { tools: {}, resources: {} }, instructions, jsonSchemaValidator: { getValidator: () => (v: unknown) => ({ valid: true, data: v, errorMessage: undefined }) } as never },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({ name: t, description: description(t), inputSchema: inputSchema(t), ...(toolMeta(t) ? { _meta: toolMeta(t) } : {}) })),
    }));
    // The MCP App view for chat hosts (claude.ai, ChatGPT): it holds wait_for_user on this session's Inbox and
    // posts each Send to the chat as a new turn (agent/src/surfaces/app.ts).
    serveApp(server);
    server.setRequestHandler(CallToolRequestSchema, async (r, extra) => {
      if (Date.now() >= this.grant.expires) throw new Error("This grant has expired. Ask the person for a new one.");
      this.catchUp();
      await this.prefetch();
      const progressToken = r.params._meta?.progressToken;
      const out = await this.core.call(r.params.name, r.params.arguments ?? {}, {
        who: { agent: this.grant.agent, name: this.grant.name, color: "violet" },
        signal: extra.signal,
        progress: (p) => {
          if (progressToken === undefined) return;
          void extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: p.elapsed_s, total: p.timeout_s, message: `Waiting for the person to press Send (${p.elapsed_s}s)` },
          });
        },
      });
      const content: any[] = [{ type: "text", text: JSON.stringify(out.json) }];
      for (const data of out.images) content.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
      return { content, isError: out.isError };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  close(): void {
    this.#wake();
    this.#space.free();
  }
}

class CloudSpaces implements SpaceStore {
  #s: CloudSession;
  constructor(s: CloudSession) {
    this.#s = s;
  }
  #entry(): SpaceEntry {
    const s = this.#s;
    return {
      name: s.grant.space,
      kind: s.grant.kind as SpaceEntry["kind"],
      size: "infinite",
      viewport: [0, 0, 1366, 1024] as Bounds,
      get space() {
        return s.space;
      },
      agents: new Set(s.attached()),
    };
  }
  get(name: string) {
    return name === this.#s.grant.space ? this.#entry() : undefined;
  }
  create(name: string) {
    if (name === this.#s.grant.space) return this.#entry();
    throw new ReflexError("not_granted", [
      { code: "not_granted", msg: `This session was granted the Space '${this.#s.grant.space}' only.`, fix: `Use '${this.#s.grant.space}', or ask the person to grant another Space from their Reflex Link.` },
    ]);
  }
  list() {
    return [this.#entry()];
  }
  write<T>(_entry: SpaceEntry, origin: WriteOrigin, fn: (s: Space) => T): T {
    return this.#s.write(origin, fn);
  }
  attach(_entry: SpaceEntry, agent: string) {
    this.#s.attach(agent);
  }
}

class CloudInbox implements Inbox {
  #s: CloudSession;
  constructor(s: CloudSession) {
    this.#s = s;
  }
  take(agent: string, f: WaitFilter): Delivery | undefined {
    if (f.space && f.space !== this.#s.grant.space) return undefined;
    for (const r of this.#s.receipts(agent)) {
      const send = JSON.parse(this.#s.space.send(r.send)) as FrozenSend | null;
      if (!send) continue;
      if (f.region && send.region !== f.region) continue;
      if (f.element && !(send.kind === "tap" && send.element === f.element)) continue;
      this.#s.mark(agent, r.send, "delivered");
      return { send, redelivered: r.state === "delivered" };
    }
    return undefined;
  }
  ack(agent: string, send: string) {
    if (!this.#s.recipients(send).includes(agent)) return false;
    this.#s.mark(agent, send, "acknowledged");
    return true;
  }
  pending(agent: string, space?: string) {
    return space && space !== this.#s.grant.space ? 0 : this.#s.receipts(agent).length;
  }
  recipients(send: string) {
    return this.#s.recipients(send);
  }
  arrival(_agent: string, signal: AbortSignal) {
    return this.#s.arrival(signal);
  }
}

class CloudAssets implements Assets {
  #m: Map<string, Buffer>;
  constructor(m: Map<string, Buffer>) {
    this.#m = m;
  }
  get(hash: string) {
    return this.#m.get(hash);
  }
}
