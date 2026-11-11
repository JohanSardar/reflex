// One Space's log on the Relay: every change, sealed with the Space key, in
// order (ADR-0004). The relay can't read it. It keeps the hash of the log
// token (whoever first writes the log sets it), the grants the person's
// devices issued, and the access tokens minted for them. Under a live grant,
// and only then, it runs a cloud session on the Space.
//
// Grants: a device sends the grant, signed with its device key, plus the Space
// key. The key is kept as is only until the OAuth token exchange (at most 10
// minutes); then it is wrapped under the access token and the plain copy is
// deleted, so at rest the relay holds it only in a form it can't open without
// a token it doesn't keep.
import type { Renderer } from "../../agent/src/render.ts";
import type { Bucket, Hubs, Sql } from "./ports.ts";
import { b64, b64url, deviceIdFor, hex, random, sha256hex, spaceKeys, timingSafeEqualStr, unb64, unb64url, unwrapKey, verifyEd25519, wrapKey } from "./seal.ts";
import { CloudSession, type Kernel } from "./session.ts";
import { ASSET_ID, grantText, type Grant } from "./wire.ts";

/** One sealed entry: a whole-Space snapshot of a large Space must fit. */
const MAX_ENTRY = 16 * 1024 * 1024;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL, at INTEGER NOT NULL, snap INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS grants (gid TEXT PRIMARY KEY, body TEXT NOT NULL, sig TEXT NOT NULL, plain_key BLOB, code TEXT, status TEXT NOT NULL, expires INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, gid TEXT NOT NULL, wrapped BLOB NOT NULL, expires INTEGER NOT NULL)",
];

/** The longest grant a device may issue. */
const MAX_GRANT_MS = 30 * 24 * 3600_000;
/** How long a grant's Space key may sit unwrapped, waiting for the token exchange. */
const PLAIN_KEY_MS = 10 * 60_000;

const tooBig = () =>
  new LogError(507, "this Space is too big to open in a cloud session on this Relay; use a self-hosted Relay (relay/node), which has no such limit, or a smaller Space");

export class LogError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export interface LogDeps {
  id: string;
  sql: Sql;
  bucket: Bucket;
  hubs: Hubs;
  kernel: Kernel;
  renderer: () => Renderer;
  log: (m: string) => void;
  /** Asks the platform to call `expire()` at this time (a Durable Object alarm, or a timer). */
  wakeAt: (at: number) => void;
  /** The most WASM memory a cloud session may take (Workers: the isolate's 128 MB, less room for the rest). */
  memoryLimit?: number;
}

export class SpaceLog {
  #d: LogDeps;
  /** One cloud session per live grant: each grant has its own Agent, Inbox state and token. */
  #sessions = new Map<string, CloudSession>();

  constructor(d: LogDeps) {
    this.#d = d;
    for (const s of SCHEMA) d.sql.run(s);
    if (!d.sql.all<{ name: string }>("PRAGMA table_info(entries)").some((c) => c.name === "snap")) d.sql.run("ALTER TABLE entries ADD COLUMN snap INTEGER NOT NULL DEFAULT 0");
    if (!d.sql.all<{ name: string }>("PRAGMA table_info(grants)").some((c) => c.name === "received")) d.sql.run("ALTER TABLE grants ADD COLUMN received INTEGER NOT NULL DEFAULT 0");
  }

  get id(): string {
    return this.#d.id;
  }

  #meta(k: string): string | undefined {
    return this.#d.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v;
  }

  /** The log token proves its holder knows the Space key. The first writer sets it. */
  #check(token: string, create = false): void {
    if (typeof token !== "string" || token.length < 40) throw new LogError(401, "a log token is needed");
    const h = sha256hex(token);
    const have = this.#meta("token_hash");
    if (!have) {
      if (!create) throw new LogError(404, "no such log");
      this.#d.sql.run("INSERT INTO meta (k, v) VALUES ('token_hash', ?)", h);
      return;
    }
    if (!timingSafeEqualStr(h, have)) throw new LogError(403, "wrong log token");
  }

  last(): number {
    return this.#d.sql.all<{ n: number | null }>("SELECT max(seq) AS n FROM entries")[0]?.n ?? 0;
  }

  entries(after: number, limit = 100_000): { seq: number; data: Uint8Array }[] {
    return this.#d.sql
      .all<{ seq: number; data: ArrayBuffer | Uint8Array }>("SELECT seq, data FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
      .map((r) => ({ seq: r.seq, data: new Uint8Array(r.data) }));
  }

  #insert(data: Uint8Array, snapshot = false): number {
    if (data.length > MAX_ENTRY) throw new LogError(413, "an entry is over the 16 MiB limit");
    this.#d.sql.run("INSERT INTO entries (data, at, snap) VALUES (?, ?, ?)", data, Date.now(), snapshot ? 1 : 0);
    return this.last();
  }

  /** Where replay can start: the newest entry a writer marked as a whole-Space snapshot (0: the beginning). */
  lastSnapshot(): number {
    return this.#d.sql.all<{ n: number | null }>("SELECT max(seq) AS n FROM entries WHERE snap = 1")[0]?.n ?? 0;
  }

  #notify(): void {
    const last = this.last();
    for (const { room } of this.#d.sql.all<{ room: string }>("SELECT room FROM rooms"))
      void this.#d.hubs.room(room).notify(this.#d.id, last).catch((e: Error) => this.#d.log(`could not notify room ${room}: ${e.message}`));
  }

  // ---------- what a room asks for, on behalf of a device ----------

  async append(token: string, room: string, entries: string[], snapshot = false): Promise<{ seqs: number[] }> {
    this.#check(token, true);
    this.#d.sql.run("INSERT OR IGNORE INTO rooms (room) VALUES (?)", room);
    const seqs = entries.map((e) => this.#insert(unb64(e), snapshot && entries.length === 1));
    for (const s of this.#sessions.values()) s.catchUp();
    if (seqs.length) this.#notify();
    return { seqs };
  }

  async read(token: string, after: number, limit: number): Promise<{ entries: { seq: number; data: string }[]; last: number }> {
    this.#check(token);
    return { entries: this.entries(after, limit).map((e) => ({ seq: e.seq, data: b64(e.data) })), last: this.last() };
  }

  async watch(token: string, room: string): Promise<{ last: number }> {
    this.#check(token, true);
    this.#d.sql.run("INSERT OR IGNORE INTO rooms (room) VALUES (?)", room);
    return { last: this.last() };
  }

  async assetsHave(token: string, ids: string[]): Promise<{ have: string[] }> {
    this.#check(token);
    const have: string[] = [];
    for (const id of ids) if (ASSET_ID.test(id) && (await this.#d.bucket.has(`${this.#d.id}/${id}`))) have.push(id);
    return { have };
  }

  async issueGrant(token: string, g: Grant, sig: string, key: string, code: string): Promise<void> {
    this.#check(token);
    const now = Date.now();
    const raw = unb64url(g.key ?? "");
    if (g.log !== this.#d.id) throw new LogError(400, "the grant is for another log");
    if (!/^g_[0-9a-f]{16}$/.test(g.grant) || !/^a_[A-Za-z0-9]{1,40}$/.test(g.agent)) throw new LogError(400, "malformed grant");
    if (!(g.expires > now && g.expires <= now + MAX_GRANT_MS)) throw new LogError(400, "a grant must expire within 30 days");
    if (raw.length !== 32 || deviceIdFor(raw) !== g.device || !(await verifyEd25519(raw, grantText(g), unb64url(sig)))) throw new LogError(403, "the grant's signature does not check out");
    const spaceKey = unb64url(key);
    // The key must be the one this log belongs to.
    if (spaceKey.length !== 32 || spaceKeys(spaceKey).log !== this.#d.id) throw new LogError(400, "that key does not belong to this log");
    // The sign-in must be waiting for this code before the Relay keeps any key.
    await this.#d.hubs.auth().approve(code, this.#d.id, g.grant, g.expires);
    this.#d.sql.run(
      "INSERT INTO grants (gid, body, sig, plain_key, code, status, expires, received) VALUES (?, ?, ?, ?, ?, 'issued', ?, ?)",
      g.grant,
      JSON.stringify(g),
      sig,
      spaceKey,
      code,
      g.expires,
      now,
    );
    this.#schedule();
    this.#d.log(`grant ${g.grant} issued by ${g.device} for ${g.name}, until ${new Date(g.expires).toISOString()}`);
  }

  async revokeGrant(token: string, gid: string): Promise<void> {
    this.#check(token);
    this.#end(gid, "revoked");
  }

  #end(gid: string, status: "revoked" | "expired"): void {
    this.#d.sql.run("UPDATE grants SET status = ?, plain_key = NULL WHERE gid = ?", status, gid);
    this.#d.sql.run("DELETE FROM tokens WHERE gid = ?", gid);
    for (const t of ["c_sends", "c_receipts", "c_attached"]) {
      try {
        this.#d.sql.run(`DELETE FROM ${t} WHERE gid = ?`, gid);
      } catch {
        /* no session ran yet */
      }
    }
    this.#sessions.get(gid)?.close();
    this.#sessions.delete(gid);
    this.#d.log(`grant ${gid} ${status}`);
  }

  async mint(gid: string, code: string): Promise<{ token: string; expires: number }> {
    const row = this.#d.sql.all<{ plain_key: ArrayBuffer | null; code: string; status: string; expires: number }>(
      "SELECT plain_key, code, status, expires FROM grants WHERE gid = ?",
      gid,
    )[0];
    if (!row || row.status !== "issued" || !row.plain_key || row.code !== code || row.expires <= Date.now()) throw new LogError(400, "that grant can't be used");
    const token = `rfx1.${this.#d.id}.${gid}.${b64url(random(32))}`;
    this.#d.sql.run("INSERT INTO tokens (hash, gid, wrapped, expires) VALUES (?, ?, ?, ?)", sha256hex(token), gid, wrapKey(token, new Uint8Array(row.plain_key)), row.expires);
    this.#d.sql.run("UPDATE grants SET plain_key = NULL, status = 'active', code = NULL WHERE gid = ?", gid);
    this.#schedule();
    return { token, expires: row.expires };
  }

  /** Ends every grant whose time is up, and tells the platform when to look again. */
  expire(): void {
    const now = Date.now();
    for (const { gid } of this.#d.sql.all<{ gid: string }>("SELECT gid FROM grants WHERE status IN ('issued', 'active') AND expires <= ?", now)) this.#end(gid, "expired");
    // A grant whose token was never collected keeps its plain key at most 10
    // minutes; by then its sign-in has expired too, so no token can follow.
    this.#d.sql.run("UPDATE grants SET plain_key = NULL WHERE status = 'issued' AND plain_key IS NOT NULL AND received + ? <= ?", PLAIN_KEY_MS, now);
    this.#schedule();
  }

  /** The platform keeps one wake time per log: always the earliest deadline of any grant. */
  #schedule(): void {
    const next = this.#d.sql.all<{ n: number | null }>(
      "SELECT min(CASE WHEN plain_key IS NOT NULL THEN min(expires, received + ?) ELSE expires END) AS n FROM grants WHERE status IN ('issued', 'active')",
      PLAIN_KEY_MS,
    )[0]?.n;
    if (next) this.#d.wakeAt(next);
  }

  // ---------- HTTP: remote MCP under a grant, sealed assets, stats ----------

  #resolve(token: string): { grant: Grant; key: Uint8Array } {
    const row = this.#d.sql.all<{ gid: string; wrapped: ArrayBuffer; expires: number }>("SELECT gid, wrapped, expires FROM tokens WHERE hash = ?", sha256hex(token))[0];
    if (!row || row.expires <= Date.now()) throw new LogError(401, "this access token is not valid (expired or revoked)");
    const g = this.#d.sql.all<{ body: string; status: string }>("SELECT body, status FROM grants WHERE gid = ?", row.gid)[0];
    if (!g || g.status !== "active") throw new LogError(401, "this grant is no longer active");
    return { grant: JSON.parse(g.body), key: unwrapKey(token, new Uint8Array(row.wrapped)) };
  }

  #sessionFor(token: string): CloudSession {
    const { grant, key } = this.#resolve(token);
    const live = this.#sessions.get(grant.grant);
    if (live) return live;
    // A Space too big to materialize here would take the whole isolate down
    // on every try. The marker is set before loading and cleared after, so a
    // load that never returned (out of memory) is not tried again until the
    // Space gets a new snapshot.
    const snap = String(this.lastSnapshot());
    if (this.#meta("too_big") === snap) throw tooBig();
    this.#setMeta("too_big", snap);
    const keys = spaceKeys(key);
    key.fill(0);
    const before = this.#d.kernel.memoryBytes?.() ?? 0;
    let session: CloudSession;
    try {
      session = new CloudSession({
      grant,
      keys,
      kernel: this.#d.kernel,
      sql: this.#d.sql,
      bucket: this.#d.bucket,
      renderer: this.#d.renderer(),
      entries: (after, limit) => this.entries(after, limit),
      lastSnapshot: () => this.lastSnapshot(),
      append: (sealed) => {
        const seq = this.#insert(sealed);
        queueMicrotask(() => {
          // Other grants' sessions on this Space see the Agent's change too.
          for (const s of this.#sessions.values()) if (s.grant.grant !== grant.grant) s.catchUp();
          this.#notify();
        });
        return seq;
      },
      log: this.#d.log,
      });
    } catch (e) {
      this.#d.sql.run("DELETE FROM meta WHERE k = 'too_big'");
      throw e;
    }
    const after = this.#d.kernel.memoryBytes?.() ?? 0;
    if (this.#d.memoryLimit && after > this.#d.memoryLimit && after > before) {
      session.close();
      // Remembered only if this Space alone outgrew the budget; one that lost
      // to other live sessions in the isolate is tried again later.
      if (after - before <= this.#d.memoryLimit) this.#d.sql.run("DELETE FROM meta WHERE k = 'too_big'");
      this.#d.log(`'${grant.space}' took ${after} bytes of WASM memory to open, over the ${this.#d.memoryLimit} a cloud session may use here`);
      throw tooBig();
    }
    this.#d.sql.run("DELETE FROM meta WHERE k = 'too_big'");
    this.#sessions.set(grant.grant, session);
    return session;
  }

  #setMeta(k: string, v: string): void {
    this.#d.sql.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  async fetch(req: Request, path: string[], origin: string): Promise<Response> {
    try {
      if (path[0] === "mcp") {
        const auth = req.headers.get("authorization") ?? "";
        const token = auth.replace(/^Bearer\s+/i, "");
        try {
          return await this.#sessionFor(token).mcp(req);
        } catch (e) {
          if (e instanceof LogError && e.status === 401) return unauthorized(origin, e.message);
          throw e;
        }
      }
      const token = req.headers.get("x-reflex-log-token") ?? "";
      if (path[0] === "assets" && ASSET_ID.test(path[1] ?? "")) {
        const key = `${this.#d.id}/${path[1]}`;
        if (req.method === "PUT") {
          this.#check(token);
          const body = new Uint8Array(await req.arrayBuffer());
          if (body.length > 64 * 1024 * 1024) throw new LogError(413, "an asset is over 64 MiB");
          await this.#d.bucket.put(key, body);
          return new Response(null, { status: 204 });
        }
        this.#check(token);
        const bytes = await this.#d.bucket.get(key);
        return bytes ? new Response(bytes as BodyInit) : new Response("no such asset", { status: 404 });
      }
      if (path[0] === "stats") {
        // With a grant's access token, the session's own numbers; with the log token, the log's.
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        const base = { log: this.#d.id, entries: this.last(), bytes: this.#d.sql.all<{ n: number }>("SELECT coalesce(sum(length(data)), 0) AS n FROM entries")[0].n };
        if (bearer) {
          const s = this.#sessionFor(bearer);
          const scene = JSON.parse(s.space.scene(JSON.stringify({ detail: "full" })));
          return Response.json({ ...base, session: { ...s.stats, wasm_memory_bytes: this.#d.kernel.memoryBytes?.() ?? 0, elements: scene.elements.length, sends: (scene.sends ?? []).length, digest: s.space.digest().slice(0, 12) } });
        }
        this.#check(token);
        return Response.json({ ...base, grants: this.#d.sql.all("SELECT gid, status, expires FROM grants ORDER BY expires") });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      const status = e instanceof LogError ? e.status : 500;
      if (status === 500) this.#d.log(`log ${this.#d.id}: ${(e as Error).stack ?? e}`);
      return Response.json({ error: (e as Error).message }, { status });
    }
  }
}

export function unauthorized(origin: string, msg: string): Response {
  return Response.json(
    { error: "invalid_token", error_description: msg },
    { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } },
  );
}

/** `rfx1.<log>.<grant>.<secret>` → the log it belongs to. */
export function tokenLog(token: string): string | null {
  const m = /^rfx1\.([0-9a-f]{64})\.g_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/.exec(token);
  return m ? m[1] : null;
}

export const newGrantId = (): string => "g_" + hex(random(8));
