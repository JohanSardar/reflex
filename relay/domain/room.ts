// A room: where one person's devices meet (relay/domain/wire.ts), or the pairing room where a Link with a live
// typed code waits for an iPad that isn't nearby. It authenticates device keys, keeps presence and forwards
// end-to-end sealed frames. It never sees a key, a name or a byte of content: the devices' own handshake
// runs inside the frames (link/pairing/handshake.ts).
//
// Who may do what:
//   - A socket must sign the room's fresh challenge with the key its device ID comes from, within 10 s.
//     One socket per device: only that key can replace it.
//   - Frames reach a device only if it watches the sender. Presence is told only between two devices that
//     watch each other, so a stranger in a room learns nothing about who else is there.
//   - Limits per address keep any one address from filling a room, and in the pairing room each address
//     may open only a few channels a minute: every channel there is one try at someone's code.
//
// All its state lives on the sockets (`Sock.state`), so a Durable Object that hibernates between messages
// loses nothing.
import type { Sock } from "./ports.ts";
import { deviceIdFor, hex, random, unb64url, verifyEd25519 } from "./seal.ts";
import { DEVICE_ID, frame, helloText, MAX_FRAME, PAIRING_ROOM, unframe } from "./wire.ts";

type Msg = Record<string, unknown> & { t?: string; req?: unknown };

/** How long a socket may take to say hello. */
export const HELLO_MS = 10_000;
/**
 * Sockets from one address in a room, and in the pairing room in all. A person's room has no total: strangers
 * who learned its ID could fill one and shut the person's own devices out.
 */
export const LIMITS = {
  room: { sockets: Infinity, perAddress: 16 },
  pairing: { sockets: 1024, perAddress: 8 },
  /** New channels a minute in the pairing room: per socket, and summed over one address's sockets. */
  pairingOpens: { perSocket: 6, perAddress: 12 },
  /** Control messages a socket may send per minute (watch, close, ping). */
  controls: 120,
};

const OPENER = 0x8000_0000;
const watchList = (list: string[], device: string | undefined): boolean => device !== undefined && (list.includes(device) || list.includes("*"));
/** Whether a socket accepts frames from `device`: it watches it, or anyone in the room (`*`, the pairing room). */
const watches = (s: Sock, device: string | undefined): boolean => watchList(s.state.watch, device);

export class Room {
  readonly id: string;
  readonly pairing: boolean;
  #sockets: () => Sock[];
  #log: (m: string) => void;
  #now: () => number;

  constructor(id: string, sockets: () => Sock[], log: (m: string) => void = () => {}, now: () => number = Date.now) {
    this.id = id;
    this.pairing = id === PAIRING_ROOM;
    this.#sockets = sockets;
    this.#log = log;
    this.#now = now;
  }

  #limits() {
    return this.pairing ? LIMITS.pairing : LIMITS.room;
  }

  /** A new WebSocket: challenge it, unless the room or its address is full. `address`: where it came from. */
  open(s: Sock, address = ""): void {
    const now = this.#now();
    this.sweep(now);
    const others = this.#sockets().filter((o) => o !== s);
    const lim = this.#limits();
    s.state = { nonce: hex(random(16)), watch: [], address, at: now };
    if (others.length >= lim.sockets) return s.close(4429, "this room is full");
    if (address && others.filter((o) => o.state?.address === address).length >= lim.perAddress) return s.close(4429, "too many connections from your address in this room");
    s.send(JSON.stringify({ t: "challenge", nonce: s.state.nonce, room: this.id }));
  }

  /** Closes sockets that never said hello in time. Node calls it on a timer; a Durable Object on each event. */
  sweep(now = this.#now()): void {
    for (const o of this.#sockets()) if (!o.state?.device && o.state?.at !== undefined && now - o.state.at > HELLO_MS) o.close(4408, "no hello in time");
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
    if (data.length > 64 * 1024) return s.close(4400, "control message too long");
    let m: Msg;
    try {
      m = JSON.parse(data);
    } catch {
      return s.close(4400, "not JSON");
    }
    if (!st?.device) {
      if (m.t !== "hello") return s.close(4401, "say hello first");
      this.sweep();
      return this.#hello(s, m);
    }
    if (!this.#spend(s, "controls", LIMITS.controls)) return s.close(4429, "too many messages");
    try {
      await this.#control(s, m);
    } catch (e) {
      if (m.req !== undefined) s.send(JSON.stringify({ t: "result", req: m.req, ok: false, error: (e as Error).message }));
    }
  }

  /** Takes one from a socket's per-minute budget; false when it is spent. */
  #spend(s: Sock, what: "controls" | "opens", per: number): boolean {
    const now = this.#now();
    const recent = (s.state[what] ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= per) return false;
    s.state = { ...s.state, [what]: [...recent, now] };
    return true;
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
    this.#log(`${device} joined room ${this.pairing ? "(pairing)" : this.id}`);
    // Watching nobody yet, nobody hears of it: presence goes out once it says whom it watches (#watch).
  }

  closed(s: Sock): void {
    const device = s.state?.device;
    if (!device) return;
    // Only if no newer socket for the same device took over.
    if (this.#authed().some((o) => o !== s && o.state.device === device)) return;
    const msg = JSON.stringify({ t: "presence", device, online: false });
    for (const o of this.#authed()) if (o !== s && watches(o, device) && watches(s, o.state.device)) o.send(msg);
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
    // In the pairing room a new channel is one try at a code: a few a minute per socket and per address.
    if (this.pairing && f.ch & OPENER) {
      const key = `${f.device}/${f.ch}`;
      if (!(s.state.chans ?? []).includes(key)) {
        const now = this.#now();
        const fromAddress = this.#authed()
          .filter((o) => s.state.address && o.state.address === s.state.address)
          .reduce((n, o) => n + (o.state.opens ?? []).filter((t) => now - t < 60_000).length, 0);
        if (fromAddress >= LIMITS.pairingOpens.perAddress || !this.#spend(s, "opens", LIMITS.pairingOpens.perSocket)) {
          s.send(JSON.stringify({ t: "undeliverable", device: f.device, ch: f.ch, reason: "rate limited: too many pairing tries" }));
          return;
        }
        s.state = { ...s.state, chans: [...(s.state.chans ?? []), key].slice(-32) };
      }
    }
    to.send(frame(me, f.ch, f.payload));
  }

  async #control(s: Sock, m: Msg): Promise<void> {
    const st = s.state;
    const reply = (body: Record<string, unknown>) => s.send(JSON.stringify({ t: "result", req: m.req, ok: true, ...body }));
    switch (m.t) {
      case "watch": {
        const devices = (Array.isArray(m.devices) ? m.devices : []).map(String).filter((d) => DEVICE_ID.test(d) || d === "*").slice(0, 256);
        const before = st.watch;
        const first = !st.announced;
        s.state = { ...st, watch: devices, announced: true };
        const me = st.device!;
        // A device named that isn't here (or doesn't watch this one) is not reachable: say so, so a client stops waiting.
        const here = new Set(this.#authed().filter((o) => o !== s && watches(o, me)).map((o) => o.state.device));
        for (const d of devices) if (d !== "*" && !here.has(d) && !before.includes(d)) s.send(JSON.stringify({ t: "presence", device: d, online: false }));
        for (const o of this.#authed()) {
          if (o === s) continue;
          const d = o.state.device;
          const mutual = watchList(devices, d) && watches(o, me);
          // What this socket watches now, and is watched back by: it hears whether that device is here.
          if (watchList(devices, d) && !watchList(before, d) && watches(o, me)) s.send(JSON.stringify({ t: "presence", device: d, online: true }));
          // Devices that watch this one hear of it once they can reach each other. `joined`: a new socket, so
          // channels to the device's old one are gone (and a newly mutual pair has none yet).
          const was = watchList(before, d) && watches(o, me) && !first;
          if (mutual && !was) o.send(JSON.stringify({ t: "presence", device: me, online: true, joined: true }));
          else if (!mutual && was) o.send(JSON.stringify({ t: "presence", device: me, online: false }));
        }
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
