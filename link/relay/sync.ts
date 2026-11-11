// The Link's side of the Relay's encrypted log (ADR-0004).
//
// Every Space this Link holds gets a random 32-byte Space key, kept only on
// this device. Its changes go to the Relay sealed with that key: whatever the
// journal holds that the log doesn't yet, as one entry per push, signed with
// this device's key. Crops a Send refers to are uploaded, sealed, before the
// entry that refers to them.
//
// Entries from elsewhere are taken in only if they were the author's to make:
// a cloud session (author `grant:<id>`) may write only as its grant's Agent,
// only while that grant is live, and the kernel checks every record it touches,
// as it does for a peer (`receive_sync_message_checked`).
//
// A grant is issued only from the Link's own terminal, after the person typed
// the code the Relay's sign-in page showed them (link/link.ts).
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Space } from "@reflex/kernel/node";
import type { Catalog } from "../pairing/catalog.ts";
import { b64, signWith, unb64, verifyFrom, type DeviceKey } from "../pairing/crypto.ts";
import type { AssetStore } from "../storage/assets.ts";
import type { SpaceStore } from "../storage/journal.ts";
import type { RelayTransport } from "../transports/relay.ts";
import { assetId, grantText, openEntry, sealAsset, sealEntry, spaceKeys, type Grant, type SpaceKeys } from "./keys.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_spaces (space TEXT PRIMARY KEY, key BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS relay_logs (
  relay TEXT NOT NULL, space TEXT NOT NULL, pushed TEXT NOT NULL DEFAULT '[]', read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (relay, space)
);
CREATE TABLE IF NOT EXISTS relay_assets (relay TEXT NOT NULL, space TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (relay, space, hash));
CREATE TABLE IF NOT EXISTS relay_grants (
  gid TEXT PRIMARY KEY, relay TEXT NOT NULL, space TEXT NOT NULL, agent TEXT NOT NULL, name TEXT NOT NULL,
  issued INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL
);
`;

/** An entry that's bigger than this is sent as a whole-Space snapshot instead. */
const MAX_ENTRY = 12 * 1024 * 1024;

export interface GrantRecord {
  gid: string;
  relay: string;
  space: string;
  agent: string;
  name: string;
  issued: number;
  expires: number;
  status: "active" | "revoked" | "expired";
}

/** Applies change bytes from outside a sync conversation, only if `writers` may make every change in them. */
export function receiveChecked(s: Space, bytes: Uint8Array, writers: string): { ok: boolean; errors?: { msg: string }[] } {
  const tmp = Space.load(s.save(), randomBytes(16).toString("hex"));
  const peer = "relay-log";
  try {
    tmp.receive(bytes);
    s.resetSync(peer);
    for (let i = 0; i < 32; i++) {
      const m = tmp.syncMessage("link");
      if (m) {
        const r = JSON.parse(s.receiveSyncMessageChecked(peer, m, writers));
        if (!r.ok) return r;
      }
      const back = s.syncMessage(peer);
      if (back) tmp.receiveSyncMessage("link", back);
      if (!m && !back) break;
    }
    return { ok: true };
  } finally {
    s.resetSync(peer);
    tmp.free();
  }
}

export class RelaySync {
  #db: DatabaseSync;
  #store: SpaceStore;
  #assets: AssetStore;
  #catalog: Catalog;
  #t: RelayTransport;
  #key: DeviceKey;
  #person: () => { id: string; name: string };
  #log: (m: string) => void;
  /** One chain per Space, so pushes and pulls of a Space never interleave. */
  #chains = new Map<string, Promise<void>>();
  #watching = new Set<string>();

  constructor(o: {
    db: DatabaseSync;
    store: SpaceStore;
    assets: AssetStore;
    catalog: Catalog;
    transport: RelayTransport;
    key: DeviceKey;
    person: () => { id: string; name: string };
    log: (m: string) => void;
  }) {
    this.#db = o.db;
    this.#store = o.store;
    this.#assets = o.assets;
    this.#catalog = o.catalog;
    this.#t = o.transport;
    this.#key = o.key;
    this.#person = o.person;
    this.#log = o.log;
    this.#db.exec(SCHEMA);
    this.#t.onReady = () => {
      this.#watching.clear();
      for (const id of this.#store.ids()) this.#queue(id, () => this.#sync(id));
    };
    this.#t.onLogNew = (log) => {
      const space = this.#spaceForLog(log);
      if (space) this.#queue(space, () => this.#pull(space));
    };
    this.#store.onChange((space, origin) => {
      if (origin === "sync:relay") return; // came from the log
      this.#queue(space, () => this.#push(space));
    });
  }

  keys(space: string): SpaceKeys {
    let row = this.#db.prepare("SELECT key FROM relay_spaces WHERE space = ?").get(space) as { key: Uint8Array } | undefined;
    if (!row) {
      const key = randomBytes(32);
      this.#db.prepare("INSERT INTO relay_spaces (space, key) VALUES (?, ?)").run(space, key);
      row = { key };
    }
    return spaceKeys(row.key);
  }

  /** This Link's Space keys, for another Link of the same person (sent only over an end-to-end session). */
  exportKeys(): { space: string; key: string }[] {
    return (this.#db.prepare("SELECT space, key FROM relay_spaces").all() as { space: string; key: Uint8Array }[]).map((r) => ({ space: r.space, key: Buffer.from(r.key).toString("base64url") }));
  }

  /**
   * Space keys from another Link of this person. Two Links that each made a key for the same Space
   * both keep the one whose log ID sorts first, so they end up writing one log.
   */
  importKeys(keys: { space: string; key: string }[], from: string): void {
    for (const k of keys ?? []) {
      const key = Buffer.from(String(k.key), "base64url");
      if (key.length !== 32 || typeof k.space !== "string") continue;
      const mine = this.#db.prepare("SELECT key FROM relay_spaces WHERE space = ?").get(k.space) as { key: Uint8Array } | undefined;
      if (mine && Buffer.from(mine.key).equals(key)) continue;
      if (mine && spaceKeys(mine.key).log < spaceKeys(key).log) continue;
      this.#db.prepare("INSERT INTO relay_spaces (space, key) VALUES (?, ?) ON CONFLICT (space) DO UPDATE SET key = excluded.key").run(k.space, key);
      // A new log: everything goes into it, and it's read from the start.
      this.#db.prepare("DELETE FROM relay_logs WHERE space = ?").run(k.space);
      this.#db.prepare("DELETE FROM relay_assets WHERE space = ?").run(k.space);
      this.#watching.delete(k.space);
      this.#log(`relay: '${k.space}' now uses the same encrypted log as ${from}`);
      if (this.#store.has(k.space)) this.#queue(k.space, () => this.#sync(k.space));
    }
  }

  #spaceForLog(log: string): string | undefined {
    for (const r of this.#db.prepare("SELECT space, key FROM relay_spaces").all() as { space: string; key: Uint8Array }[])
      if (spaceKeys(r.key).log === log) return r.space;
    return undefined;
  }

  #queue(space: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.#chains.get(space) ?? Promise.resolve())
      .then(() => (this.#t.connected ? fn() : undefined))
      .catch((e: Error) => this.#log(`relay: ${space}: ${e.message}`));
    this.#chains.set(space, run);
    return run;
  }

  async #sync(space: string): Promise<void> {
    await this.#push(space);
    await this.#pull(space);
  }

  #row(space: string): { pushed: string; read_seq: number } {
    this.keys(space);
    this.#db.prepare("INSERT OR IGNORE INTO relay_logs (relay, space) VALUES (?, ?)").run(this.#t.url, space);
    return this.#db.prepare("SELECT pushed, read_seq FROM relay_logs WHERE relay = ? AND space = ?").get(this.#t.url, space) as { pushed: string; read_seq: number };
  }

  /** Sends what the log doesn't have yet. */
  async #push(space: string): Promise<void> {
    if (!this.#store.has(space)) return;
    const keys = this.keys(space);
    const { pushed } = this.#row(space);
    const heads = this.#store.read(space, (s) => s.heads());
    if (heads === pushed) return this.#watch(space, keys);
    let bytes: Uint8Array = this.#store.read(space, (s) => s.changesSince(pushed));
    // The first push, or a long way behind: the whole Space, compacted.
    if (pushed === "[]" || bytes.length > MAX_ENTRY) bytes = this.#store.read(space, (s) => s.save());
    if (bytes.length > MAX_ENTRY) throw new Error(`Space '${space}' is ${bytes.length} bytes, over what one log entry can carry`);
    await this.#uploadCrops(space, keys);
    const header = {
      v: 0 as const,
      space,
      kind: this.#store.kind(space),
      author: `device:${this.#key.device}`,
      at: Date.now(),
      sig: signWith(this.#key, createHash("sha256").update(bytes).digest()),
    };
    const sealed = sealEntry(keys, header, bytes);
    const r = await this.#t.request({ t: "log.append", log: keys.log, token: keys.token, entries: [sealed.toString("base64")] });
    this.#db.prepare("UPDATE relay_logs SET pushed = ? WHERE relay = ? AND space = ?").run(heads, this.#t.url, space);
    this.#log(`relay: pushed ${bytes.length} bytes of '${space}' (entry ${(r.seqs as number[])[0]})`);
    await this.#watch(space, keys);
  }

  async #watch(space: string, keys: SpaceKeys): Promise<void> {
    if (this.#watching.has(space)) return;
    await this.#t.request({ t: "log.watch", log: keys.log, token: keys.token });
    this.#watching.add(space);
  }

  /** Uploads, sealed, the crops this Space's Sends refer to, before any entry that refers to them. */
  async #uploadCrops(space: string, keys: SpaceKeys): Promise<void> {
    const sends: string[] = this.#store.info(space).sends;
    const hashes = new Set<string>();
    for (const id of sends) {
      const f = JSON.parse(this.#store.read(space, (s) => s.send(id))) as { crops?: { asset: string }[] } | null;
      for (const c of f?.crops ?? []) hashes.add(c.asset);
    }
    const done = new Set((this.#db.prepare("SELECT hash FROM relay_assets WHERE relay = ? AND space = ?").all(this.#t.url, space) as { hash: string }[]).map((r) => r.hash));
    for (const hash of hashes) {
      if (done.has(hash) || !this.#assets.has(hash)) continue;
      const res = await fetch(`${this.#t.httpUrl}/v0/log/${keys.log}/assets/${assetId(keys, hash)}`, {
        method: "PUT",
        headers: { "x-reflex-log-token": keys.token, "content-type": "application/octet-stream" },
        body: new Uint8Array(sealAsset(keys, this.#assets.get(hash))),
      });
      if (!res.ok) throw new Error(`could not upload asset ${hash}: ${res.status} ${await res.text()}`);
      this.#db.prepare("INSERT OR IGNORE INTO relay_assets (relay, space, hash) VALUES (?, ?, ?)").run(this.#t.url, space, hash);
    }
  }

  /** Takes in entries other writers (cloud sessions, other devices) appended. */
  async #pull(space: string): Promise<void> {
    if (!this.#store.has(space)) return;
    const keys = this.keys(space);
    for (;;) {
      const { read_seq } = this.#row(space);
      const r = await this.#t.request({ t: "log.read", log: keys.log, token: keys.token, after: read_seq, limit: 200 });
      const entries = r.entries as { seq: number; data: string }[];
      if (!entries.length) return;
      for (const e of entries) {
        this.#apply(space, keys, e.seq, unb64Std(e.data));
        this.#db.prepare("UPDATE relay_logs SET read_seq = ? WHERE relay = ? AND space = ?").run(e.seq, this.#t.url, space);
      }
    }
  }

  #apply(space: string, keys: SpaceKeys, seq: number, sealed: Uint8Array): void {
    let opened;
    try {
      opened = openEntry(keys, sealed);
    } catch {
      return this.#log(`relay: entry ${seq} of '${space}' does not open with its key; ignored`);
    }
    const { header, bytes } = opened;
    if (header.space !== space) return this.#log(`relay: entry ${seq} claims Space '${header.space}', in the log of '${space}'; ignored`);
    if (header.author === `device:${this.#key.device}`) return; // this Link wrote it
    let writers: string;
    if (header.author.startsWith("grant:")) {
      const g = this.grant(header.author.slice(6));
      const now = Date.now();
      if (!g || g.space !== space) return this.#log(`relay: entry ${seq} of '${space}' is from a grant this Link didn't issue; ignored`);
      if (g.status !== "active" || now > g.expires) return this.#log(`relay: entry ${seq} of '${space}' is from grant ${g.gid}, which is ${g.status === "active" ? "expired" : g.status}; ignored`);
      writers = JSON.stringify({ people: [], agents: [g.agent] });
    } else if (header.author.startsWith("device:")) {
      const d = this.#catalog.device(header.author.slice(7));
      if (!d || !header.sig || !verifyFrom(unb64(d.key), createHash("sha256").update(bytes).digest(), header.sig))
        return this.#log(`relay: entry ${seq} of '${space}' is not signed by a paired device; ignored`);
      writers = JSON.stringify(d.kind === "ipad" ? { people: [d.person.id] } : { people: [d.person.id], agents: "*" });
    } else return;
    const before = this.#store.read(space, (s) => s.heads());
    const { pushed } = this.#row(space);
    const r = this.#store.commit(space, "sync:relay", (s) => receiveChecked(s, bytes, writers));
    if (!r.ok) return this.#log(`relay: refused entry ${seq} of '${space}' from ${header.author}: ${(r.errors ?? []).map((e) => e.msg).join(" ")}`);
    // What came from the log needn't go back to it.
    if (pushed === before)
      this.#db.prepare("UPDATE relay_logs SET pushed = ? WHERE relay = ? AND space = ?").run(this.#store.read(space, (s) => s.heads()), this.#t.url, space);
    this.#log(`relay: took in entry ${seq} of '${space}' from ${header.author}`);
  }

  // ---------- grants ----------

  grant(gid: string): GrantRecord | undefined {
    return this.#db.prepare("SELECT * FROM relay_grants WHERE gid = ?").get(gid) as GrantRecord | undefined;
  }

  grants(): GrantRecord[] {
    const now = Date.now();
    return (this.#db.prepare("SELECT * FROM relay_grants ORDER BY issued").all() as unknown as GrantRecord[]).map((g) =>
      g.status === "active" && g.expires <= now ? { ...g, status: "expired" as const } : g,
    );
  }

  /** Who is asking, for the code the person typed. */
  async lookup(code: string): Promise<{ client: string; client_uri: string | null }> {
    const r = await this.#t.request({ t: "auth.lookup", code });
    return { client: String(r.client), client_uri: (r.client_uri as string | null) ?? null };
  }

  /** Issues a grant for one Space to the sign-in waiting on `code`. Only the Link's terminal calls this. */
  async issue(code: string, space: string, ms: number, client: string): Promise<GrantRecord> {
    if (!this.#store.has(space)) throw new Error(`No Space '${space}'.`);
    // The log must hold the Space before a session can read it.
    await this.#queue(space, () => this.#push(space));
    const keys = this.keys(space);
    const row = this.#db.prepare("SELECT key FROM relay_spaces WHERE space = ?").get(space) as { key: Uint8Array };
    const now = Date.now();
    const g: Grant = {
      grant: "g_" + randomBytes(8).toString("hex"),
      log: keys.log,
      space,
      kind: this.#store.kind(space),
      epoch: 0,
      agent: "a_rc" + randomBytes(5).toString("hex"),
      name: client.slice(0, 80),
      person: this.#person(),
      scopes: ["read", "write"],
      issued: now,
      expires: now + ms,
      device: this.#key.device,
      key: b64(this.#key.publicRaw),
    };
    const sig = signWith(this.#key, grantText(g));
    await this.#t.request({ t: "grant.issue", code, log: keys.log, token: keys.token, grant: g, sig, key: Buffer.from(row.key).toString("base64url") });
    this.#db
      .prepare("INSERT INTO relay_grants (gid, relay, space, agent, name, issued, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')")
      .run(g.grant, this.#t.url, space, g.agent, g.name, g.issued, g.expires);
    this.#log(`relay: granted ${g.name} '${space}' until ${new Date(g.expires).toISOString()} (${g.grant}, Agent ${g.agent})`);
    return this.grant(g.grant)!;
  }

  async revoke(gid: string): Promise<GrantRecord> {
    const g = this.grant(gid);
    if (!g) throw new Error(`No grant '${gid}'.`);
    // Locally first: from now on nothing that grant writes is taken in, even if the relay can't be told.
    this.#db.prepare("UPDATE relay_grants SET status = 'revoked' WHERE gid = ?").run(gid);
    const keys = this.keys(g.space);
    try {
      await this.#t.request({ t: "grant.revoke", log: keys.log, token: keys.token, grant: gid });
    } catch (e) {
      this.#log(`relay: revoked ${gid} here, but could not tell the relay yet: ${(e as Error).message}`);
    }
    return this.grant(gid)!;
  }

  status(): { url: string; connected: boolean; logs: number } {
    return { url: this.#t.url, connected: this.#t.connected, logs: (this.#db.prepare("SELECT count(*) AS n FROM relay_logs WHERE relay = ?").get(this.#t.url) as { n: number }).n };
  }
}

const unb64Std = (s: string): Buffer => Buffer.from(s, "base64");
