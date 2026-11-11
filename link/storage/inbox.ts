// The durable Inbox index (ARCHITECTURE §7.4).
//
// A frozen Send lives in its Space and never changes. The index records each
// Send the moment it becomes durable on this Link (in the same transaction as
// the journal entry that brought it), plus a receipt per recipient:
//
//   ready → delivered(recipient) → acknowledged(recipient)
//   any state → failed(recoverable)
//
// The index can always be rebuilt from the Spaces, and is on every start.
// A Send stays pending for a recipient until that recipient acknowledges it.
import type { DatabaseSync } from "node:sqlite";

export type ReceiptState = "delivered" | "acknowledged" | "failed";

export interface InboxEntry {
  space: string;
  send: string;
  arrived_at: number;
  via: string;
  state: "ready" | ReceiptState;
  attempts: number;
}

export class Inbox {
  #db: DatabaseSync;
  #waiters = new Set<() => void>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Records Sends not yet indexed. Must run inside the caller's transaction. Returns how many were new. */
  index(space: string, sends: string[], via: string, now = Date.now()): number {
    const ins = this.#db.prepare(
      "INSERT INTO inbox (space, send, arrived_at, via) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    );
    let added = 0;
    for (const s of sends) added += Number(ins.run(space, s, now, via).changes);
    if (added > 0) queueMicrotask(() => this.#wake());
    return added;
  }

  /** Sends this recipient hasn't acknowledged, oldest first. Optionally only one Space. */
  pending(recipient: string, space?: string): InboxEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT i.space, i.send, i.arrived_at, i.via, coalesce(r.state, 'ready') AS state, coalesce(r.attempts, 0) AS attempts
         FROM inbox i LEFT JOIN receipts r ON r.space = i.space AND r.send = i.send AND r.recipient = ?
         WHERE coalesce(r.state, 'ready') != 'acknowledged' AND (? IS NULL OR i.space = ?)
         ORDER BY i.seq`,
      )
      .all(recipient, space ?? null, space ?? null);
    return rows as unknown as InboxEntry[];
  }

  all(): InboxEntry[] {
    return this.#db
      .prepare("SELECT space, send, arrived_at, via, 'ready' AS state, 0 AS attempts FROM inbox ORDER BY seq")
      .all() as unknown as InboxEntry[];
  }

  receipts(space: string, send: string): { recipient: string; state: ReceiptState; attempts: number }[] {
    return this.#db
      .prepare("SELECT recipient, state, attempts FROM receipts WHERE space = ? AND send = ? ORDER BY recipient")
      .all(space, send) as unknown as { recipient: string; state: ReceiptState; attempts: number }[];
  }

  #has(space: string, send: string): boolean {
    return this.#db.prepare("SELECT 1 FROM inbox WHERE space = ? AND send = ?").get(space, send) !== undefined;
  }

  /** Moves one recipient's receipt forward. Acknowledged is final; it never goes back. */
  mark(space: string, send: string, recipient: string, state: ReceiptState, reason?: string, now = Date.now()): void {
    if (!this.#has(space, send)) throw new Error(`No Send '${send}' in Space '${space}'.`);
    this.#db
      .prepare(
        `INSERT INTO receipts (space, send, recipient, state, attempts, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (space, send, recipient) DO UPDATE SET
           state = CASE WHEN receipts.state = 'acknowledged' THEN 'acknowledged' ELSE excluded.state END,
           attempts = receipts.attempts + excluded.attempts,
           reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(space, send, recipient, state, state === "delivered" ? 1 : 0, reason ?? null, now);
  }

  /** Resolves when a new Send is indexed, or after `ms`. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.#waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.#waiters.add(done);
    });
  }

  #wake(): void {
    for (const w of [...this.#waiters]) w();
  }
}
