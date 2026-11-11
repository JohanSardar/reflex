// LAN transport: TCP for frames, Bonjour (`_reflex-link._tcp`) for discovery.
// Frames are length-prefixed (u32, big-endian). Bonjour only says where a
// device might be; the coordinator authenticates every Path itself.
import { Bonjour, type Service } from "bonjour-service";
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Candidate, Path, PathMeasurements, Priority, Transport } from "./transport.ts";

const MAX_FRAME = 16 * 1024 * 1024;
export const SERVICE_TYPE = "reflex-link";

class TcpPath implements Path {
  readonly id = "lan-" + randomBytes(4).toString("hex");
  readonly transport = "lan";
  readonly limits = { maxFrameBytes: MAX_FRAME, reliable: true, ordered: true } as const;
  readonly initiator: boolean;
  readonly remote: string;
  readonly closed: Promise<string>;
  #socket: Socket;
  #buf = Buffer.alloc(0);
  #frames: Uint8Array[] = [];
  #waiters: ((f: Uint8Array | null) => void)[] = [];
  #done = false;
  #m: PathMeasurements = { rttMs: null, queuedBytes: 0, sentBytes: 0, receivedBytes: 0 };
  #resolveClosed!: (r: string) => void;

  constructor(socket: Socket, initiator: boolean) {
    this.#socket = socket;
    this.initiator = initiator;
    this.remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.closed = new Promise((r) => (this.#resolveClosed = r));
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.on("data", (d: Buffer) => this.#onData(d));
    socket.on("close", () => this.#finish("socket closed"));
    socket.on("error", (e) => this.#finish(`socket error: ${e.message}`));
  }

  #onData(d: Buffer): void {
    this.#m.receivedBytes += d.length;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d;
    while (this.#buf.length >= 4) {
      const n = this.#buf.readUInt32BE(0);
      if (n > MAX_FRAME) return this.close(`frame of ${n} bytes is over the limit`);
      if (this.#buf.length < 4 + n) break;
      const f = this.#buf.subarray(4, 4 + n);
      this.#buf = this.#buf.subarray(4 + n);
      const w = this.#waiters.shift();
      if (w) w(f);
      else this.#frames.push(f);
    }
  }

  #finish(reason: string): void {
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
    this.#m.sentBytes += frame.length + 4;
    const ok = this.#socket.write(Buffer.concat([head, frame]));
    this.#m.queuedBytes = this.#socket.writableLength;
    if (!ok) {
      await new Promise<void>((r) => {
        const done = (): void => {
          this.#socket.off("drain", done);
          this.#socket.off("close", done);
          r();
        };
        this.#socket.once("drain", done);
        this.#socket.once("close", done);
      });
      this.#m.queuedBytes = this.#socket.writableLength;
    }
  }

  next(): Promise<Uint8Array | null> {
    const f = this.#frames.shift();
    if (f) return Promise.resolve(f);
    if (this.#done) return Promise.resolve(null);
    return new Promise((r) => this.#waiters.push(r));
  }

  measurements(): PathMeasurements {
    return { ...this.#m, queuedBytes: this.#socket.writableLength };
  }

  recordRtt(ms: number): void {
    this.#m.rttMs = this.#m.rttMs === null ? ms : Math.round(this.#m.rttMs * 0.7 + ms * 0.3);
  }

  close(reason: string): void {
    this.#socket.destroy();
    this.#finish(reason);
  }
}

export class LanTransport implements Transport {
  readonly name = "lan";
  #server: Server | null = null;
  #bonjour: Bonjour | null = null;
  #device: string;
  #port: number;
  #advertise: boolean;

  constructor(opts: { device: string; port: number; advertise?: boolean }) {
    this.#device = opts.device;
    this.#port = opts.port;
    this.#advertise = opts.advertise ?? true;
  }

  listen(onPath: (p: Path) => void): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((s) => onPath(new TcpPath(s, false)));
      const start = (port: number): void => {
        server.once("error", (e: NodeJS.ErrnoException) => {
          // The preferred port is taken (another Link on this machine): take any free one.
          if (e.code === "EADDRINUSE" && port !== 0) start(0);
          else reject(e);
        });
        server.listen(port, "0.0.0.0", () => {
          this.#server = server;
          const addr = server.address();
          const actual = typeof addr === "object" && addr ? addr.port : port;
          if (this.#advertise) {
            this.#bonjour ??= new Bonjour();
            this.#bonjour.publish({
              name: `Reflex Link ${this.#device}`,
              type: SERVICE_TYPE,
              port: actual,
              txt: { dev: this.#device, v: "0" },
              probe: false, // names carry the device ID, so they are unique by construction
            });
          }
          resolve({ port: actual });
        });
      };
      start(this.#port);
    });
  }

  discover(onCandidate: (c: Candidate) => void): void {
    this.#bonjour ??= new Bonjour();
    const seen = (s: Service): void => {
      const dev = typeof s.txt?.dev === "string" ? s.txt.dev : null;
      if (dev === this.#device) return;
      const addrs = [...(s.addresses ?? [])].sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
      if (s.referer?.address && !addrs.includes(s.referer.address)) addrs.unshift(s.referer.address);
      for (const host of addrs) onCandidate({ transport: this.name, device: dev, host, port: s.port });
    };
    const browser = this.#bonjour.find({ type: SERVICE_TYPE });
    browser.on("up", seen);
    browser.on("srv-update", seen);
    // Re-ask periodically so a peer that restarts is found again quickly.
    const t = setInterval(() => browser.update(), 5_000);
    t.unref();
  }

  dial(c: Candidate): Promise<Path> {
    return new Promise((resolve, reject) => {
      const s = createConnection({ host: c.host, port: c.port, timeout: 5_000 });
      s.once("connect", () => {
        s.setTimeout(0);
        resolve(new TcpPath(s, true));
      });
      s.once("timeout", () => {
        s.destroy();
        reject(new Error(`timed out reaching ${c.host}:${c.port}`));
      });
      s.once("error", reject);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.#bonjour ? this.#bonjour.unpublishAll(() => r()) : r()));
    this.#bonjour?.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }
}
