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
//
// Recipients are fixed when a Send is indexed: every Agent attached to its
// Space then (SPEC §4, "Routing Sends"). A Send that arrives before any Agent
// opened its Space goes to the first Agents that do.
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
  /** Who a new Send in this Space goes to. */
  recipientsFor: (space: string) => string[] = () => [];

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Records Sends not yet indexed. Must run inside the caller's transaction. Returns how many were new. */
  index(space: string, sends: string[], via: string, now = Date.now()): number {
    const ins = this.#db.prepare(
      "INSERT INTO inbox (space, send, arrived_at, via) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    );
    const to = this.#db.prepare("INSERT INTO inbox_to (space, send, recipient) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    let added = 0;
    for (const s of sends) {
      const n = Number(ins.run(space, s, now, via).changes);
      if (n) for (const r of this.recipientsFor(space)) to.run(space, s, r);
      added += n;
    }
    if (added > 0) queueMicrotask(() => this.#wake());
    return added;
  }

  /** Sends to this recipient it hasn't acknowledged, oldest first. Optionally only one Space. */
  pending(recipient: string, space?: string): InboxEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT i.space, i.send, i.arrived_at, i.via, coalesce(r.state, 'ready') AS state, coalesce(r.attempts, 0) AS attempts
         FROM inbox i JOIN inbox_to t ON t.space = i.space AND t.send = i.send AND t.recipient = ?
         LEFT JOIN receipts r ON r.space = i.space AND r.send = i.send AND r.recipient = t.recipient
         WHERE coalesce(r.state, 'ready') != 'acknowledged' AND (? IS NULL OR i.space = ?)
         ORDER BY i.seq`,
      )
      .all(recipient, space ?? null, space ?? null);
    return rows as unknown as InboxEntry[];
  }

  /** Who a Send was sent to. */
  recipients(space: string, send: string): string[] {
    return (this.#db.prepare("SELECT recipient FROM inbox_to WHERE space = ? AND send = ? ORDER BY recipient").all(space, send) as { recipient: string }[]).map(
      (r) => r.recipient,
    );
  }

  /** Where a Send is, by its ID. */
  find(send: string): InboxEntry | undefined {
    return this.#db.prepare("SELECT space, send, arrived_at, via, 'ready' AS state, 0 AS attempts FROM inbox WHERE send = ?").get(send) as unknown as
      | InboxEntry
      | undefined;
  }

  /** A newly attached recipient gets this Space's Sends that had nobody to go to. */
  adopt(space: string, recipient: string): number {
    const r = this.#db
      .prepare(
        `INSERT INTO inbox_to (space, send, recipient)
         SELECT i.space, i.send, ? FROM inbox i WHERE i.space = ?
         AND NOT EXISTS (SELECT 1 FROM inbox_to t WHERE t.space = i.space AND t.send = i.send)`,
      )
      .run(recipient, space);
    if (Number(r.changes) > 0) queueMicrotask(() => this.#wake());
    return Number(r.changes);
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

  /** Resolves when a new Send is indexed or adopted, or the signal aborts. */
  next(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.#waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
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
