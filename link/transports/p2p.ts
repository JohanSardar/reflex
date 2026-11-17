// Peer-to-peer transport: Apple peer-to-peer Wi-Fi (AWDL), so an iPad and
// this Mac stay connected with no shared Wi-Fi network. Node can't reach AWDL,
// so a small Apple-only Swift helper (`reflex-p2p`, in ./p2p) listens with
// Network.framework, advertises `_reflex-p2p._tcp` over Bonjour with
// peer-to-peer on, and pipes each connection's bytes here over stdio. Framing,
// the handshake and encryption are the same as on LAN; the helper never sees
// inside the bytes, and discovery is never authentication.
//
// The iPad dials; this side only listens. The helper is respawned if it dies.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { FramedPath } from "./framed.ts";
import type { Candidate, Path, Transport } from "./transport.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where `npm run build:p2p` puts the helper; REFLEX_P2P_HELPER overrides it. */
// The single-file build (dist/reflex.mjs, REFLEX_BIN) finds a prebuilt helper next to itself: the npx branch ships one.
export const HELPER =
  process.env.REFLEX_P2P_HELPER ??
  (process.env.REFLEX_BIN && existsSync(join(dirname(process.env.REFLEX_BIN), "reflex-p2p"))
    ? join(dirname(process.env.REFLEX_BIN), "reflex-p2p")
    : join(HERE, "p2p", ".build", "release", "reflex-p2p"));

const K = { ready: 1, open: 2, data: 3, closed: 4, log: 5, sent: 6 } as const;
/** Bytes handed to the helper but not yet taken by the network before `send` waits. */
const HIGH_WATER = 1024 * 1024;

function message(kind: number, conn: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const head = Buffer.alloc(9);
  head.writeUInt32BE(5 + payload.length, 0);
  head.writeUInt8(kind, 4);
  head.writeUInt32BE(conn, 5);
  return Buffer.concat([head, payload]);
}

class HelperPath extends FramedPath {
  #helper: Helper;
  #conn: number;
  #inFlight = 0;
  #drained: (() => void)[] = [];

  constructor(helper: Helper, conn: number, remote: string) {
    super("p2p", remote, false);
    this.#helper = helper;
    this.#conn = conn;
  }

  data(d: Buffer): void {
    this.onData(d);
  }

  /** The network took `n` bytes. */
  sent(n: number): void {
    this.#inFlight = Math.max(0, this.#inFlight - n);
    if (this.#inFlight <= HIGH_WATER) for (const r of this.#drained.splice(0)) r();
  }

  gone(reason: string): void {
    for (const r of this.#drained.splice(0)) r();
    this.finish(reason);
  }

  protected async write(bytes: Buffer): Promise<void> {
    this.#inFlight += bytes.length;
    this.#helper.write(message(K.data, this.#conn, bytes));
    if (this.#inFlight > HIGH_WATER) await new Promise<void>((r) => this.#drained.push(r));
  }

  protected queued(): number {
    return this.#inFlight;
  }

  protected destroy(): void {
    this.#helper.write(message(K.closed, this.#conn));
  }
}

/** One running reflex-p2p process. */
class Helper {
  #child: ChildProcessByStdio<Writable, Readable, null>;
  #buf = Buffer.alloc(0);
  #paths = new Map<number, HelperPath>();
  #onReady: (port: number) => void;
  #onPath: (p: Path) => void;
  #log: (m: string) => void;
  readonly exited: Promise<string>;

  constructor(
    args: string[],
    on: {
      ready: (port: number) => void;
      path: (p: Path) => void;
      log: (m: string) => void;
      txt?: Record<string, string>;
    },
  ) {
    this.#onReady = on.ready;
    this.#onPath = on.path;
    this.#log = on.log;
    this.#child = spawn(HELPER, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, REFLEX_P2P_TXT: JSON.stringify(on.txt ?? {}) },
    });
    this.#child.stdout.on("data", (d: Buffer) => this.#data(d));
    this.#child.stdin.on("error", () => {}); // the helper died; `exited` says so
    this.exited = new Promise((r) => {
      this.#child.once("error", (e) => r(e.message));
      this.#child.once("exit", (code, sig) => r(sig ? `killed by ${sig}` : `exited with ${code}`));
    }).then((why) => {
      for (const p of this.#paths.values()) p.gone(`peer-to-peer helper ${why}`);
      this.#paths.clear();
      return why as string;
    });
  }

  write(b: Buffer): void {
    if (this.#child.stdin?.writable) this.#child.stdin.write(b);
  }

  #data(d: Buffer): void {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d;
    while (this.#buf.length >= 4) {
      const n = this.#buf.readUInt32BE(0);
      if (this.#buf.length < 4 + n) break;
      const kind = this.#buf.readUInt8(4);
      const conn = this.#buf.readUInt32BE(5);
      const payload = this.#buf.subarray(9, 4 + n);
      this.#buf = this.#buf.subarray(4 + n);
      this.#handle(kind, conn, payload);
    }
  }

  #handle(kind: number, conn: number, payload: Buffer): void {
    switch (kind) {
      case K.ready:
        this.#onReady(Number(JSON.parse(payload.toString("utf8")).port));
        return;
      case K.open: {
        const { remote, interface: iface } = JSON.parse(payload.toString("utf8"));
        const p = new HelperPath(this, conn, `${remote} via ${iface}`);
        this.#paths.set(conn, p);
        this.#onPath(p);
        return;
      }
      case K.data:
        this.#paths.get(conn)?.data(Buffer.from(payload));
        return;
      case K.sent:
        this.#paths.get(conn)?.sent(payload.readUInt32BE(0));
        return;
      case K.closed:
        this.#paths.get(conn)?.gone(payload.toString("utf8") || "closed");
        this.#paths.delete(conn);
        return;
      case K.log:
        this.#log(`peer-to-peer: ${payload.toString("utf8")}`);
        return;
    }
  }

  kill(): void {
    this.#child.kill();
  }
}

export class P2pTransport implements Transport {
  readonly name = "p2p";
  #device: string;
  #port: number;
  #log: (m: string) => void;
  #helper: Helper | null = null;
  #closing = false;
  #txt: Record<string, string>;

  constructor(opts: { device: string; port?: number; log: (m: string) => void; txt?: Record<string, string> }) {
    this.#device = opts.device;
    this.#txt = opts.txt ?? {};
    this.#port = opts.port ?? 0;
    this.#log = opts.log;
  }

  /** Whether peer-to-peer can run here: macOS with the helper built. */
  static available(): { ok: true } | { ok: false; why: string } {
    if (process.platform !== "darwin") return { ok: false, why: "Apple peer-to-peer Wi-Fi needs macOS" };
    if (!existsSync(HELPER)) return { ok: false, why: `the helper isn't built (npm run build:p2p)` };
    return { ok: true };
  }

  listen(onPath: (p: Path) => void): Promise<{ port: number }> {
    return new Promise((resolve) => {
      let first = true;
      const run = (): void => {
        const h = new Helper(["--device", this.#device, "--port", String(this.#port)], {
          ready: (port) => {
            this.#port = port; // a respawned helper takes the same port, so the iPad finds it where it was
            if (first) resolve({ port });
            else this.#log(`peer-to-peer helper is back on :${port}`);
            first = false;
          },
          path: onPath,
          log: this.#log,
          txt: this.#txt,
        });
        this.#helper = h;
        void h.exited.then((why) => {
          if (this.#closing) return;
          this.#log(`peer-to-peer helper ${why}; starting it again in 2 s`);
          if (first) {
            first = false;
            resolve({ port: 0 });
          }
          setTimeout(() => !this.#closing && run(), 2_000).unref();
        });
      };
      run();
    });
  }

  discover(_onCandidate: (c: Candidate) => void): void {
    // The iPad finds this Link over peer-to-peer Bonjour and dials it.
  }

  dial(_c: Candidate): Promise<Path> {
    return Promise.reject(new Error("the peer-to-peer transport only accepts connections"));
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#helper?.kill();
    if (this.#helper) await this.#helper.exited;
  }
}
