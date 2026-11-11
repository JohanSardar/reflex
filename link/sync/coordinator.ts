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
//   agents        { agents: [{ id, name, color, status }] }   every known Agent (to iPads), for chips and history
//   refused       { space, reason }             the changes it sent to that Space were refused
//
// Changes a peer sends are taken only if they were its to make: an iPad
// writes for its person, another Link for its person and the Agents it hosts,
// and in a shared Space only as its role allows (link/sharing.ts; the kernel
// checks every record they touch). A peer whose changes to a Space are refused
// stops syncing that Space until it connects again. Another person's Link
// (met through an invite) syncs only the Spaces it shares with this one, and
// gets only the assets those Spaces refer to.
//
// A peer can be connected over several transports at once (LAN, Apple
// peer-to-peer). Every path stays open and whatever arrives on any of them is
// taken; this side sends over the fastest, chosen with hysteresis
// (./paths.ts). A path that closes or goes silent is dropped; if it was the
// one being sent on, the next best takes over at once.
//
// Sync state is restartable: on every new binding, and whenever the path
// being sent on is lost, it is reset, so the two sides run anti-entropy from
// scratch and repair anything a dropped connection lost. Duplicate
// deliveries are harmless: the same change arriving twice, over one path or
// two, changes nothing the second time (`everyPath` sends every change over
// every live path, to show it).
import type { Catalog, PairedDevice } from "../pairing/catalog.ts";
import type { Shares } from "../sharing.ts";
import { handshake, type Me, type Message, type PeerInfo, type ScannedOffer, type Session } from "../pairing/handshake.ts";
import type { Offers, ParsedOffer } from "../pairing/offer.ts";
import type { AssetStore } from "../storage/assets.ts";
import type { SpaceStore } from "../storage/journal.ts";
import type { Candidate, Path, Priority, Transport } from "../transports/transport.ts";
import { PathSet, SILENT_MS } from "./paths.ts";

const ASSET_PART = 1024 * 1024;

export interface Peer {
  /** Assets arriving from this peer, part by part, per path. */
  incoming: Map<string, { size: number; parts: Buffer[]; got: number }>;
  /** Asset parts go out one at a time, each after the Path drains; control and sync frames don't wait behind them. */
  assetOut: Promise<void>;
  device: string;
  name: string;
  /** Every live path to this peer; changes go out on `paths.active()`. */
  paths: PathSet;
  since: number;
  /** Spaces whose changes from this peer were refused: not synced with it again until it reconnects. */
  refused: Set<string>;
}

type Log = (msg: string) => void;

export class Coordinator {
  #me: Me;
  #store: SpaceStore;
  #assets: AssetStore;
  #catalog: Catalog;
  #offers: Offers;
  #shares: Shares;
  #transports: Transport[];
  #log: Log;
  #peers = new Map<string, Peer>();
  /** Other people's Agents, named by the Links of the people who shared Spaces with this one, by the device that said so. */
  #theirAgents = new Map<string, { id: string; name: string; color: string; from: string }>();
  #candidates = new Map<string, Candidate[]>();
  #dialing = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #onPaired: ((d: PairedDevice) => void)[] = [];
  #pings = 0;
  #everyPath: boolean;
  /** Agents waiting for approval, shown on every iPad that connects. */
  pendingAgents: () => { id: string; name: string; color: string }[] = () => [];
  /** The person's answer about an Agent, from a paired iPad. */
  onAgentDecision: (device: string, id: string, status: "approved" | "denied") => void = () => {};
  /** Called each time a peer is bound, before the coordinator's own opening messages. */
  onBound: (p: Peer) => void = () => {};
  /** Called when a bound peer's session ends. */
  onUnbound: (p: Peer) => void = () => {};
  /** Messages the coordinator itself doesn't handle (the Relay's `relay_keys`, link/relay/sync.ts). */
  onMessage: (p: Peer, h: Record<string, unknown>, body: Uint8Array) => void = () => {};
  /** The secret of a live invite to a shared Space (link/sharing.ts). */
  inviteSecret: (invite: string) => Uint8Array | undefined = () => undefined;
  /** Someone presented a live invite and proved it: record them before the session starts. Throws to refuse. */
  onInvited: (peer: PeerInfo, invite: string) => void = () => {};
  /** Wraps taking in another person's changes to a Space (link/relay/sync.ts keeps them out of this Link's log entries). */
  receiving: (space: string, apply: () => string) => string = (_space, apply) => apply();

  constructor(opts: {
    me: Me;
    store: SpaceStore;
    assets: AssetStore;
    catalog: Catalog;
    offers: Offers;
    shares: Shares;
    transports: Transport[];
    log: Log;
    /** Send every change over every live path, not just the fastest (duplicates are harmless). */
    everyPath?: boolean;
  }) {
    this.#shares = opts.shares;
    this.#me = opts.me;
    this.#store = opts.store;
    this.#assets = opts.assets;
    this.#catalog = opts.catalog;
    this.#offers = opts.offers;
    this.#transports = opts.transports;
    this.#log = opts.log;
    this.#everyPath = opts.everyPath ?? false;
    this.#store.onChange((space, origin) => {
      if (origin === "create") this.#announceSpaces();
      for (const p of this.#peers.values()) this.#pump(space, p);
    });
  }

  /** Starts another transport while running: a Relay room shared with another person, or an invite's room. */
  async addTransport(t: Transport): Promise<void> {
    if (this.#transports.includes(t)) return;
    this.#transports.push(t);
    await t.listen((p) => void this.#accept(p));
    t.discover((c) => this.#candidate(c));
  }

  async removeTransport(t: Transport): Promise<void> {
    this.#transports = this.#transports.filter((x) => x !== t);
    for (const [d, list] of this.#candidates) this.#candidates.set(d, list.filter((c) => c.transport !== t.name));
    await t.close();
  }

  /** Who is in which shared Space changed: say again which Spaces each peer gets, and drop peers left with none. */
  refresh(): void {
    for (const p of [...this.#peers.values()]) {
      const d = this.#catalog.device(p.device);
      if (!d || (d.person.id !== this.#me.person.id && !this.#store.ids().some((id) => this.#shares.allowed(d, id)))) {
        for (const e of p.paths.all()) e.session.close("no longer shares a Space with this Link");
        continue;
      }
      this.#sendSpaces(p);
      for (const id of this.#store.ids()) this.#pump(id, p);
    }
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
    for (const p of this.#peers.values()) for (const e of p.paths.all()) e.session.close("link stopping");
    await Promise.all(this.#transports.map((t) => t.close()));
  }

  #trust() {
    return {
      pairedKey: (device: string) => this.#catalog.device(device)?.key,
      offerSecret: (offer: string) => this.#offers.secret(offer),
      inviteSecret: (invite: string) => this.inviteSecret(invite),
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
      if (r.invite) this.onInvited(r.peer, r.invite);
      this.#bind(r.session, r.peer.device, r.peer.name, r.peer.device);
    } catch (e) {
      this.#log(`refused a connection from ${path.remote}: ${(e as Error).message}`);
      // Say why, so the person pairing sees it. The reason reveals nothing secret.
      await path.send(Buffer.from(JSON.stringify({ t: "refused", reason: (e as Error).message })), "control").catch(() => {});
      setTimeout(() => path.close("handshake failed"), 100);
    }
  }

  #remember(peer: { device: string; key: string; person: PairedDevice["person"]; name: string; kind: "ipad" | "link" }, at: Candidate | null, via: "offer" | "join" | "invite"): void {
    const d: PairedDevice = { device: peer.device, key: peer.key, name: peer.name, person: peer.person, kind: peer.kind, via, paired_at: Date.now() };
    this.#catalog.pairDevice(d);
    if (at) this.#catalog.seen(d.device, at.host, at.port);
    this.#log(`paired with ${peer.name} (${peer.device}, person ${peer.person.name})`);
    if (via !== "invite") for (const f of this.#onPaired) f(d);
  }

  /** Records another person's Link met through an invite: it syncs only the Spaces it shares with this one. */
  rememberGuest(peer: PeerInfo): void {
    const known = this.#catalog.device(peer.device);
    if (known && known.person.id === this.#me.person.id) throw new Error(`${peer.name} is already one of this person's devices`);
    if (!known) this.#remember(peer, null, "invite");
  }

  /** Forgets another person's Link (it shares nothing with this one any more) and ends its session. */
  forgetGuest(device: string): void {
    const d = this.#catalog.device(device);
    if (!d || d.via !== "invite") return;
    this.#catalog.forget("device", device);
    this.#candidates.delete(device);
    for (const e of this.#peers.get(device)?.paths.all() ?? []) e.session.close("removed from every shared Space");
    this.#log(`forgot ${d.name} (${device}): it shares no Space with this Link any more`);
  }

  /**
   * Presents an invite to the owner's Link: over the LAN at the addresses in it, then through `relay`
   * (a path in the invite's Relay room). Resolves once the owner's Link took it.
   */
  async presentInvite(inv: { invite: string; device: string; key: string; secret: Uint8Array; hosts: string[]; port: number; name: string }, relay?: () => Promise<Path>): Promise<PeerInfo> {
    const scanned: ScannedOffer = { offer: inv.invite, device: inv.device, key: inv.key, secret: inv.secret, invite: true };
    const errors: string[] = [];
    const lan = this.#transports.find((t) => t.name === "lan");
    const ways: { what: string; c: Candidate | null; dial: () => Promise<Path> }[] = [];
    if (lan)
      for (const host of inv.hosts) {
        const c: Candidate = { transport: "lan", device: inv.device, host, port: inv.port };
        ways.push({ what: host, c, dial: () => lan.dial(c) });
      }
    if (relay) ways.push({ what: "the Relay", c: null, dial: relay });
    for (const w of ways) {
      let path: Path;
      try {
        path = await w.dial();
      } catch (e) {
        errors.push(`${w.what}: ${(e as Error).message}`);
        continue;
      }
      try {
        const r = await handshake(path, this.#me, this.#trust(), scanned);
        this.rememberGuest(r.peer);
        if (w.c) this.#catalog.seen(r.peer.device, w.c.host, w.c.port);
        this.#bind(r.session, r.peer.device, r.peer.name, this.#me.key.device);
        return r.peer;
      } catch (e) {
        path.close("invite refused");
        errors.push(`${w.what}: ${(e as Error).message}`);
      }
    }
    throw new Error(`Could not reach ${inv.name}'s Link: ${errors.join("; ") || "no address to try"}`);
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
    if (!list.some((x) => x.transport === c.transport && x.host === c.host && x.port === c.port)) list.unshift(c);
    // The latest few per transport: a device with many LAN addresses must not push its Relay or
    // peer-to-peer candidate out.
    const per = new Map<string, number>();
    const kept = list.filter((x) => {
      const n = (per.get(x.transport) ?? 0) + 1;
      per.set(x.transport, n);
      return n <= 6;
    });
    this.#candidates.set(c.device, kept);
    if (this.#catalog.device(c.device) && !this.#peers.get(c.device)?.paths.on(c.transport)) void this.#dial(c.device);
  }

  #redial(): void {
    for (const d of this.#catalog.devices()) void this.#dial(d.device);
    // Keep RTT fresh on every live path, and drop paths that went silent (a network can vanish
    // without closing the socket).
    const now = Date.now();
    for (const p of this.#peers.values())
      for (const e of p.paths.all()) {
        if (now - e.lastHeard > SILENT_MS) {
          e.session.close(`heard nothing for ${Math.round((now - e.lastHeard) / 1000)} s`);
          continue;
        }
        void e.session.send({ t: "ping", n: ++this.#pings, at: now }, undefined, "control").catch(() => {});
      }
  }

  /** Dials a paired device on every transport it can be dialed on and has no path over yet. */
  async #dial(device: string): Promise<void> {
    if (this.#dialing.has(device)) return;
    const known = this.#catalog.device(device);
    // An iPad always dials its Link (it listens on no path); dialing it back
    // through the Relay would only cut into its own session.
    if (!known || known.kind === "ipad") return;
    const have = (t: string): boolean => Boolean(this.#peers.get(device)?.paths.on(t));
    // Where it was last reached goes first: it is the likeliest to work, and every miss costs a timeout.
    const list = [...(this.#candidates.get(device) ?? [])];
    if (known.last_seen) list.unshift({ transport: "lan", device, host: known.last_seen.host, port: known.last_seen.port });
    // The Relay is the path for when nothing closer reaches the device: it isn't dialed next to a live one.
    const reached = this.#peers.has(device);
    const todo = list.filter(
      (c, i) =>
        !have(c.transport) &&
        !(reached && c.transport === "relay") &&
        list.findIndex((x) => x.transport === c.transport && x.host === c.host && x.port === c.port) === i,
    );
    todo.sort((a, b) => Number(a.transport === "relay") - Number(b.transport === "relay"));
    if (todo.length === 0) return;
    this.#dialing.add(device);
    try {
      for (const name of new Set(todo.map((c) => c.transport))) {
        if (have(name) || (name === "relay" && this.#peers.has(device))) continue;
        const t = this.#transports.find((x) => x.name === name);
        if (!t) continue;
        // Every address at once: the first to connect is used, so dead addresses cost no time.
        let won = false;
        const first = await Promise.any(
          todo
            .filter((c) => c.transport === name)
            .map((c) =>
              t.dial(c).then((path) => {
                if (won) {
                  path.close("another address answered first");
                  throw new Error("late");
                }
                won = true;
                return { path, c };
              }),
            ),
        ).catch(() => null);
        if (!first) continue;
        const { path, c } = first;
        try {
          const r = await handshake(path, this.#me, this.#trust());
          if (r.peer.device !== device) throw new Error(`expected ${device}, reached ${r.peer.device}`);
          if (c.transport === "lan") this.#catalog.seen(device, c.host, c.port);
          this.#bind(r.session, device, r.peer.name, this.#me.key.device);
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
   * One live session per peer per transport. If two exist on one transport (both sides dialed
   * at once), both sides keep the one dialed by the lower device ID, so they agree. A session on
   * another transport is another path to the same peer.
   */
  #bind(session: Session, device: string, name: string, initiator: string): void {
    const transport = session.path.transport;
    const known = this.#peers.get(device);
    if (known) {
      const same = known.paths.on(transport);
      if (same) {
        if (same.initiator <= initiator) {
          session.close("duplicate path");
          return;
        }
        same.session.close("replaced by a preferred path");
      }
      known.paths.add(session, initiator);
      this.#log(`added a ${transport} path to ${name} (${session.path.remote}); ${known.paths.size} paths`);
      void this.#loop(known, session);
      return;
    }
    const peer: Peer = { incoming: new Map(), assetOut: Promise.resolve(), device, name, paths: new PathSet(), since: Date.now(), refused: new Set() };
    peer.paths.add(session, initiator);
    this.#peers.set(device, peer);
    this.#log(`connected to ${name} (${device}) over ${transport} ${session.path.remote}`);
    void this.#loop(peer, session);
    this.#fresh(peer);
  }

  /** Starts over with a peer on its active path: anti-entropy for every Space, assets, open questions. */
  #fresh(peer: Peer): void {
    for (const id of this.#store.ids()) this.#store.read(id, (s) => s.resetSync(peer.device));
    this.onBound(peer);
    this.#sendSpaces(peer);
    this.#send(peer, { t: "assets_have", hashes: this.#assets.list().filter((h) => this.#assetOk(peer, h)) });
    for (const id of this.#store.ids()) this.#pump(id, peer);
    if (!this.#own(peer)) return this.#nameAgents(peer); // another person's Link: the shared Spaces, and who its Agents are
    for (const a of this.pendingAgents()) this.#send(peer, { t: "agent_request", ...a });
    this.#sendAgents(peer);
  }

  /** Whether a peer is one of this person's own devices. */
  #own(p: Peer): boolean {
    return this.#catalog.device(p.device)?.person.id === this.#me.person.id;
  }

  /** Whether an asset may go to a peer: any to this person's devices; to someone else's, only what the Spaces it shares refer to. */
  #assetOk(p: Peer, hash: string): boolean {
    if (this.#own(p)) return true;
    const d = this.#catalog.device(p.device);
    return this.#store.ids().some((id) => this.#shares.allowed(d, id) && this.#refs(id).includes(hash));
  }

  /** Everything a Space's Elements and Sends say, where the assets they refer to are named. */
  #refs(space: string): string {
    return this.#store.read(space, (s) => {
      const scene = s.scene(JSON.stringify({ detail: "full" }));
      const sends: string[] = JSON.parse(scene).sends ?? [];
      return scene + sends.map((id) => s.send(id)).join("");
    });
  }

  /** Every Agent's name and color, so iPads can label Agent changes (their chips and history). */
  announceAgents(): void {
    for (const p of this.#peers.values()) if (this.#own(p)) this.#sendAgents(p);
    else this.#nameAgents(p);
  }

  #sendAgents(p: Peer): void {
    const agents = this.#catalog.agents().map(({ id, name, color, status }) => ({ id, name, color, status }));
    for (const a of this.#theirAgents.values()) if (!agents.some((x) => x.id === a.id)) agents.push({ id: a.id, name: a.name, color: a.color, status: "approved" });
    this.#send(p, { t: "agents", agents });
  }

  /** Sends a control message to a peer on its active path (for link.ts's and shared.ts's own messages). */
  send(p: Peer, h: Message["h"]): void {
    this.#send(p, h);
  }

  /**
   * Sends on the peer's active path. With `everyPath`, sync messages go over every live path, so
   * the same change arrives more than once.
   */
  #send(p: Peer, h: Message["h"], body?: Uint8Array, priority: Priority = "control"): void {
    const active = p.paths.active();
    const to = this.#everyPath && h.t === "sync" ? p.paths.all().map((e) => e.session) : active ? [active] : [];
    for (const s of to) void s.send(h, body, priority).catch((e: Error) => this.#log(`could not send ${h.t} to ${p.name} over ${s.path.transport}: ${e.message}`));
  }

  /** The names of this person's approved Agents, for the Links of people a Space is shared with: their iPads label those Agents' changes. */
  #nameAgents(p: Peer): void {
    const agents = this.#catalog
      .agents()
      .filter((a) => a.status === "approved")
      .map(({ id, name, color }) => ({ id, name, color }));
    this.#send(p, { t: "agent_names", agents });
  }

  /** Asks every connected iPad about an Agent waiting for approval. */
  askAboutAgent(a: { id: string; name: string; color: string }): void {
    for (const p of this.#peers.values()) if (this.#own(p)) this.#send(p, { t: "agent_request", ...a });
    this.announceAgents();
  }

  /** Who a peer's changes to a Space may be written for, from its pairing record and its role there. */
  #writers(device: string, space: string): string {
    return this.#shares.writers(this.#catalog.device(device), space);
  }

  #allowed(p: Peer, space: string): boolean {
    return !p.refused.has(space) && this.#shares.allowed(this.#catalog.device(p.device), space);
  }

  #sendSpaces(p: Peer): void {
    const spaces = this.#store.ids().filter((id) => this.#allowed(p, id)).map((id) => ({ id, kind: this.#store.kind(id) }));
    this.#send(p, { t: "spaces", spaces });
  }

  #announceSpaces(): void {
    for (const p of this.#peers.values()) this.#sendSpaces(p);
  }

  /** Tells peers about a newly stored asset. */
  announceAsset(hash: string): void {
    for (const p of this.#peers.values()) if (this.#assetOk(p, hash)) this.#send(p, { t: "assets_have", hashes: [hash] });
  }

  #pump(space: string, p: Peer): void {
    if (this.#peers.get(p.device) !== p || !this.#allowed(p, space)) return;
    const msg = this.#store.read(space, (s) => s.syncMessage(p.device));
    if (msg) this.#send(p, { t: "sync", space }, msg, "change");
  }

  async #loop(p: Peer, s: Session): Promise<void> {
    const transport = s.path.transport;
    try {
      for (;;) {
        const m = await s.next();
        if (!m) break;
        const e = p.paths.entry(s);
        if (e) e.lastHeard = Date.now();
        this.#handle(p, s, m.h, m.body);
      }
    } catch (e) {
      this.#log(`dropping the ${transport} path to ${p.name} (${p.device}): ${(e as Error).message}`);
      s.close("bad frame");
    }
    for (const k of p.incoming.keys()) if (k.startsWith(`${s.path.id}:`)) p.incoming.delete(k);
    if (this.#peers.get(p.device) !== p) return;
    const r = p.paths.remove(s);
    if (p.paths.size === 0) {
      this.#peers.delete(p.device);
      for (const id of this.#store.ids()) this.#store.read(id, (x) => x.resetSync(p.device));
      this.#log(`disconnected from ${p.name} (${p.device})`);
      this.onUnbound(p);
      return;
    }
    this.#log(`lost the ${transport} path to ${p.name}; ${p.paths.size} left`);
    if (r.wasActive && r.active) {
      // What was in flight on the lost path may be gone: start over on the one that is left.
      this.#log(`now sending to ${p.name} over ${r.active.path.transport} ${r.active.path.remote}`);
      this.#fresh(p);
    }
  }

  #handle(p: Peer, s: Session, h: Record<string, unknown>, body: Uint8Array): void {
    switch (h.t) {
      case "spaces": {
        for (const s of (h.spaces as { id: string; kind: string }[]) ?? []) {
          if (typeof s?.id !== "string" || !this.#allowed(p, s.id)) continue; // not shared with this peer
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
        if (!this.#store.has(space) || !this.#allowed(p, space)) return; // not announced, or not shared with this peer
        const apply = () => this.#store.commit(space, `sync:${p.device}`, (s) => s.receiveSyncMessageChecked(p.device, body, this.#writers(p.device, space)));
        const r = JSON.parse(this.#own(p) ? apply() : this.receiving(space, apply));
        if (!r.ok) {
          const reason = r.errors.map((e: { msg: string }) => e.msg).join(" ");
          this.#log(`refused changes to '${space}' from ${p.name} (${p.device}): ${reason}`);
          // That Space stops syncing with it until it reconnects; its other Spaces carry on.
          p.refused.add(space);
          this.#store.read(space, (s) => s.resetSync(p.device));
          this.#send(p, { t: "refused", space, reason });
          return;
        }
        this.#pump(space, p); // the sync protocol needs a reply even when nothing changed
        return;
      }
      case "assets_have": {
        const want = ((h.hashes as string[]) ?? []).filter((x) => !this.#assets.has(x));
        if (want.length) this.#send(p, { t: "asset_want", hashes: want });
        return;
      }
      case "asset_want": {
        for (const x of (h.hashes as string[]) ?? []) {
          if (!this.#assets.has(x) || !this.#assetOk(p, x)) continue;
          const bytes = this.#assets.get(x);
          // All parts of one asset go over the path that was active for its first part; the
          // other side puts parts together per path.
          let via: Session | null = null;
          for (let off = 0; off === 0 || off < bytes.length; off += ASSET_PART)
            p.assetOut = p.assetOut
              .then(() => {
                if (this.#peers.get(p.device) !== p) return;
                if (off === 0) via = p.paths.active();
                if (!via || !p.paths.entry(via)) return; // that path is gone; the peer asks again on the next one
                return via.send({ t: "asset", hash: x, off, size: bytes.length }, bytes.subarray(off, off + ASSET_PART), "asset");
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
        const key = `${s.path.id}:${hash}`;
        let inc = p.incoming.get(key);
        if (off === 0) p.incoming.set(key, (inc = { size, parts: [], got: 0 }));
        if (!inc || inc.got !== off || inc.size !== size || off + body.length > size) {
          p.incoming.delete(key);
          return this.#log(`dropped a malformed part of asset ${hash} from ${p.name}`);
        }
        inc.parts.push(Buffer.from(body));
        inc.got += body.length;
        if (inc.got < size) return;
        p.incoming.delete(key);
        if (this.#assets.putVerified(hash, Buffer.concat(inc.parts))) this.announceAsset(hash);
        else this.#log(`rejected asset ${hash} from ${p.name}: bytes do not match the hash`);
        return;
      }
      case "agent_names": {
        if (this.#own(p)) return;
        for (const [id, a] of [...this.#theirAgents]) if (a.from === p.device) this.#theirAgents.delete(id);
        for (const a of ((h.agents as { id?: unknown; name?: unknown; color?: unknown }[]) ?? []).slice(0, 100)) {
          if (typeof a?.id !== "string" || !a.id.startsWith("a_") || this.#catalog.agent(a.id)) continue;
          this.#theirAgents.set(a.id, { id: a.id, name: String(a.name ?? a.id).slice(0, 80), color: String(a.color ?? "violet").slice(0, 20), from: p.device });
        }
        for (const q of this.#peers.values()) if (this.#own(q)) this.#sendAgents(q);
        return;
      }
      case "agent_decision": {
        const d = this.#catalog.device(p.device);
        const status = h.status === "approved" ? "approved" : "denied";
        // Only a device the person paired by scanning this Link's own code may approve: an Agent with the
        // user's shell can make this Link join a device of its own, but it can't scan the code shown here.
        if (d?.kind !== "ipad" || d.via !== "offer" || d.person.id !== this.#me.person.id) return this.#log(`ignored an Agent decision from ${p.name}: it did not pair by scanning this Link's code`);
        this.onAgentDecision(p.device, String(h.id), status);
        return;
      }
      case "refused": {
        // This side's changes to a Space it doesn't own were refused (its person is a viewer there, or was
        // removed): start that Space over from the peer, dropping them, and say so.
        const space = String(h.space ?? "");
        if (!this.#store.has(space) || this.#shares.owns(space)) return this.#log(`${p.name} refused changes to '${space}': ${String(h.reason ?? "")}`);
        this.#log(`${p.name} refused this Link's changes to '${space}' (${String(h.reason ?? "")}); starting it over from ${p.name}`);
        this.#store.reset(space);
        for (const x of this.#peers.values()) this.#store.read(space, (s) => s.resetSync(x.device));
        this.#send(p, { t: "reset", space });
        return;
      }
      case "reset": {
        // The peer dropped the changes refused here: sync that Space with it again.
        const space = String(h.space ?? "");
        if (!p.refused.delete(space)) return;
        this.#store.read(space, (s) => s.resetSync(p.device));
        this.#pump(space, p);
        return;
      }
      case "ping":
        // Answered on the path it came on, so each path's RTT is its own.
        void s.send({ t: "pong", n: h.n, at: h.at }, undefined, "control").catch(() => {});
        return;
      case "pong": {
        s.path.recordRtt(Date.now() - Number(h.at));
        const from = p.paths.active();
        const to = p.paths.evaluate();
        if (to && from)
          this.#log(
            `now sending to ${p.name} over ${to.path.transport} (${to.measurements().rttMs} ms) instead of ${from.path.transport} (${from.measurements().rttMs} ms)`,
          );
        return;
      }
      default:
        return this.onMessage(p, h, body); // unknown message types from newer peers are ignored there
    }
  }
}
