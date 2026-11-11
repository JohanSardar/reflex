// A room: where one person's devices meet (relay/domain/wire.ts). It
// authenticates each device by its key, keeps presence, forwards end-to-end
// sealed frames between devices that accept each other, and passes log and
// grant requests on to the right log. It never sees a Space or a key.
//
// All its state lives on the sockets (`Sock.state`), so a Durable Object that
// hibernates between messages loses nothing.
import type { Hubs, Sock } from "./ports.ts";
import { deviceIdFor, hex, random, unb64url, verifyEd25519 } from "./seal.ts";
import { DEVICE_ID, frame, helloText, LOG_ID, MAX_FRAME, unframe, type Grant } from "./wire.ts";

type Msg = Record<string, unknown> & { t?: string; req?: unknown };

export class Room {
  readonly id: string;
  #sockets: () => Sock[];
  #hubs: Hubs;
  #log: (m: string) => void;

  constructor(id: string, sockets: () => Sock[], hubs: Hubs, log: (m: string) => void = () => {}) {
    this.id = id;
    this.#sockets = sockets;
    this.#hubs = hubs;
    this.#log = log;
  }

  /** A new WebSocket: challenge it. */
  open(s: Sock): void {
    const nonce = hex(random(16));
    s.state = { nonce, watch: [], logs: [] };
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
    s.state = { ...st, device, watch: [], logs: [] };
    s.send(JSON.stringify({ t: "welcome", device }));
    this.#log(`${device} joined room ${this.id}`);
    // `joined`: a new socket, so channels to the device's old one are gone.
    this.#presence(device, true, true);
  }

  /** Tells every socket watching `device` that it came or went. */
  #presence(device: string, online: boolean, joined = false): void {
    const msg = JSON.stringify(joined ? { t: "presence", device, online, joined } : { t: "presence", device, online });
    for (const o of this.#authed()) if (o.state.device !== device && o.state.watch.includes(device)) o.send(msg);
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
    if (!to || !to.state.watch.includes(me)) {
      s.send(JSON.stringify({ t: "undeliverable", device: f.device, ch: f.ch }));
      return;
    }
    to.send(frame(me, f.ch, f.payload));
  }

  async #control(s: Sock, m: Msg): Promise<void> {
    const st = s.state;
    const reply = (body: Record<string, unknown>) => s.send(JSON.stringify({ t: "result", req: m.req, ok: true, ...body }));
    const logId = (): string => {
      const id = String(m.log ?? "");
      if (!LOG_ID.test(id)) throw new Error("not a log ID");
      return id;
    };
    switch (m.t) {
      case "watch": {
        const devices = (Array.isArray(m.devices) ? m.devices : []).map(String).filter((d) => DEVICE_ID.test(d)).slice(0, 256);
        s.state = { ...st, watch: devices };
        const online = new Set(this.#authed().map((o) => o.state.device));
        for (const d of devices) s.send(JSON.stringify({ t: "presence", device: d, online: online.has(d) }));
        return;
      }
      case "close": {
        const to = this.#byDevice(String(m.device ?? ""));
        if (to?.state.watch.includes(st.device!)) to.send(JSON.stringify({ t: "close", device: st.device, ch: Number(m.ch) }));
        return;
      }
      case "log.append":
        return reply(await this.#hubs.log(logId()).append(String(m.token), this.id, (m.entries as string[]) ?? [], m.snapshot === true));
      case "log.read":
        return reply(await this.#hubs.log(logId()).read(String(m.token), Number(m.after ?? 0), Math.min(Number(m.limit ?? 500), 1000)));
      case "log.watch": {
        const log = logId();
        const r = await this.#hubs.log(log).watch(String(m.token), this.id);
        const now = s.state;
        if (!now.logs.includes(log)) s.state = { ...now, logs: [...now.logs, log].slice(-1024) };
        return reply(r);
      }
      case "log.assets":
        return reply(await this.#hubs.log(logId()).assetsHave(String(m.token), ((m.ids as string[]) ?? []).slice(0, 1000)));
      case "auth.lookup":
        return reply(await this.#hubs.auth().lookup(String(m.code ?? "")));
      case "grant.issue": {
        const g = m.grant as Grant;
        // The grant must come from the device on this socket.
        if (g?.device !== st.device) throw new Error("a grant must be issued by the device that sends it");
        await this.#hubs.log(logId()).issueGrant(String(m.token), g, String(m.sig), String(m.key), String(m.code));
        return reply({ grant: g.grant });
      }
      case "grant.revoke":
        await this.#hubs.log(logId()).revokeGrant(String(m.token), String(m.grant));
        return reply({});
      case "ping":
        return reply({ at: m.at });
      default:
        if (m.req !== undefined) throw new Error(`no request '${String(m.t)}'`);
    }
  }

  /** A log says it has new entries: tell every socket watching it. */
  notify(log: string, last: number): void {
    for (const s of this.#authed()) if (s.state.logs.includes(log)) s.send(JSON.stringify({ t: "log.new", log, last }));
  }
}
