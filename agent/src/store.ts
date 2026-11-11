// The seams the Agent layer needs from whoever hosts it (ARCHITECTURE §6):
// where Spaces live and where Sends wait. T4 runs on the in-memory versions
// below; T6 plugs in the Link's journal and durable Inbox (T5) behind the same
// interfaces.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Space } from "@reflex/kernel/node";

export type Bounds = [number, number, number, number];

export interface SpaceEntry {
  name: string;
  kind: "space" | "library";
  title?: string;
  size: "infinite" | "pages" | "width";
  width?: number;
  /** What the person's screen shows now, in Agent coordinates. */
  viewport: Bounds;
  /** The kernel replica of this Space. */
  space: Space;
  /** Agents that opened this Space; Sends from it reach them. */
  agents: Set<string>;
  updatedAt: number;
}

export interface SpaceStore {
  get(name: string): SpaceEntry | undefined;
  create(name: string, opts: { kind?: "space" | "library"; title?: string; size?: SpaceEntry["size"]; width?: number }): SpaceEntry;
  list(): SpaceEntry[];
  /** Called after every change to a Space; a durable store journals it here. */
  changed(entry: SpaceEntry): void;
}

/** A frozen Send as the kernel's freeze_send returns it. */
export type FrozenSend = {
  send: string;
  space: string;
  from: { person: string };
  trigger: string;
  strokes: string[];
  changes: Record<string, unknown>[];
  said?: string;
  viewport?: Bounds;
  selection?: string[];
  at: number;
  /** Not from the kernel: set for taps and watch snapshots. */
  kind?: "send" | "tap" | "watch";
  element?: string;
  region?: string;
  payload?: Record<string, unknown>;
};

export type Delivery = { send: FrozenSend; redelivered: boolean };
export type WaitFilter = { space?: string; region?: string; element?: string };

export interface Inbox {
  /** Queues a Send for each recipient. A Send is never lost: it stays until acknowledged. */
  push(send: FrozenSend, recipients: string[]): void;
  /** The oldest unacknowledged Send for this Agent that matches, marked delivered. */
  take(agent: string, filter: WaitFilter): Delivery | undefined;
  /** Acknowledges a Send. Returns false when it isn't in this Agent's Inbox. */
  ack(agent: string, send: string): boolean;
  pending(agent: string, space?: string): number;
  /** Who else this Send went to. */
  recipients(send: string): string[];
  /** Resolves when something new arrives for this Agent, or the signal aborts. */
  arrival(agent: string, signal: AbortSignal): Promise<void>;
}

export class MemorySpaces implements SpaceStore {
  #spaces = new Map<string, SpaceEntry>();
  /** One random actor per process: this replica's identity in Automerge. */
  #actor = randomBytes(16).toString("hex");

  get(name: string) {
    return this.#spaces.get(name);
  }
  create(name: string, opts: { kind?: "space" | "library"; title?: string; size?: SpaceEntry["size"]; width?: number }) {
    const kind = opts.kind ?? "space";
    const entry: SpaceEntry = {
      name,
      kind,
      title: opts.title,
      size: opts.size ?? "infinite",
      width: opts.width,
      viewport: [0, 0, 1366, 1024],
      space: Space.create(name, kind, this.#actor),
      agents: new Set(),
      updatedAt: Date.now(),
    };
    this.#spaces.set(name, entry);
    return entry;
  }
  list() {
    return [...this.#spaces.values()];
  }
  changed(entry: SpaceEntry) {
    entry.updatedAt = Date.now();
  }
}

type Slot = { send: FrozenSend; delivered: boolean; acked: boolean };

export class MemoryInbox implements Inbox {
  #slots = new Map<string, Slot[]>(); // agent -> slots, oldest first
  #to = new Map<string, string[]>();
  #events = new EventEmitter();

  push(send: FrozenSend, recipients: string[]) {
    this.#to.set(send.send, recipients);
    for (const a of recipients) {
      const list = this.#slots.get(a) ?? [];
      if (!list.some((s) => s.send.send === send.send)) list.push({ send, delivered: false, acked: false });
      this.#slots.set(a, list);
      this.#events.emit(a);
    }
  }
  take(agent: string, f: WaitFilter) {
    const slot = (this.#slots.get(agent) ?? []).find(
      (s) =>
        !s.acked &&
        (!f.space || s.send.space === f.space) &&
        (!f.region || s.send.region === f.region) &&
        (!f.element || (s.send.kind === "tap" && s.send.element === f.element)),
    );
    if (!slot) return undefined;
    const redelivered = slot.delivered;
    slot.delivered = true;
    return { send: slot.send, redelivered };
  }
  ack(agent: string, send: string) {
    const slot = (this.#slots.get(agent) ?? []).find((s) => s.send.send === send);
    if (!slot) return false;
    slot.acked = true;
    return true;
  }
  pending(agent: string, space?: string) {
    return (this.#slots.get(agent) ?? []).filter((s) => !s.acked && (!space || s.send.space === space)).length;
  }
  recipients(send: string) {
    return this.#to.get(send) ?? [];
  }
  arrival(agent: string, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.#events.off(agent, done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#events.on(agent, done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
