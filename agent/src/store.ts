import type { NativeSend } from "../../link/storage/sends.ts";
export type Bounds = [number, number, number, number];
export type FrozenSend = NativeSend;
export type Delivery = { send: NativeSend; redelivered: boolean };
export type WaitFilter = { space?: string };

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
