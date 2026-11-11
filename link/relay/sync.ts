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
//
// A shared Space's key comes from its owner's Link with the share record
// (link/sharing.ts), and every member's Link writes the same log. Entries by
// another member's Link are taken in as that member's role allows. Removing
// someone moves the Space to a new key (`rotate`): a new log, which the
// removed person's devices can't name or read.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Space } from "@reflex/kernel/node";
import type { Catalog, PairedDevice } from "../pairing/catalog.ts";
import { b64, signWith, unb64, verifyFrom, type DeviceKey } from "../pairing/crypto.ts";
import type { AssetStore } from "../storage/assets.ts";
import type { SpaceStore } from "../storage/journal.ts";
import type { RelayTransport } from "../transports/relay.ts";
import { assetId, grantText, openEntry, sealAsset, sealEntry, spaceKeys, type Grant, type SpaceKeys } from "./keys.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_spaces (space TEXT PRIMARY KEY, key BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS relay_logs (
  relay TEXT NOT NULL, space TEXT NOT NULL, pushed TEXT NOT NULL DEFAULT '[]', read_seq INTEGER NOT NULL DEFAULT 0,
  since_snapshot INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (relay, space)
);
CREATE TABLE IF NOT EXISTS relay_assets (relay TEXT NOT NULL, space TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (relay, space, hash));
CREATE TABLE IF NOT EXISTS relay_grants (
  gid TEXT PRIMARY KEY, relay TEXT NOT NULL, space TEXT NOT NULL, agent TEXT NOT NULL, name TEXT NOT NULL,
  issued INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL
);
`;

/** The most one entry may carry (the relay takes up to 16 MiB sealed). */
const MAX_ENTRY = 15 * 1024 * 1024;
/**
 * After this many bytes of changes, the next entry is the whole Space instead (`save()`, marked
 * as a snapshot), so a cloud session replays from there and not from the beginning of the log.
 */
const SNAPSHOT_AFTER = 4 * 1024 * 1024;

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
  /** Sends whose crops are all on the relay, per Space. */
  #scanned = new Map<string, Set<string>>();
  #pushTimers = new Map<string, NodeJS.Timeout>();
  /** A member's own changes set aside before another person's arrived over a session, still to write. */
  #held = new Map<string, Uint8Array[]>();
  /** The heads a push now on its way to the Relay will mark as written, and what to mark instead when other people's changes came in meanwhile. */
  #inflight = new Map<string, { heads: string; after?: string }>();
  #connected: (device: string) => boolean;
  #syncs: (space: string) => boolean;
  #role: (space: string) => "owner" | "editor" | "viewer" | null;
  #writers: (d: PairedDevice | undefined, space: string) => string;
  #device: (id: string, space: string) => PairedDevice | undefined;

  constructor(o: {
    db: DatabaseSync;
    store: SpaceStore;
    assets: AssetStore;
    catalog: Catalog;
    transport: RelayTransport;
    key: DeviceKey;
    person: () => { id: string; name: string };
    /** Whether a device is in an end-to-end session with this Link right now. */
    connected: (device: string) => boolean;
    /** Whether a Space goes to the log at all: not one this person was removed from. */
    syncs?: (space: string) => boolean;
    /** This person's role in a Space (link/sharing.ts): only an owner writes it whole, and a viewer writes nothing. */
    role?: (space: string) => "owner" | "editor" | "viewer" | null;
    /** Who a device's changes to a Space may be written for (link/sharing.ts). */
    writers: (d: PairedDevice | undefined, space: string) => string;
    /** A device by ID: a paired one, or another member's Link in that shared Space. */
    device?: (id: string, space: string) => PairedDevice | undefined;
    log: (m: string) => void;
  }) {
    this.#syncs = o.syncs ?? (() => true);
    this.#role = o.role ?? (() => "owner");
    this.#writers = o.writers;
    this.#device = o.device ?? ((id) => o.catalog.device(id));
    this.#connected = o.connected;
    this.#db = o.db;
    this.#store = o.store;
    this.#assets = o.assets;
    this.#catalog = o.catalog;
    this.#t = o.transport;
    this.#key = o.key;
    this.#person = o.person;
    this.#log = o.log;
    this.#db.exec(SCHEMA);
    const cols = this.#db.prepare("PRAGMA table_info(relay_logs)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "since_snapshot")) this.#db.exec("ALTER TABLE relay_logs ADD COLUMN since_snapshot INTEGER NOT NULL DEFAULT 0");
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
      // Many changes in a burst (a person drawing) go as one entry.
      if (this.#pushTimers.has(space)) return;
      const t = setTimeout(() => {
        this.#pushTimers.delete(space);
        void this.#queue(space, () => this.#push(space));
      }, 300);
      t.unref();
      this.#pushTimers.set(space, t);
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
  importKeys(keys: { space: string; key: string }[], from: string, skip: (space: string) => boolean = () => false): void {
    for (const k of keys ?? []) {
      const key = Buffer.from(String(k.key), "base64url");
      if (key.length !== 32 || typeof k.space !== "string" || skip(k.space)) continue;
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

  /** A Space's key, for a member of it (sent only over an end-to-end session). */
  keyOf(space: string): string | undefined {
    const row = this.#db.prepare("SELECT key FROM relay_spaces WHERE space = ?").get(space) as { key: Uint8Array } | undefined;
    return row && Buffer.from(row.key).toString("base64url");
  }

  /** A shared Space's key from its owner's Link: it replaces this Link's own, and its log is read from the start. */
  setKey(space: string, b64key: string, from: string): void {
    const key = Buffer.from(String(b64key), "base64url");
    if (key.length !== 32) return;
    const mine = this.#db.prepare("SELECT key FROM relay_spaces WHERE space = ?").get(space) as { key: Uint8Array } | undefined;
    if (mine && Buffer.from(mine.key).equals(key)) return;
    this.#replaceKey(space, key);
    this.#log(`relay: '${space}' now uses ${from}'s key for its encrypted log`);
  }

  /** A new key for a Space (someone was removed): later changes go to a new log only its members can read. */
  rotate(space: string): void {
    this.#replaceKey(space, randomBytes(32));
    this.#log(`relay: '${space}' has a new key; from now on its changes go to a new encrypted log (${this.keys(space).log.slice(0, 12)}…)`);
  }

  /** This person was removed from a shared Space: its log is no longer theirs to read or write. */
  dropKey(space: string): void {
    this.#db.prepare("DELETE FROM relay_spaces WHERE space = ?").run(space);
    this.#db.prepare("DELETE FROM relay_logs WHERE space = ?").run(space);
    this.#db.prepare("DELETE FROM relay_assets WHERE space = ?").run(space);
    this.#watching.delete(space);
  }

  #replaceKey(space: string, key: Buffer): void {
    this.#db.prepare("INSERT INTO relay_spaces (space, key) VALUES (?, ?) ON CONFLICT (space) DO UPDATE SET key = excluded.key").run(space, key);
    this.#db.prepare("DELETE FROM relay_logs WHERE space = ?").run(space);
    this.#db.prepare("DELETE FROM relay_assets WHERE space = ?").run(space);
    this.#watching.delete(space);
    this.#scanned.delete(space);
    if (this.#store.has(space)) this.#queue(space, () => this.#sync(space));
  }

  #spaceForLog(log: string): string | undefined {
    for (const r of this.#db.prepare("SELECT space, key FROM relay_spaces").all() as { space: string; key: Uint8Array }[])
      if (spaceKeys(r.key).log === log) return r.space;
    return undefined;
  }

  #queue(space: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.#chains.get(space) ?? Promise.resolve())
      .then(() => (this.#t.connected && this.#syncs(space) ? fn() : undefined))
      .catch((e: Error) => this.#log(`relay: ${space}: ${e.message}`));
    this.#chains.set(space, run);
    return run;
  }

  async #sync(space: string): Promise<void> {
    await this.#watch(space, this.keys(space));
    await this.#push(space);
    await this.#pull(space);
  }

  #row(space: string): { pushed: string; read_seq: number; since_snapshot: number } {
    this.keys(space);
    this.#db.prepare("INSERT OR IGNORE INTO relay_logs (relay, space) VALUES (?, ?)").run(this.#t.url, space);
    return this.#db.prepare("SELECT pushed, read_seq, since_snapshot FROM relay_logs WHERE relay = ? AND space = ?").get(this.#t.url, space) as {
      pushed: string;
      read_seq: number;
      since_snapshot: number;
    };
  }

  /** Sends what the log doesn't have yet. */
  /**
   * Takes in another person's changes to a Space that came over a session (a member hears the owner's
   * Link). For a member those are the owner's Link's to write to the log: other members check this
   * Link's entries by this person's role and would refuse them. So this Link's own unwritten changes
   * are set aside first, and what arrives is marked as already written.
   */
  aside(space: string, apply: () => string): string {
    if (this.#role(space) !== "editor" || !this.#store.has(space)) return apply();
    const flying = this.#inflight.get(space);
    const written = flying?.heads ?? this.#row(space).pushed;
    if (written === "[]") return apply(); // nothing written yet: the first push only marks where this Link starts
    const before = this.#store.read(space, (s) => s.heads());
    const own = written !== before ? this.#store.read(space, (s) => s.changesSince(written)) : null;
    const r = apply();
    const after = this.#store.read(space, (s) => s.heads());
    if (after === before) return r; // nothing new: this Link's own changes go out as usual
    if (flying) flying.after = after;
    else this.#db.prepare("UPDATE relay_logs SET pushed = ? WHERE relay = ? AND space = ?").run(after, this.#t.url, space);
    // Heads that include the other person's changes don't mark this Link's own as written: send those now.
    if (own) {
      this.#held.set(space, [...(this.#held.get(space) ?? []), own]);
      void this.#queue(space, () => this.#push(space));
    }
    return r;
  }

  async #push(space: string): Promise<void> {
    if (!this.#store.has(space)) return;
    const keys = this.keys(space);
    const role = this.#role(space);
    if (role === "viewer" || role === null) {
      this.#held.delete(space);
      return this.#watch(space, keys);
    }
    for (let held = this.#held.get(space); held?.length; held = this.#held.get(space)) {
      const seq = await this.#append(space, keys, held[0], false);
      this.#log(`relay: pushed ${held[0].length} bytes of '${space}' set aside (entry ${seq})`);
      held.shift();
      if (!held.length) this.#held.delete(space);
    }
    const { pushed, since_snapshot } = this.#row(space);
    const heads = this.#store.read(space, (s) => s.heads());
    if (heads === pushed) return this.#watch(space, keys);
    // A member writes only its own new changes to a shared Space's log, never the whole Space: earlier
    // ones are the owner's Link's to pass on, and other members check this Link's entries by its role.
    if (role === "editor" && pushed === "[]") {
      this.#db.prepare("UPDATE relay_logs SET pushed = ? WHERE relay = ? AND space = ?").run(heads, this.#t.url, space);
      return this.#watch(space, keys);
    }
    let bytes: Uint8Array = this.#store.read(space, (s) => s.changesSince(pushed));
    // The first push, a long way behind, or enough changes since the last snapshot: the whole Space, compacted.
    const snapshot = role === "owner" && (pushed === "[]" || bytes.length > MAX_ENTRY || since_snapshot + bytes.length > SNAPSHOT_AFTER);
    if (snapshot) bytes = this.#store.read(space, (s) => s.save());
    if (bytes.length > MAX_ENTRY) throw new Error(`Space '${space}' is ${bytes.length} bytes, over what one log entry can carry`);
    const flying = { heads } as { heads: string; after?: string };
    this.#inflight.set(space, flying);
    let seq: number;
    try {
      seq = await this.#append(space, keys, bytes, snapshot);
    } finally {
      this.#inflight.delete(space);
    }
    this.#db
      .prepare("UPDATE relay_logs SET pushed = ?, since_snapshot = ? WHERE relay = ? AND space = ?")
      .run(flying.after ?? heads, snapshot ? 0 : since_snapshot + bytes.length, this.#t.url, space);
    this.#log(`relay: pushed ${bytes.length} bytes of '${space}'${snapshot ? " as a snapshot" : ""} (entry ${seq})`);
    await this.#watch(space, keys);
  }

  async #append(space: string, keys: SpaceKeys, bytes: Uint8Array, snapshot: boolean): Promise<number> {
    await this.#uploadCrops(space, keys);
    const header = {
      v: 0 as const,
      space,
      kind: this.#store.kind(space),
      author: `device:${this.#key.device}`,
      at: Date.now(),
      sig: signWith(this.#key, createHash("sha256").update(bytes).digest()),
      ...(snapshot ? { snapshot: true } : {}),
    };
    const sealed = sealEntry(keys, header, bytes);
    const r = await this.#t.request({ t: "log.append", log: keys.log, token: keys.token, entries: [sealed.toString("base64")], snapshot }, 60_000);
    return (r.seqs as number[])[0];
  }

  async #watch(space: string, keys: SpaceKeys): Promise<void> {
    if (this.#watching.has(space)) return;
    const r = await this.#t.request({ t: "log.watch", log: keys.log, token: keys.token });
    this.#watching.add(space);
    // A log shorter than what this Link already read lost entries (a relay restored or replaced): send it everything again.
    const { read_seq } = this.#row(space);
    if (Number(r.last) < read_seq) {
      this.#log(`relay: the log of '${space}' has ${r.last} entries but this Link read ${read_seq}; sending the whole Space again`);
      this.#db.prepare("UPDATE relay_logs SET pushed = '[]', read_seq = 0, since_snapshot = 0 WHERE relay = ? AND space = ?").run(this.#t.url, space);
      this.#db.prepare("DELETE FROM relay_assets WHERE relay = ? AND space = ?").run(this.#t.url, space);
      this.#scanned.delete(space);
    }
  }

  /** Uploads, sealed, the crops this Space's Sends refer to, before any entry that refers to them. */
  async #uploadCrops(space: string, keys: SpaceKeys): Promise<void> {
    const sends: string[] = this.#store.read(space, (s) => JSON.parse(s.scene(JSON.stringify({ detail: "full", ids: [] }))).sends ?? []);
    const seen = this.#scanned.get(space) ?? new Set<string>();
    this.#scanned.set(space, seen);
    const hashes = new Set<string>();
    for (const id of sends) {
      if (seen.has(id)) continue;
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
    // A crop that isn't here yet is looked for again next time.
    for (const id of sends) {
      if (seen.has(id)) continue;
      const f = JSON.parse(this.#store.read(space, (s) => s.send(id))) as { crops?: { asset: string }[] } | null;
      if ((f?.crops ?? []).every((c) => done.has(c.asset) || this.#isUploaded(space, c.asset))) seen.add(id);
    }
  }

  #isUploaded(space: string, hash: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM relay_assets WHERE relay = ? AND space = ? AND hash = ?").get(this.#t.url, space, hash));
  }

  /**
   * Takes in entries other writers (cloud sessions, other devices) appended. Consecutive
   * entries with the same writers are checked and applied together: a checked receive
   * forks the Space, so doing it once per page instead of once per entry matters.
   */
  async #pull(space: string): Promise<void> {
    if (!this.#store.has(space)) return;
    const keys = this.keys(space);
    for (;;) {
      const { read_seq } = this.#row(space);
      const r = await this.#t.request({ t: "log.read", log: keys.log, token: keys.token, after: read_seq, limit: 200 });
      const entries = r.entries as { seq: number; data: string }[];
      if (!entries.length) return;
      let run: { writers: string; authors: Set<string>; parts: Buffer[]; first: number; last: number } | null = null;
      const flush = (): void => {
        if (run) this.#apply(space, run.writers, Buffer.concat(run.parts), `entries ${run.first}–${run.last} from ${[...run.authors].join(", ")}`);
        run = null;
      };
      for (const e of entries) {
        const w = this.#writersFor(space, keys, e.seq, unb64Std(e.data));
        if (!w) continue;
        if (run && run.writers !== w.writers) flush();
        run ??= { writers: w.writers, authors: new Set(), parts: [], first: e.seq, last: e.seq };
        run.parts.push(w.bytes);
        run.authors.add(w.author);
        run.last = e.seq;
      }
      flush();
      this.#db.prepare("UPDATE relay_logs SET read_seq = ? WHERE relay = ? AND space = ?").run(entries[entries.length - 1].seq, this.#t.url, space);
    }
  }

  /** Opens an entry and says who may have written it, or null to skip it. */
  #writersFor(space: string, keys: SpaceKeys, seq: number, sealed: Uint8Array): { writers: string; bytes: Buffer; author: string } | null {
    let opened;
    try {
      opened = openEntry(keys, sealed);
    } catch {
      this.#log(`relay: entry ${seq} of '${space}' does not open with its key; ignored`);
      return null;
    }
    const { header, bytes } = opened;
    const skip = (why: string): null => (this.#log(`relay: entry ${seq} of '${space}' ${why}; ignored`), null);
    if (header.space !== space) return skip(`claims Space '${header.space}'`);
    if (header.author === `device:${this.#key.device}`) return null; // this Link wrote it
    if (header.author.startsWith("grant:")) {
      const g = this.grant(header.author.slice(6));
      // Another Link of this person issued it; its changes reach this one through that Link.
      if (!g) return null;
      if (g.space !== space) return skip(`is from grant ${g.gid}, which is for another Space`);
      if (g.status !== "active" || Date.now() > g.expires) return skip(`is from grant ${g.gid}, which is ${g.status === "active" ? "expired" : g.status}`);
      return { writers: JSON.stringify({ people: [], agents: [g.agent] }), bytes, author: header.author };
    }
    if (header.author.startsWith("device:")) {
      const device = header.author.slice(7);
      const d = this.#device(device, space);
      if (!d || !header.sig || !verifyFrom(unb64(d.key), createHash("sha256").update(bytes).digest(), header.sig)) return skip("is not signed by a paired device or a member's Link");
      // A device this Link is in sync with right now sends the same changes over its own session.
      if (this.#connected(device)) return null;
      return { writers: this.#writers(d, space), bytes, author: header.author };
    }
    return null;
  }

  #apply(space: string, writers: string, bytes: Uint8Array, what: string): void {
    const before = this.#store.read(space, (s) => s.heads());
    const { pushed } = this.#row(space);
    const r = this.#store.commit(space, "sync:relay", (s) => receiveChecked(s, bytes, writers));
    if (!r.ok) return this.#log(`relay: refused ${what} of '${space}': ${(r.errors ?? []).map((e) => e.msg).join(" ")}`);
    const after = this.#store.read(space, (s) => s.heads());
    if (after === before) return;
    // What came from the log needn't go back to it.
    if (pushed === before) this.#db.prepare("UPDATE relay_logs SET pushed = ? WHERE relay = ? AND space = ?").run(after, this.#t.url, space);
    this.#log(`relay: took in ${what} of '${space}'`);
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
