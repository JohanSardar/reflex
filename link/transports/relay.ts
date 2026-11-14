// Relay transport: one WebSocket to a Reflex Relay, demultiplexed into one
// logical Path per peer and channel (ARCHITECTURE §6). The relay only
// forwards; every Path still runs the end-to-end handshake, so the relay never
// sees a key or a change. Presence from the relay is discovery, never
// authentication.
//
// Wire format: relay/domain/wire.ts (`reflex-relay/v0`). It is restated here
// because nothing imports `relay/`.
import { createHash } from "node:crypto";
import { b64, signWith, type DeviceKey } from "../pairing/crypto.ts";
import type { Candidate, Path, PathMeasurements, Priority, Transport } from "./transport.ts";

export const RELAY_PROTOCOL = "reflex-relay/v0";
const MAX_FRAME = 4 * 1024 * 1024;
const OPENER = 0x8000_0000;
/** Wait on the socket's buffer above this, so a big asset doesn't hold up everything else for long. */
const HIGH_WATER = 2 * 1024 * 1024;

/** The room where one person's devices meet. */
export const roomFor = (person: string): string => createHash("sha256").update(`${RELAY_PROTOCOL} room ${person}`).digest("hex").slice(0, 32);

function frame(device: string, ch: number, payload: Uint8Array): Buffer {
  const id = Buffer.from(device);
  const head = Buffer.alloc(1 + id.length + 4);
  head[0] = id.length;
  id.copy(head, 1);
  head.writeUInt32BE(ch >>> 0, 1 + id.length);
  return Buffer.concat([head, payload]);
}

function unframe(b: Buffer): { device: string; ch: number; payload: Buffer } | null {
  if (b.length < 5 || b.length < 1 + b[0] + 4) return null;
  const n = b[0];
  return { device: b.subarray(1, 1 + n).toString(), ch: b.readUInt32BE(1 + n), payload: b.subarray(5 + n) };
}

class RelayPath implements Path {
  readonly id: string;
  readonly transport = "relay";
  readonly limits = { maxFrameBytes: MAX_FRAME, reliable: true, ordered: true } as const;
  readonly initiator: boolean;
  readonly remote: string;
  readonly closed: Promise<string>;
  readonly device: string;
  /** The channel number as this side writes it on the wire. */
  readonly wireCh: number;
  #t: RelayTransport;
  #frames: Uint8Array[] = [];
  #waiters: ((f: Uint8Array | null) => void)[] = [];
  #done = false;
  #m: PathMeasurements = { rttMs: null, queuedBytes: 0, sentBytes: 0, receivedBytes: 0 };
  #resolveClosed!: (r: string) => void;

  constructor(t: RelayTransport, device: string, ch: number, initiator: boolean) {
    this.#t = t;
    this.device = device;
    this.initiator = initiator;
    this.wireCh = initiator ? (ch | OPENER) >>> 0 : ch;
    this.id = `relay-${device}-${initiator ? "o" : "a"}${ch}`;
    this.remote = `${t.url} → ${device}`;
    this.closed = new Promise((r) => (this.#resolveClosed = r));
  }

  deliver(f: Uint8Array): void {
    this.#m.receivedBytes += f.length;
    const w = this.#waiters.shift();
    if (w) w(f);
    else this.#frames.push(f);
  }

  finish(reason: string): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w(null);
    this.#t.forget(this);
    this.#resolveClosed(reason);
  }

  async send(f: Uint8Array, _p: Priority): Promise<void> {
    if (this.#done) throw new Error("path closed");
    if (f.length > MAX_FRAME) throw new Error(`frame of ${f.length} bytes is over the limit`);
    this.#m.sentBytes += f.length;
    await this.#t.write(frame(this.device, this.wireCh, f));
  }

  next(): Promise<Uint8Array | null> {
    const f = this.#frames.shift();
    if (f) return Promise.resolve(f);
    if (this.#done) return Promise.resolve(null);
    return new Promise((r) => this.#waiters.push(r));
  }

  measurements(): PathMeasurements {
    return { ...this.#m, queuedBytes: this.#t.buffered() };
  }

  recordRtt(ms: number): void {
    this.#m.rttMs = this.#m.rttMs === null ? ms : Math.round(this.#m.rttMs * 0.7 + ms * 0.3);
  }

  close(reason: string): void {
    if (this.#done) return;
    this.#t.control({ t: "close", device: this.device, ch: this.wireCh });
    this.finish(reason);
  }
}

export class RelayTransport implements Transport {
  /** The live paired-device forwarding transport. */
  readonly name: string;
  readonly url: string;
  #key: DeviceKey;
  #room: () => string;
  #watch: () => string[];
  #log: (m: string) => void;
  #ws: WebSocket | null = null;
  #ready = false;
  #stopped = false;
  #backoff = 500;
  #onPath: ((p: Path) => void) | null = null;
  #onCandidate: ((c: Candidate) => void) | null = null;
  #paths = new Map<string, RelayPath>();
  #online = new Set<string>();
  #nextCh = 1;
  #watched = "";
  #timer: NodeJS.Timeout | null = null;
  /** Called each time the relay welcomes this device (on every reconnect). */
  onReady: () => void = () => {};

  constructor(o: { url: string; key: DeviceKey; room: () => string; watch: () => string[]; log: (m: string) => void; name?: string }) {
    this.name = o.name ?? "relay";
    this.url = o.url.replace(/\/+$/, "");
    this.#key = o.key;
    this.#room = o.room;
    this.#watch = o.watch;
    this.#log = o.log;
  }

  get connected(): boolean {
    return this.#ready;
  }

  async listen(onPath: (p: Path) => void): Promise<{ port: number }> {
    this.#onPath = onPath;
    this.#connect();
    // Paired devices change; tell the relay whom to accept frames from.
    this.#timer = setInterval(() => this.#sendWatch(), 5_000);
    this.#timer.unref();
    return { port: 0 };
  }

  discover(onCandidate: (c: Candidate) => void): void {
    this.#onCandidate = onCandidate;
    for (const d of this.#online) onCandidate({ transport: this.name, device: d, host: this.url, port: 0 });
  }

  async dial(c: Candidate): Promise<Path> {
    if (!this.#ready || !c.device) throw new Error("the relay is not connected");
    if (!this.#online.has(c.device)) throw new Error(`${c.device} is not on the relay`);
    const ch = this.#nextCh++ & 0x7fff_ffff;
    const p = new RelayPath(this, c.device, ch, true);
    this.#paths.set(p.id, p);
    return p;
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const p of [...this.#paths.values()]) p.close("transport closing");
    this.#ws?.close(1000, "link stopping");
  }

  // ---------- the socket ----------

  #connect(): void {
    if (this.#stopped) return;
    const url = `${this.url}/v0/connect?room=${this.#room()}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.#control(JSON.parse(ev.data));
      else this.#data(Buffer.from(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      const was = this.#ready;
      this.#ready = false;
      this.#watched = "";
      for (const p of [...this.#paths.values()]) p.finish("relay connection closed");
      this.#online.clear();
      if (was && this.name === "relay") this.#log(`relay: disconnected from ${this.url} (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
      if (this.#stopped) return;
      const t = setTimeout(() => this.#connect(), this.#backoff);
      t.unref();
      this.#backoff = Math.min(this.#backoff * 2, 30_000);
    };
    ws.onerror = () => {};
  }

  #control(m: Record<string, any>): void {
    switch (m.t) {
      case "challenge": {
        const sig = signWith(this.#key, `${RELAY_PROTOCOL} hello ${this.#room()} ${m.nonce}`);
        this.control({ t: "hello", device: this.#key.device, key: b64(this.#key.publicRaw), sig });
        return;
      }
      case "welcome":
        this.#ready = true;
        this.#backoff = 500;
        if (this.name === "relay") this.#log(`relay: connected to ${this.url} as ${this.#key.device}`);
        this.#sendWatch();
        this.onReady();
        return;
      case "presence": {
        const d = String(m.device);
        if (m.online) {
          // A device that joined anew lost every channel it had through its old socket.
          if (m.joined) for (const p of [...this.#paths.values()]) if (p.device === d) p.finish(`${d} reconnected to the relay`);
          this.#online.add(d);
          this.#onCandidate?.({ transport: this.name, device: d, host: this.url, port: 0 });
        } else {
          this.#online.delete(d);
          for (const p of [...this.#paths.values()]) if (p.device === d) p.finish(`${d} left the relay`);
        }
        return;
      }
      case "close":
      case "undeliverable": {
        // `close` names the channel as the other end wrote it; `undeliverable` as this end did.
        const mine = m.t === "undeliverable" ? (m.ch & OPENER) !== 0 : (m.ch & OPENER) === 0;
        const p = this.#paths.get(`relay-${m.device}-${mine ? "o" : "a"}${m.ch & 0x7fff_ffff}`);
        p?.finish(m.t === "close" ? "closed by the other device" : `${m.device} is not reachable on the relay`);
        return;
      }

    }
  }

  #data(b: Buffer): void {
    const f = unframe(b);
    if (!f) return;
    const theyOpened = (f.ch & OPENER) !== 0;
    const ch = f.ch & 0x7fff_ffff;
    const id = `relay-${f.device}-${theyOpened ? "a" : "o"}${ch}`;
    let p = this.#paths.get(id);
    if (!p) {
      if (!theyOpened) return; // a late frame for a channel this side already closed
      p = new RelayPath(this, f.device, ch, false);
      this.#paths.set(id, p);
      this.#onPath?.(p);
    }
    p.deliver(f.payload);
  }

  #sendWatch(): void {
    if (!this.#ready) return;
    const list = [...new Set(this.#watch())].sort();
    const key = list.join(",");
    if (key === this.#watched) return;
    this.#watched = key;
    this.control({ t: "watch", devices: list });
  }

  control(m: Record<string, unknown>): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(m));
  }

  async write(b: Buffer): Promise<void> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("relay connection closed");
    ws.send(b);
    while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 5));
  }

  buffered(): number {
    return this.#ws?.bufferedAmount ?? 0;
  }

  forget(p: RelayPath): void {
    this.#paths.delete(p.id);
  }
}
