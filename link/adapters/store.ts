// Push targets, their secrets and every delivery attempt, kept by the Link
// outside any adapter (link/adapters/contract.ts). Targets and attempts live in
// the Link's SQLite database; secrets in 0600 files under `<home>/adapters/`.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PushTarget } from "./contract.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_targets (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, adapter TEXT NOT NULL, instance TEXT NOT NULL,
  config TEXT NOT NULL, callback TEXT NOT NULL, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  UNIQUE (agent, adapter, instance)
);
CREATE TABLE IF NOT EXISTS push_attempts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, adapter TEXT NOT NULL,
  space TEXT NOT NULL, send TEXT NOT NULL, recipient TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL, reason TEXT
);
CREATE INDEX IF NOT EXISTS push_attempts_send ON push_attempts(space, send, recipient);
`;

export type AttemptOutcome = "pushing" | "pushed" | "failed";
export interface Attempt {
  seq: number;
  target: string;
  adapter: string;
  space: string;
  send: string;
  recipient: string;
  started_at: number;
  ended_at: number | null;
  outcome: AttemptOutcome;
  reason: string | null;
}

type Row = Omit<PushTarget, "config" | "has_secret"> & { config: string; instance: string };

export class PushStore {
  #db: DatabaseSync;
  #dir: string;

  constructor(db: DatabaseSync, home: string) {
    this.#db = db;
    this.#dir = join(home, "adapters");
    db.exec(SCHEMA);
    // An attempt still "pushing" was cut off by a Link that stopped mid-push. Its Send is still in the Inbox.
    db.prepare("UPDATE push_attempts SET outcome = 'failed', reason = 'the Link stopped during the push', ended_at = ? WHERE outcome = 'pushing'").run(Date.now());
  }

  #secretFile(id: string) {
    return join(this.#dir, `${id}.secret`);
  }

  #target(r: Row): PushTarget {
    return {
      id: r.id,
      agent: r.agent,
      adapter: r.adapter,
      config: JSON.parse(r.config),
      callback: r.callback,
      has_secret: existsSync(this.#secretFile(r.id)),
      created_at: r.created_at,
      seen_at: r.seen_at,
    };
  }

  /** Creates or refreshes the target for one Agent, adapter and instance (a session, a URL). */
  upsert(t: { agent: string; adapter: string; instance: string; config: Record<string, unknown>; callback: string }, now = Date.now()): PushTarget {
    this.#db
      .prepare(
        `INSERT INTO push_targets (id, agent, adapter, instance, config, callback, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent, adapter, instance) DO UPDATE SET config = excluded.config, callback = excluded.callback, seen_at = excluded.seen_at`,
      )
      .run(`pt_${randomBytes(6).toString("hex")}`, t.agent, t.adapter, t.instance, JSON.stringify(t.config), t.callback, now, now);
    return this.#target(this.#db.prepare("SELECT * FROM push_targets WHERE agent = ? AND adapter = ? AND instance = ?").get(t.agent, t.adapter, t.instance) as unknown as Row);
  }

  get(id: string): PushTarget | undefined {
    const r = this.#db.prepare("SELECT * FROM push_targets WHERE id = ?").get(id) as unknown as Row | undefined;
    return r && this.#target(r);
  }

  /** An Agent's targets, most recently seen first. */
  forAgent(agent: string): PushTarget[] {
    return (this.#db.prepare("SELECT * FROM push_targets WHERE agent = ? ORDER BY seen_at DESC").all(agent) as unknown as Row[]).map((r) => this.#target(r));
  }

  all(): PushTarget[] {
    return (this.#db.prepare("SELECT * FROM push_targets ORDER BY seen_at DESC").all() as unknown as Row[]).map((r) => this.#target(r));
  }

  touch(id: string, now = Date.now()) {
    this.#db.prepare("UPDATE push_targets SET seen_at = ? WHERE id = ?").run(now, id);
  }

  remove(id: string) {
    this.#db.prepare("DELETE FROM push_targets WHERE id = ?").run(id);
    rmSync(this.#secretFile(id), { force: true });
  }

  /** Keeps a target's secret (a webhook signing key, a token) in its own 0600 file. */
  setSecret(id: string, secret: string) {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.#secretFile(id), secret, { mode: 0o600 });
  }

  secret(id: string): string | undefined {
    const f = this.#secretFile(id);
    return existsSync(f) ? readFileSync(f, "utf8") : undefined;
  }

  /** Records that a push started; durable before the adapter runs. */
  begin(target: PushTarget, space: string, send: string, recipient: string, now = Date.now()): number {
    return Number(
      this.#db
        .prepare("INSERT INTO push_attempts (target, adapter, space, send, recipient, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, 'pushing')")
        .run(target.id, target.adapter, space, send, recipient, now).lastInsertRowid,
    );
  }

  end(seq: number, outcome: "pushed" | "failed", reason?: string, now = Date.now()) {
    this.#db.prepare("UPDATE push_attempts SET outcome = ?, reason = ?, ended_at = ? WHERE seq = ?").run(outcome, reason ?? null, now, seq);
  }

  /** Whether this Send was ever pushed to this recipient (any outcome). */
  tried(space: string, send: string, recipient: string): boolean {
    return this.#db.prepare("SELECT 1 FROM push_attempts WHERE space = ? AND send = ? AND recipient = ?").get(space, send, recipient) !== undefined;
  }

  attempts(o: { space?: string; send?: string; limit?: number } = {}): Attempt[] {
    return this.#db
      .prepare(
        `SELECT * FROM push_attempts WHERE (? IS NULL OR space = ?) AND (? IS NULL OR send = ?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(o.space ?? null, o.space ?? null, o.send ?? null, o.send ?? null, o.limit ?? 50) as unknown as Attempt[];
  }
}
