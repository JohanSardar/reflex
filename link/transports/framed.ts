// A Path over a byte stream: frames are length-prefixed (u32, big-endian).
// LAN (a TCP socket) and peer-to-peer (bytes piped through reflex-p2p) share
// it, so the two carry exactly the same frames.
import { randomBytes } from "node:crypto";
import type { Path, PathMeasurements, Priority } from "./transport.ts";

export const MAX_FRAME = 16 * 1024 * 1024;

export abstract class FramedPath implements Path {
  readonly id: string;
  readonly transport: string;
  readonly limits = { maxFrameBytes: MAX_FRAME, reliable: true, ordered: true } as const;
  readonly initiator: boolean;
  readonly remote: string;
  readonly closed: Promise<string>;
  #buf = Buffer.alloc(0);
  #frames: Uint8Array[] = [];
  #waiters: ((f: Uint8Array | null) => void)[] = [];
  #done = false;
  protected m: PathMeasurements = { rttMs: null, queuedBytes: 0, sentBytes: 0, receivedBytes: 0 };
  #resolveClosed!: (r: string) => void;

  constructor(transport: string, remote: string, initiator: boolean) {
    this.id = `${transport}-${randomBytes(4).toString("hex")}`;
    this.transport = transport;
    this.remote = remote;
    this.initiator = initiator;
    this.closed = new Promise((r) => (this.#resolveClosed = r));
  }

  /** Writes bytes to the stream; resolves once the stream can take more. */
  protected abstract write(bytes: Buffer): Promise<void>;
  /** Bytes written but not yet taken by the network. */
  protected abstract queued(): number;
  protected abstract destroy(): void;

  protected onData(d: Buffer): void {
    this.m.receivedBytes += d.length;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d;
    while (this.#buf.length >= 4) {
      const n = this.#buf.readUInt32BE(0);
      if (n > MAX_FRAME) {
        this.close(`frame of ${n} bytes is over the limit`);
        return;
      }
      if (this.#buf.length < 4 + n) break;
      const f = this.#buf.subarray(4, 4 + n);
      this.#buf = this.#buf.subarray(4 + n);
      const w = this.#waiters.shift();
      if (w) w(f);
      else this.#frames.push(f);
    }
  }

  protected finish(reason: string): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w(null);
    this.#resolveClosed(reason);
  }

  async send(frame: Uint8Array, _priority: Priority): Promise<void> {
    if (this.#done) throw new Error("path closed");
    if (frame.length > MAX_FRAME) throw new Error(`frame of ${frame.length} bytes is over the limit`);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(frame.length);
    this.m.sentBytes += frame.length + 4;
    await this.write(Buffer.concat([head, frame]));
  }

  next(): Promise<Uint8Array | null> {
    const f = this.#frames.shift();
    if (f) return Promise.resolve(f);
    if (this.#done) return Promise.resolve(null);
    return new Promise((r) => this.#waiters.push(r));
  }

  measurements(): PathMeasurements {
    return { ...this.m, queuedBytes: this.queued() };
  }

  recordRtt(ms: number): void {
    this.m.rttMs = this.m.rttMs === null ? ms : Math.round((this.m.rttMs * 0.7 + ms * 0.3) * 10) / 10;
  }

  close(reason: string): void {
    this.destroy();
    this.finish(reason);
  }
}
