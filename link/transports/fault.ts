// Fault injection: wraps another transport and drops, delays or duplicates
// its frames, in both directions. Opt-in only (`reflex link --fault`), to see
// what the Link does when a network misbehaves.
//
//   spec   = rule (";" rule)*
//   rule   = transport ":" setting ("," setting)*
//   setting= drop=<0..1> | dup=<0..1> | delay=<ms> | jitter=<ms>
//   e.g.   lan:delay=80,jitter=40;p2p:drop=0.01      lan:drop=1 (the LAN path is down)
//
// Delays keep frames in order, as a slow network does. A dropped or
// duplicated frame breaks the session's encryption (every frame has the next
// nonce), so the session is closed, and the coordinator reconnects and runs
// anti-entropy. That is the recovery being tested: a transport may lose a
// connection, never quietly lose or repeat a change.
import type { Candidate, Path, PathMeasurements, Priority, Transport } from "./transport.ts";

export interface Faults {
  drop: number;
  dup: number;
  delay: number;
  jitter: number;
}

const NONE: Faults = { drop: 0, dup: 0, delay: 0, jitter: 0 };

/** Parses a spec into faults per transport name. */
export function parseFaults(spec: string): Map<string, Faults> {
  const out = new Map<string, Faults>();
  for (const rule of spec.split(";").map((r) => r.trim()).filter(Boolean)) {
    const [name, settings = ""] = rule.split(":");
    const f: Faults = { ...NONE };
    for (const kv of settings.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [k, v] = kv.split("=");
      const n = Number(v);
      if (!(k in f) || !Number.isFinite(n) || n < 0 || ((k === "drop" || k === "dup") && n > 1))
        throw new Error(`bad fault setting '${kv}' (use drop=0..1, dup=0..1, delay=<ms>, jitter=<ms>)`);
      f[k as keyof Faults] = n;
    }
    out.set(name.trim(), f);
  }
  return out;
}

class FaultPath implements Path {
  #inner: Path;
  #faults: () => Faults;
  #outChain: Promise<void> = Promise.resolve();
  #inbox: (Uint8Array | null)[] = [];
  #waiters: ((f: Uint8Array | null) => void)[] = [];
  #inChain: Promise<void> = Promise.resolve();

  constructor(inner: Path, faults: () => Faults) {
    this.#inner = inner;
    this.#faults = faults;
    void this.#pull();
  }

  get id(): string {
    return this.#inner.id;
  }
  get transport(): string {
    return this.#inner.transport;
  }
  get initiator(): boolean {
    return this.#inner.initiator;
  }
  get remote(): string {
    return this.#inner.remote;
  }
  get limits(): Path["limits"] {
    return this.#inner.limits;
  }
  get closed(): Promise<string> {
    return this.#inner.closed;
  }

  /** How many copies of a frame get through (0, 1 or 2), and after how long. */
  #fate(): { copies: number; wait: number } {
    const f = this.#faults();
    const copies = Math.random() < f.drop ? 0 : Math.random() < f.dup ? 2 : 1;
    return { copies, wait: f.delay + (f.jitter ? Math.random() * f.jitter : 0) };
  }

  send(frame: Uint8Array, priority: Priority): Promise<void> {
    const { copies, wait } = this.#fate();
    // Chained so delayed frames still leave in order.
    this.#outChain = this.#outChain.then(async () => {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      for (let i = 0; i < copies; i++) await this.#inner.send(frame, priority).catch(() => {});
    });
    return this.#outChain;
  }

  async #pull(): Promise<void> {
    for (;;) {
      const f = await this.#inner.next();
      if (!f) {
        this.#inChain = this.#inChain.then(() => this.#deliver(null));
        return;
      }
      const { copies, wait } = this.#fate();
      this.#inChain = this.#inChain.then(async () => {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        for (let i = 0; i < copies; i++) this.#deliver(f);
      });
    }
  }

  #deliver(f: Uint8Array | null): void {
    const w = this.#waiters.shift();
    if (w) w(f);
    else this.#inbox.push(f);
  }

  next(): Promise<Uint8Array | null> {
    if (this.#inbox.length) {
      const f = this.#inbox.shift()!;
      if (f === null) this.#inbox.unshift(null); // stays closed
      return Promise.resolve(f);
    }
    return new Promise((r) => this.#waiters.push(r));
  }

  measurements(): PathMeasurements {
    return this.#inner.measurements();
  }
  recordRtt(ms: number): void {
    this.#inner.recordRtt(ms);
  }
  close(reason: string): void {
    this.#inner.close(reason);
  }
}

/** A transport whose Paths misbehave as `set` last said. */
export class FaultTransport implements Transport {
  #inner: Transport;
  #faults: Faults = { ...NONE };

  constructor(inner: Transport, faults?: Faults) {
    this.#inner = inner;
    if (faults) this.#faults = faults;
  }

  get name(): string {
    return this.#inner.name;
  }

  /** Changes the faults; live Paths take them from their next frame. */
  set(f: Faults | undefined): void {
    this.#faults = f ?? { ...NONE };
  }

  faults(): Faults {
    return this.#faults;
  }

  #wrap(p: Path): Path {
    return new FaultPath(p, () => this.#faults);
  }

  listen(onPath: (p: Path) => void): Promise<{ port: number }> {
    return this.#inner.listen((p) => onPath(this.#wrap(p)));
  }
  discover(onCandidate: (c: Candidate) => void): void {
    this.#inner.discover(onCandidate);
  }
  async dial(c: Candidate): Promise<Path> {
    return this.#wrap(await this.#inner.dial(c));
  }
  close(): Promise<void> {
    return this.#inner.close();
  }
}
