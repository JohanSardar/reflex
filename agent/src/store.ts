// What the Agent layer needs from whoever hosts it (the Link): a Send's shape, the Inbox and the asset store.

/** x, y, width, height on the page. */
export type Bounds = [number, number, number, number];
export interface InkStroke {
  id: string;
  points: number[][];
  bounds: Bounds;
  color: string;
  width: number;
  at: number;
}
export interface NativeSend {
  send: string;
  space: string;
  by: { person: string; device: string };
  at: number;
  trigger: string;
  viewport: Bounds;
  strokes: InkStroke[];
  /** The page as it was when Send was pressed, for targets around earlier writing. */
  context?: InkStroke[];
  said?: string;
  words?: { text: string; start_ms: number; end_ms?: number }[];
  hints?: { strokes: string[]; text: string; confidence: number }[];
  crops?: { asset: string; bounds: Bounds; strokes?: string[]; kind?: "screen" | "recent_strokes" }[];
}
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
