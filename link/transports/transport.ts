// The transport seam (ARCHITECTURE §6). A transport only carries frames; it
// never decides what is true and never authenticates. Paths it yields are
// pending until the sync coordinator binds them to a device that proved its key.

export type Priority = "control" | "change" | "asset";

export interface PathMeasurements {
  rttMs: number | null;
  queuedBytes: number;
  sentBytes: number;
  receivedBytes: number;
}

/** Ordered, reliable frames to one peer, with backpressure. */
export interface Path {
  readonly id: string;
  readonly transport: string;
  /** Who started the connection, as the transport saw it. */
  readonly initiator: boolean;
  readonly remote: string;
  readonly limits: { maxFrameBytes: number; reliable: true; ordered: true };
  /** Resolves when the frame is handed to the network (waits on backpressure). */
  send(frame: Uint8Array, priority: Priority): Promise<void>;
  /** Next frame, or null once the path is closed. */
  next(): Promise<Uint8Array | null>;
  measurements(): PathMeasurements;
  recordRtt(ms: number): void;
  close(reason: string): void;
  readonly closed: Promise<string>;
}

/** Where a peer might be reached. Discovery is never authentication. */
export interface Candidate {
  transport: string;
  device: string | null;
  host: string;
  port: number;
}

export interface Transport {
  readonly name: string;
  /** Starts accepting. `onPath` gets each incoming, unauthenticated Path. */
  listen(onPath: (p: Path) => void): Promise<{ port: number }>;
  /** Starts discovery. `onCandidate` gets each peer seen (repeatedly). */
  discover(onCandidate: (c: Candidate) => void): void;
  dial(c: Candidate): Promise<Path>;
  close(): Promise<void>;
}
