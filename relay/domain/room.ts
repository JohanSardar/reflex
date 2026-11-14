// A room: where one person's devices meet (relay/domain/wire.ts). It
// authenticates device keys, keeps presence and forwards end-to-end sealed frames.
//
// All its state lives on the sockets (`Sock.state`), so a Durable Object that
// hibernates between messages loses nothing.
import type { Sock } from "./ports.ts";
import { deviceIdFor, hex, random, unb64url, verifyEd25519 } from "./seal.ts";
import { DEVICE_ID, frame, helloText, MAX_FRAME, unframe } from "./wire.ts";

type Msg = Record<string, unknown> & { t?: string; req?: unknown };

/** Whether a socket accepts frames from `device`: it watches it, or anyone in the room (`*`, an invite room). */
const watches = (s: Sock, device: string): boolean => s.state.watch.includes(device) || s.state.watch.includes("*");

export class Room {
  readonly id: string;
  #sockets: () => Sock[];
  #log: (m: string) => void;

  constructor(id: string, sockets: () => Sock[], log: (m: string) => void = () => {}) {
    this.id = id;
    this.#sockets = sockets;
    this.#log = log;
  }

  /** A new WebSocket: challenge it. */
  open(s: Sock): void {
    const nonce = hex(random(16));
    s.state = { nonce, watch: [] };
    s.send(JSON.stringify({ t: "challenge", nonce, room: this.id }));
  }

  #authed(): Sock[] {
    return this.#sockets().filter((s) => s.state?.device);
  }

  #byDevice(device: string): Sock | undefined {
    return this.#authed().find((s) => s.state.device === device);
  }

  async message(s: Sock, data: string | Uint8Array): Promise<void> {
    const st = s.state;
    if (typeof data !== "string") {
      if (!st?.device) return s.close(4401, "say hello first");
      return this.#forward(s, data);
    }
    let m: Msg;
    try {
      m = JSON.parse(data);
    } catch {
      return s.close(4400, "not JSON");
    }
    if (!st?.device) {
      if (m.t !== "hello") return s.close(4401, "say hello first");
      return this.#hello(s, m);
    }
    try {
      await this.#control(s, m);
    } catch (e) {
      if (m.req !== undefined) s.send(JSON.stringify({ t: "result", req: m.req, ok: false, error: (e as Error).message }));
    }
  }

  async #hello(s: Sock, m: Msg): Promise<void> {
    const st = s.state;
    const key = typeof m.key === "string" ? unb64url(m.key) : new Uint8Array();
    const device = String(m.device ?? "");
    const ok =
      key.length === 32 &&
      deviceIdFor(key) === device &&
      typeof m.sig === "string" &&
      (await verifyEd25519(key, helloText(this.id, st.nonce), unb64url(m.sig)));
    if (!ok) return s.close(4403, "the hello's signature or device ID does not check out");
    // One socket per device: a reconnect replaces the old one.
    for (const old of this.#authed()) if (old.state.device === device && old !== s) old.close(4409, "replaced by a newer connection");
    s.state = { ...st, device, watch: [] };
    s.send(JSON.stringify({ t: "welcome", device }));
    this.#log(`${device} joined room ${this.id}`);
    // `joined`: a new socket, so channels to the device's old one are gone.
    this.#presence(device, true, true);
  }

  /** Tells every socket watching `device` that it came or went. */
  #presence(device: string, online: boolean, joined = false): void {
    const msg = JSON.stringify(joined ? { t: "presence", device, online, joined } : { t: "presence", device, online });
    for (const o of this.#authed()) if (o.state.device !== device && watches(o, device)) o.send(msg);
  }

  closed(s: Sock): void {
    const device = s.state?.device;
    if (!device) return;
    // Only if no newer socket for the same device took over.
    if (!this.#authed().some((o) => o !== s && o.state.device === device)) this.#presence(device, false);
  }

  #forward(s: Sock, data: Uint8Array): void {
    const f = unframe(data);
    if (!f || data.length > MAX_FRAME + 64) return s.close(4400, "malformed frame");
    const me = s.state.device!;
    const to = this.#byDevice(f.device);
    if (!to || !watches(to, me)) {
      s.send(JSON.stringify({ t: "undeliverable", device: f.device, ch: f.ch }));
      return;
    }
    to.send(frame(me, f.ch, f.payload));
  }

  async #control(s: Sock, m: Msg): Promise<void> {
    const st = s.state;
    const reply = (body: Record<string, unknown>) => s.send(JSON.stringify({ t: "result", req: m.req, ok: true, ...body }));
    switch (m.t) {
      case "watch": {
        const devices = (Array.isArray(m.devices) ? m.devices : []).map(String).filter((d) => DEVICE_ID.test(d) || d === "*").slice(0, 256);
        s.state = { ...st, watch: devices };
        const online = new Set(this.#authed().map((o) => o.state.device));
        const any = devices.includes("*");
        for (const d of any ? [...online].filter((d) => d !== st.device) : devices) s.send(JSON.stringify({ t: "presence", device: d, online: online.has(d) }));
        return;
      }
      case "close": {
        const to = this.#byDevice(String(m.device ?? ""));
        if (to && watches(to, st.device!)) to.send(JSON.stringify({ t: "close", device: st.device, ch: Number(m.ch) }));
        return;
      }
      case "ping":
        return reply({ at: m.at });
      default:
        if (m.req !== undefined) throw new Error(`no request '${String(m.t)}'`);
    }
  }

}
