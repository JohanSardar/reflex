// The sync coordinator: binds Paths to devices once they prove their key, and
// keeps every Space in sync with every bound peer through the kernel's sync
// protocol (one Automerge sync conversation per Space per peer).
//
// Messages on a session (after the handshake, all encrypted):
//   spaces        { spaces: [{ id, kind }] }    the Spaces this side holds
//   sync          { space } + kernel sync bytes
//   assets_have   { hashes }                    assets this side holds
//   asset_want    { hashes }
//   asset         { hash, off, size } + bytes   one part of at most 1 MiB, in order; the whole
//                                               asset is checked against the hash before it is kept
//   ping / pong   { n, at }                     RTT
//   agent_request { id, name, color }           an Agent is waiting for the person's approval (to iPads)
//   agent_decision { id, status }               the person's answer, from an iPad that paired
//                                               by scanning this Link's code
//
// Changes a peer sends are taken only if they were its to make: an iPad
// writes for its person, another Link for its person and the Agents it hosts
// (the kernel checks every record they touch). A peer that sends anything
// else is disconnected.
//
// Sync state is restartable: on every new binding it is reset, so the two
// sides run anti-entropy from scratch and repair anything a dropped
// connection lost. Duplicate deliveries are harmless.
import type { Catalog, PairedDevice } from "../pairing/catalog.ts";
import { handshake, type Me, type ScannedOffer, type Session } from "../pairing/handshake.ts";
import type { Offers, ParsedOffer } from "../pairing/offer.ts";
import type { AssetStore } from "../storage/assets.ts";
import type { SpaceStore } from "../storage/journal.ts";
import type { Candidate, Path, Transport } from "../transports/transport.ts";

const ASSET_PART = 1024 * 1024;

export interface Peer {
  /** Assets arriving from this peer, part by part. */
  incoming: Map<string, { size: number; parts: Buffer[]; got: number }>;
  /** Asset parts go out one at a time, each after the Path drains; control and sync frames don't wait behind them. */
  assetOut: Promise<void>;
  device: string;
  name: string;
  session: Session;
  initiator: string; // the device that dialed
  since: number;
}

type Log = (msg: string) => void;

export class Coordinator {
  #me: Me;
  #store: SpaceStore;
  #assets: AssetStore;
  #catalog: Catalog;
  #offers: Offers;
  #transports: Transport[];
  #log: Log;
  #peers = new Map<string, Peer>();
  #candidates = new Map<string, Candidate[]>();
  #dialing = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #onPaired: ((d: PairedDevice) => void)[] = [];
  #pings = 0;
  /** Agents waiting for approval, shown on every iPad that connects. */
  pendingAgents: () => { id: string; name: string; color: string }[] = () => [];
  /** The person's answer about an Agent, from a paired iPad. */
  onAgentDecision: (device: string, id: string, status: "approved" | "denied") => void = () => {};
  /** Called each time a peer is bound, after the coordinator's own opening messages. */
  onBound: (p: Peer) => void = () => {};
  /** Messages the coordinator itself doesn't handle (the Relay's `relay_keys`, link/relay/sync.ts). */
  onMessage: (p: Peer, h: Record<string, unknown>, body: Uint8Array) => void = () => {};

  constructor(opts: {
    me: Me;
    store: SpaceStore;
    assets: AssetStore;
    catalog: Catalog;
    offers: Offers;
    transports: Transport[];
    log: Log;
  }) {
    this.#me = opts.me;
    this.#store = opts.store;
    this.#assets = opts.assets;
    this.#catalog = opts.catalog;
    this.#offers = opts.offers;
    this.#transports = opts.transports;
    this.#log = opts.log;
    this.#store.onChange((space, origin) => {
      if (origin === "create") this.#announceSpaces();
      for (const p of this.#peers.values()) this.#pump(space, p);
    });
  }

  onPaired(fn: (d: PairedDevice) => void): void {
    this.#onPaired.push(fn);
  }

  peers(): Peer[] {
    return [...this.#peers.values()];
  }

  async start(): Promise<{ ports: Record<string, number> }> {
    const ports: Record<string, number> = {};
    for (const t of this.#transports) {
      const { port } = await t.listen((p) => void this.#accept(p));
      ports[t.name] = port;
      t.discover((c) => this.#candidate(c));
    }
    this.#timer = setInterval(() => this.#redial(), 2_000);
    this.#timer.unref();
    return { ports };
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    for (const p of this.#peers.values()) p.session.close("link stopping");
    await Promise.all(this.#transports.map((t) => t.close()));
  }

  #trust() {
    return {
      pairedKey: (device: string) => this.#catalog.device(device)?.key,
      offerSecret: (offer: string) => this.#offers.secret(offer),
    };
  }

  async #accept(path: Path): Promise<void> {
    try {
      const r = await handshake(path, this.#me, this.#trust());
      if (r.offer) {
        // A code is single-use, even when the device that used it was already paired.
        this.#offers.consume(r.offer);
        if (r.paired) this.#remember(r.peer, null, "offer");
        else for (const f of this.#onPaired) f(this.#catalog.device(r.peer.device)!);
      }
      this.#bind(r.session, r.peer.device, r.peer.name, r.peer.device);
    } catch (e) {
      this.#log(`refused a connection from ${path.remote}: ${(e as Error).message}`);
      // Say why, so the person pairing sees it. The reason reveals nothing secret.
      await path.send(Buffer.from(JSON.stringify({ t: "refused", reason: (e as Error).message })), "control").catch(() => {});
      setTimeout(() => path.close("handshake failed"), 100);
    }
  }

  #remember(peer: { device: string; key: string; person: PairedDevice["person"]; name: string; kind: "ipad" | "link" }, at: Candidate | null, via: "offer" | "join"): void {
    const d: PairedDevice = { device: peer.device, key: peer.key, name: peer.name, person: peer.person, kind: peer.kind, via, paired_at: Date.now() };
    this.#catalog.pairDevice(d);
    if (at) this.#catalog.seen(d.device, at.host, at.port);
    this.#log(`paired with ${peer.name} (${peer.device}, person ${peer.person.name})`);
    for (const f of this.#onPaired) f(d);
  }

  /** Scans a pairing code: reaches the offering device and pairs with it. */
  async join(offer: ParsedOffer): Promise<PairedDevice> {
    const scanned: ScannedOffer = { offer: offer.offer, device: offer.device, key: offer.key, secret: offer.secret };
    const errors: string[] = [];
    for (const host of offer.hosts) {
      const c: Candidate = { transport: "lan", device: offer.device, host, port: offer.port };
      let path: Path;
      try {
        const lan = this.#transports.find((t) => t.name === "lan");
        if (!lan) throw new Error("pairing needs the LAN transport");
        path = await lan.dial(c);
      } catch (e) {
        errors.push(`${host}: ${(e as Error).message}`);
        continue;
      }
      try {
        const r = await handshake(path, this.#me, this.#trust(), scanned);
        this.#remember(r.peer, c, "join");
        this.#bind(r.session, r.peer.device, r.peer.name, this.#me.key.device);
        return this.#catalog.device(r.peer.device)!;
      } catch (e) {
        path.close("pairing failed");
        errors.push(`${host}: ${(e as Error).message}`);
      }
    }
    throw new Error(`Could not pair with ${offer.name || offer.device}: ${errors.join("; ")}`);
  }

  #candidate(c: Candidate): void {
    if (!c.device || c.device === this.#me.key.device) return;
    const list = this.#candidates.get(c.device) ?? [];
    if (!list.some((x) => x.host === c.host && x.port === c.port)) list.unshift(c);
    this.#candidates.set(c.device, list.slice(0, 6));
    if (this.#catalog.device(c.device) && !this.#peers.has(c.device)) void this.#dial(c.device);
  }

  #redial(): void {
    for (const d of this.#catalog.devices()) if (!this.#peers.has(d.device)) void this.#dial(d.device);
    // Keep RTT fresh on live paths.
    for (const p of this.#peers.values()) void p.session.send({ t: "ping", n: ++this.#pings, at: Date.now() }, undefined, "control").catch(() => {});
  }

  async #dial(device: string): Promise<void> {
    if (this.#dialing.has(device) || this.#peers.has(device)) return;
    const known = this.#catalog.device(device);
    if (!known) return;
    const list = [...(this.#candidates.get(device) ?? [])];
    if (known.last_seen) list.push({ transport: "lan", device, host: known.last_seen.host, port: known.last_seen.port });
    // The LAN first; the Relay is the path for when the LAN can't reach the device.
    list.sort((a, b) => Number(a.transport === "relay") - Number(b.transport === "relay"));
    if (list.length === 0) return;
    this.#dialing.add(device);
    try {
      for (const c of list) {
        let path: Path;
        try {
          const t = this.#transports.find((x) => x.name === c.transport);
          if (!t) continue;
          path = await t.dial(c);
        } catch {
          continue;
        }
        try {
          const r = await handshake(path, this.#me, this.#trust());
          if (r.peer.device !== device) throw new Error(`expected ${device}, reached ${r.peer.device}`);
          if (c.transport === "lan") this.#catalog.seen(device, c.host, c.port);
          this.#bind(r.session, device, r.peer.name, this.#me.key.device);
          return;
        } catch (e) {
          path.close("handshake failed");
          this.#log(`could not connect to ${device} at ${c.host}:${c.port}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.#dialing.delete(device);
    }
  }

  /**
   * One live session per peer. If two exist (both sides dialed at once), both
   * sides keep the one dialed by the lower device ID, so they agree.
   */
  #bind(session: Session, device: string, name: string, initiator: string): void {
    const old = this.#peers.get(device);
    if (old) {
      if (old.initiator <= initiator) {
        session.close("duplicate path");
        return;
      }
      old.session.close("replaced by a preferred path");
    }
    const peer: Peer = { incoming: new Map(), assetOut: Promise.resolve(), device, name, session, initiator, since: Date.now() };
    this.#peers.set(device, peer);
    this.#log(`connected to ${name} (${device}) over ${session.path.transport} ${session.path.remote}`);
    for (const id of this.#store.ids()) this.#store.read(id, (s) => s.resetSync(device));
    void this.#loop(peer);
    this.#sendSpaces(peer);
    void peer.session.send({ t: "assets_have", hashes: this.#assets.list() }, undefined, "control").catch(() => {});
    for (const id of this.#store.ids()) this.#pump(id, peer);
    for (const a of this.pendingAgents()) void peer.session.send({ t: "agent_request", ...a }, undefined, "control").catch(() => {});
    this.onBound(peer);
  }

  /** Asks every connected iPad about an Agent waiting for approval. */
  askAboutAgent(a: { id: string; name: string; color: string }): void {
    for (const p of this.#peers.values()) void p.session.send({ t: "agent_request", ...a }, undefined, "control").catch(() => {});
  }

  /** Who a peer's changes may be written for, from its pairing record. */
  #writers(device: string): string {
    const d = this.#catalog.device(device);
    if (!d) return JSON.stringify({ people: [] });
    return JSON.stringify(d.kind === "ipad" ? { people: [d.person.id] } : { people: [d.person.id], agents: "*" });
  }

  #sendSpaces(p: Peer): void {
    const spaces = this.#store.ids().map((id) => ({ id, kind: this.#store.kind(id) }));
    void p.session.send({ t: "spaces", spaces }, undefined, "control").catch(() => {});
  }

  #announceSpaces(): void {
    for (const p of this.#peers.values()) this.#sendSpaces(p);
  }

  /** Tells peers about a newly stored asset. */
  announceAsset(hash: string): void {
    for (const p of this.#peers.values()) void p.session.send({ t: "assets_have", hashes: [hash] }, undefined, "control").catch(() => {});
  }

  #pump(space: string, p: Peer): void {
    if (this.#peers.get(p.device) !== p) return;
    const msg = this.#store.read(space, (s) => s.syncMessage(p.device));
    if (msg) void p.session.send({ t: "sync", space }, msg, "change").catch((e: Error) => this.#log(`could not send ${space} to ${p.name}: ${e.message}`));
  }

  async #loop(p: Peer): Promise<void> {
    try {
      for (;;) {
        const m = await p.session.next();
        if (!m) break;
        this.#handle(p, m.h, m.body);
      }
    } catch (e) {
      this.#log(`dropping ${p.name} (${p.device}): ${(e as Error).message}`);
      p.session.close("bad frame");
    }
    if (this.#peers.get(p.device) === p) {
      this.#peers.delete(p.device);
      for (const id of this.#store.ids()) this.#store.read(id, (s) => s.resetSync(p.device));
      this.#log(`disconnected from ${p.name} (${p.device})`);
    }
  }

  #handle(p: Peer, h: Record<string, unknown>, body: Uint8Array): void {
    switch (h.t) {
      case "spaces": {
        for (const s of (h.spaces as { id: string; kind: string }[]) ?? []) {
          if (!this.#store.has(s.id)) {
            this.#store.ensure(s.id, s.kind);
            this.#log(`now holding Space '${s.id}' from ${p.name}`);
          }
          this.#pump(s.id, p);
        }
        return;
      }
      case "sync": {
        const space = String(h.space);
        if (!this.#store.has(space)) return; // announced first, so this is a peer bug; anti-entropy repairs it
        const r = JSON.parse(this.#store.commit(space, `sync:${p.device}`, (s) => s.receiveSyncMessageChecked(p.device, body, this.#writers(p.device))));
        if (!r.ok) {
          this.#log(`refused changes to '${space}' from ${p.name} (${p.device}): ${r.errors.map((e: { msg: string }) => e.msg).join(" ")}`);
          p.session.close("unauthorized changes");
          return;
        }
        this.#pump(space, p); // the sync protocol needs a reply even when nothing changed
        return;
      }
      case "assets_have": {
        const want = ((h.hashes as string[]) ?? []).filter((x) => !this.#assets.has(x));
        if (want.length) void p.session.send({ t: "asset_want", hashes: want }, undefined, "control").catch(() => {});
        return;
      }
      case "asset_want": {
        for (const x of (h.hashes as string[]) ?? []) {
          if (!this.#assets.has(x)) continue;
          const bytes = this.#assets.get(x);
          for (let off = 0; off === 0 || off < bytes.length; off += ASSET_PART)
            p.assetOut = p.assetOut
              .then(() => {
                if (this.#peers.get(p.device) !== p) return;
                return p.session.send({ t: "asset", hash: x, off, size: bytes.length }, bytes.subarray(off, off + ASSET_PART), "asset");
              })
              .catch((e: Error) => this.#log(`could not send asset ${x} to ${p.name}: ${e.message}`));
        }
        return;
      }
      case "asset": {
        const hash = String(h.hash);
        const off = Number(h.off);
        const size = Number(h.size);
        if (this.#assets.has(hash)) return;
        let inc = p.incoming.get(hash);
        if (off === 0) p.incoming.set(hash, (inc = { size, parts: [], got: 0 }));
        if (!inc || inc.got !== off || inc.size !== size || off + body.length > size) {
          p.incoming.delete(hash);
          return this.#log(`dropped a malformed part of asset ${hash} from ${p.name}`);
        }
        inc.parts.push(Buffer.from(body));
        inc.got += body.length;
        if (inc.got < size) return;
        p.incoming.delete(hash);
        if (this.#assets.putVerified(hash, Buffer.concat(inc.parts))) this.announceAsset(hash);
        else this.#log(`rejected asset ${hash} from ${p.name}: bytes do not match the hash`);
        return;
      }
      case "agent_decision": {
        const d = this.#catalog.device(p.device);
        const status = h.status === "approved" ? "approved" : "denied";
        // Only a device the person paired by scanning this Link's own code may approve: an Agent with the
        // user's shell can make this Link join a device of its own, but it can't scan the code shown here.
        if (d?.kind !== "ipad" || d.via !== "offer") return this.#log(`ignored an Agent decision from ${p.name}: it did not pair by scanning this Link's code`);
        this.onAgentDecision(p.device, String(h.id), status);
        return;
      }
      case "ping":
        void p.session.send({ t: "pong", n: h.n, at: h.at }, undefined, "control").catch(() => {});
        return;
      case "pong":
        p.session.path.recordRtt(Date.now() - Number(h.at));
        return;
      default:
        return this.onMessage(p, h, body); // unknown message types from newer peers are ignored there
    }
  }
}
