// LAN transport: TCP for frames, Bonjour (`_reflex-link._tcp`) for discovery.
// Frames are length-prefixed (u32, big-endian). Bonjour only says where a
// device might be; the coordinator authenticates every Path itself.
import { Bonjour, type Service } from "bonjour-service";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { FramedPath } from "./framed.ts";
import type { Candidate, Path, Transport } from "./transport.ts";

export const SERVICE_TYPE = "reflex-link";

class TcpPath extends FramedPath {
  #socket: Socket;

  constructor(socket: Socket, initiator: boolean) {
    super("lan", `${socket.remoteAddress}:${socket.remotePort}`, initiator);
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.on("data", (d: Buffer) => this.onData(d));
    socket.on("close", () => this.finish("socket closed"));
    socket.on("error", (e) => this.finish(`socket error: ${e.message}`));
  }

  protected async write(bytes: Buffer): Promise<void> {
    if (this.#socket.write(bytes)) return;
    await new Promise<void>((r) => {
      const done = (): void => {
        this.#socket.off("drain", done);
        this.#socket.off("close", done);
        r();
      };
      this.#socket.once("drain", done);
      this.#socket.once("close", done);
    });
  }

  protected queued(): number {
    return this.#socket.writableLength;
  }

  protected destroy(): void {
    this.#socket.destroy();
  }
}

export class LanTransport implements Transport {
  readonly name = "lan";
  #server: Server | null = null;
  #bonjour: Bonjour | null = null;
  #device: string;
  #port: number;
  #advertise: boolean;
  #log: (msg: string) => void;
  #lastError = "";

  constructor(opts: { device: string; port: number; advertise?: boolean; log?: (msg: string) => void }) {
    this.#device = opts.device;
    this.#port = opts.port;
    this.#advertise = opts.advertise ?? true;
    this.#log = opts.log ?? (() => {});
  }

  /**
   * One mDNS responder for publishing and browsing. Its socket fails while the network changes
   * (Wi-Fi off: EADDRNOTAVAIL on every send); that is logged once, not thrown, so the Link keeps
   * running on its other paths and Bonjour picks up again when a network is back.
   */
  #mdns(): Bonjour {
    this.#bonjour ??= new Bonjour({}, (e: Error) => {
      if (e.message !== this.#lastError) this.#log(`LAN discovery: ${e.message}`);
      this.#lastError = e.message;
    });
    return this.#bonjour;
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
            this.#mdns().publish({
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
    const mdns = this.#mdns();
    const seen = (s: Service): void => {
      const dev = typeof s.txt?.dev === "string" ? s.txt.dev : null;
      if (dev === this.#device) return;
      const addrs = [...(s.addresses ?? [])].sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
      if (s.referer?.address && !addrs.includes(s.referer.address)) addrs.unshift(s.referer.address);
      for (const host of addrs) onCandidate({ transport: this.name, device: dev, host, port: s.port });
    };
    const browser = mdns.find({ type: SERVICE_TYPE });
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
