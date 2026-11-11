// Every Space the Link holds: a kernel replica in memory, made durable as a
// checkpoint plus a journal of change bytes.
//
// Every write goes through `commit`: the kernel makes the change, then the new
// change bytes are appended to the journal, and any new Sends are indexed in
// the Inbox, in one SQLite transaction. Only after that commits is the change
// visible to peers. If the transaction fails, the in-memory replica is thrown
// away and reloaded from disk, so nothing undurable is ever synced or answered.
//
// The Link never edits Space data itself; it only calls the kernel.
import type { DatabaseSync } from "node:sqlite";
import { Space } from "@reflex/kernel/node";
import { tx } from "./db.ts";
import type { Inbox } from "./inbox.ts";

/** How many journal entries a Space may collect before it is checkpointed. */
const CHECKPOINT_EVERY = 256;

export type Origin = "local" | "agent" | "person" | "send" | `sync:${string}` | "create";

export interface SpaceInfo {
  id: string;
  kind: string;
  digest: string;
  heads: string[];
  elements: number;
  sends: string[];
}

export class SpaceStore {
  #db: DatabaseSync;
  #actor: string;
  #inbox: Inbox;
  #spaces = new Map<string, Space>();
  #listeners: ((space: string, origin: Origin) => void)[] = [];

  constructor(db: DatabaseSync, actor: string, inbox: Inbox) {
    this.#db = db;
    this.#actor = actor;
    this.#inbox = inbox;
  }

  /** Called after every durable change, with where it came from. */
  onChange(fn: (space: string, origin: Origin) => void): void {
    this.#listeners.push(fn);
  }

  /** Loads every Space from disk and rebuilds the Inbox index from the Sends they hold. */
  recover(): { spaces: number; replayed: number; indexed: number } {
    const rows = this.#db.prepare("SELECT id FROM spaces ORDER BY id").all() as { id: string }[];
    let replayed = 0;
    let indexed = 0;
    for (const { id } of rows) {
      const { space, entries } = this.#load(id);
      this.#spaces.set(id, space);
      replayed += entries;
      indexed += tx(this.#db, () => this.#inbox.index(id, sendsOf(space), "recovery"));
    }
    return { spaces: rows.length, replayed, indexed };
  }

  #load(id: string): { space: Space; entries: number } {
    const cp = this.#db.prepare("SELECT bytes, upto FROM checkpoints WHERE space = ?").get(id) as
      | { bytes: Uint8Array; upto: number }
      | undefined;
    if (!cp) throw new Error(`Space ${id} has no checkpoint`);
    const space = Space.load(cp.bytes, this.#actor);
    const rows = this.#db
      .prepare("SELECT bytes FROM journal WHERE space = ? AND seq > ? ORDER BY seq")
      .all(id, cp.upto) as { bytes: Uint8Array }[];
    for (const r of rows) space.receive(r.bytes);
    return { space, entries: rows.length };
  }

  has(id: string): boolean {
    return this.#spaces.has(id);
  }

  ids(): string[] {
    return [...this.#spaces.keys()].sort();
  }

  kind(id: string): string {
    return this.#get(id).kind();
  }

  #get(id: string): Space {
    const s = this.#spaces.get(id);
    if (!s) throw new Error(`No Space '${id}'.`);
    return s;
  }

  /**
   * Creates a Space, or returns the existing one. Every replica of a Space
   * starts from the same genesis change (kernel README), so a Space created
   * here and the same Space created on a peer still merge.
   */
  ensure(id: string, kind: string, now = Date.now()): { created: boolean } {
    if (this.#spaces.has(id)) return { created: false };
    const space = Space.create(id, kind, this.#actor);
    tx(this.#db, () => {
      this.#db.prepare("INSERT INTO spaces (id, kind, created_at) VALUES (?, ?, ?)").run(id, kind, now);
      this.#db
        .prepare("INSERT INTO checkpoints (space, bytes, upto, at) VALUES (?, ?, 0, ?)")
        .run(id, space.save(), now);
    });
    this.#spaces.set(id, space);
    for (const l of this.#listeners) l(id, "create");
    return { created: true };
  }

  /**
   * Runs one kernel call against a Space and makes whatever it changed durable
   * before returning. Calls are synchronous, so commits never interleave.
   */
  commit<T>(id: string, origin: Origin, fn: (s: Space) => T, now = Date.now()): T {
    const space = this.#get(id);
    const before = space.heads();
    let out: T;
    try {
      out = fn(space);
    } catch (e) {
      this.#reload(id); // the kernel may have half-taken bytes; disk is the truth
      throw e;
    }
    const after = space.heads();
    if (after === before) return out;
    const bytes = space.changesSince(before);
    const indexSends = origin === "send" || origin.startsWith("sync:");
    try {
      tx(this.#db, () => {
        this.#db
          .prepare("INSERT INTO journal (space, origin, bytes, heads, at) VALUES (?, ?, ?, ?, ?)")
          .run(id, origin, bytes, after, now);
        if (indexSends) this.#inbox.index(id, sendsOf(space), origin);
      });
    } catch (e) {
      this.#reload(id);
      throw new Error(`Could not make the change durable, so it was dropped: ${(e as Error).message}`);
    }
    this.#maybeCheckpoint(id, space, now);
    for (const l of this.#listeners) l(id, origin);
    return out;
  }

  #reload(id: string): void {
    this.#spaces.set(id, this.#load(id).space);
  }

  /** Replaces the checkpoint and drops the journal entries it covers, atomically. */
  #maybeCheckpoint(id: string, space: Space, now: number): void {
    const { n, last } = this.#db
      .prepare("SELECT count(*) AS n, max(seq) AS last FROM journal WHERE space = ?")
      .get(id) as { n: number; last: number | null };
    if (n < CHECKPOINT_EVERY || last === null) return;
    tx(this.#db, () => {
      this.#db
        .prepare("UPDATE checkpoints SET bytes = ?, upto = ?, at = ? WHERE space = ?")
        .run(space.save(), last, now, id);
      this.#db.prepare("DELETE FROM journal WHERE space = ? AND seq <= ?").run(id, last);
    });
  }

  /** Read-only kernel access (scene, digest, sync messages). Never for writes. */
  read<T>(id: string, fn: (s: Space) => T): T {
    return fn(this.#get(id));
  }

  info(id: string): SpaceInfo {
    const s = this.#get(id);
    const scene = JSON.parse(s.scene(JSON.stringify({ detail: "full" })));
    return {
      id,
      kind: s.kind(),
      digest: s.digest(),
      heads: JSON.parse(s.heads()),
      elements: scene.elements.length,
      sends: scene.sends ?? [],
    };
  }

  journalStats(): { entries: number; checkpoints: number } {
    const j = this.#db.prepare("SELECT count(*) AS n FROM journal").get() as { n: number };
    const c = this.#db.prepare("SELECT count(*) AS n FROM checkpoints").get() as { n: number };
    return { entries: j.n, checkpoints: c.n };
  }
}

function sendsOf(space: Space): string[] {
  return JSON.parse(space.scene(JSON.stringify({ detail: "full" }))).sends ?? [];
}
