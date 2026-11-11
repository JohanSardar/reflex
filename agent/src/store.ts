// The seams the Agent layer needs from whoever hosts it (ARCHITECTURE §6):
// where Spaces live, where Sends wait, and where assets are. The Link (T5)
// implements them with its journal, its durable Inbox and its asset store
// (link/agent-host.ts); the Agent layer never touches storage itself.
import type { Space } from "@reflex/kernel/node";

export type Bounds = [number, number, number, number];

export interface SpaceEntry {
  readonly name: string;
  readonly kind: "space" | "library";
  readonly title?: string;
  readonly size: "infinite" | "pages" | "width";
  readonly width?: number;
  /** What the person's screen shows now, in Agent coordinates. */
  readonly viewport: Bounds;
  /** The kernel replica of this Space, for reads. Writes go through `SpaceStore.write`. */
  readonly space: Space;
  /** Agents that opened this Space; its Sends reach them. */
  readonly agents: ReadonlySet<string>;
}

export type WriteOrigin = "agent" | "person" | "send";

export interface SpaceStore {
  get(name: string): SpaceEntry | undefined;
  create(name: string, opts: { kind?: "space" | "library"; title?: string; size?: SpaceEntry["size"]; width?: number }): SpaceEntry;
  list(): SpaceEntry[];
  /** Runs one kernel write and makes it durable before returning. A Send it freezes is indexed in the Inbox. */
  write<T>(entry: SpaceEntry, origin: WriteOrigin, fn: (s: Space) => T): T;
  /** Records that an Agent opened a Space, so its Sends reach that Agent. */
  attach(entry: SpaceEntry, agent: string): void;
}

/** A frozen Send as the kernel's freeze_send stores it. */
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
  /** What the device rendered when the person pressed Send: assets with the bounds they show. */
  crops?: { asset: string; bounds: Bounds; strokes?: string[] }[];
  at: number;
  /** send, or tap for a notify Behavior; action for a Behavior nobody receives. */
  kind?: "send" | "tap" | "watch" | "action";
  element?: string;
  region?: string;
  payload?: Record<string, unknown>;
  /** The device's word timings, ms since the epoch. */
  words?: { text: string; start_ms: number; end_ms?: number }[];
  /** A Behavior trigger: what fired, and the Behaviors it ran. */
  on?: string;
  actions?: Record<string, any>[];
  /** Who owns the Element or Region the Send is about. */
  owner?: { agent?: string; person?: string };
  panel?: string;
  values?: Record<string, unknown>;
};

export type Delivery = { send: FrozenSend; redelivered: boolean };
export type WaitFilter = { space?: string; region?: string; element?: string };

export interface Inbox {
  /** The oldest unacknowledged Send for this Agent that matches, marked delivered. */
  take(agent: string, filter: WaitFilter): Delivery | undefined;
  /** Acknowledges a Send. Returns false when it isn't in this Agent's Inbox. */
  ack(agent: string, send: string): boolean;
  pending(agent: string, space?: string): number;
  /** Who this Send went to. */
  recipients(send: string): string[];
  /** Resolves when something new arrives, or the signal aborts. */
  arrival(agent: string, signal: AbortSignal): Promise<void>;
}

/** Content-addressed assets (crops, photos), by SHA-256 hex. */
export interface Assets {
  get(hash: string): Buffer | undefined;
  /** Stores bytes durably and returns their hash. */
  put?(bytes: Buffer): string;
}
