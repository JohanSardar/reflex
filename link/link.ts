// Reflex Link: composition of storage, Inbox, sync, transports, pairing,
// Agent approval and the Agent layer, behind two local sockets.
//
// One Link per user profile. Local clients connect to a socket (in a 0700
// folder) and present a per-profile credential:
//   link.sock   `admin.key`, for the person's own `reflex link` commands, and
//               `rpc.key` for the T5 low-level Agent calls
//   agent.sock  `rpc.key`, for the MCP and CLI surfaces (link/agent-host.ts)
// An Agent then says who it is with a credential it made itself; the first
// time, the person is asked to approve it, and until they do it sees nothing.
//
// Anything that grants access needs the person, not a credential file: new
// pairing codes are shown only on the Link's own terminal, and an Agent is
// approved only there or on an iPad that paired by scanning such a code.
// `admin.key` can still deny and revoke, and read status. Acting as the
// person (`dev` commands) needs a Link started with --dev.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { adoptPerson, home, identity, localKey, type Home, type Identity } from "./home.ts";
import { Catalog, type AgentRecord } from "./pairing/catalog.ts";
import { b64 } from "./pairing/crypto.ts";
import type { Me } from "./pairing/handshake.ts";
import { Offers, parseOffer, qrText } from "./pairing/offer.ts";
import { AssetStore } from "./storage/assets.ts";
import { openDb } from "./storage/db.ts";
import { Inbox } from "./storage/inbox.ts";
import { SpaceStore } from "./storage/journal.ts";
import { Coordinator, type Peer } from "./sync/coordinator.ts";
import { startAgentHost } from "./agent-host.ts";
import { route } from "./routing.ts";
import { Presence } from "./presence.ts";
import { socketPath as agentSocketPath } from "../agent/src/host/rpc.ts";
import { FaultTransport, parseFaults } from "./transports/fault.ts";
import { LanTransport } from "./transports/lan.ts";
import { startWebViewer } from "./web.ts";
import { RelayTransport, roomFor } from "./transports/relay.ts";
import type { Transport } from "./transports/transport.ts";
import { RelaySync } from "./relay/sync.ts";
import { Shares } from "./sharing.ts";
import { SharedSpaces } from "./shared.ts";
import { Here, type HereMessage } from "./here.ts";
import { P2pTransport } from "./transports/p2p.ts";

export class LinkError extends Error {
  reason: string;
  fix?: string;
  constructor(reason: string, message: string, fix?: string) {
    super(message);
    this.reason = reason;
    this.fix = fix;
  }
}

interface Conn {
  role: "admin" | "agent" | null;
  agent: AgentRecord | null;
}

export interface LinkOptions {
  dir: string;
  name?: string;
  port?: number;
  /** Use this terminal: show a pairing code on start and on Enter, and ask about new Agents. */
  prompt?: boolean;
  /** Allow acting as the person without an iPad (`dev` commands, `reflex dev person`). */
  dev?: boolean;
  /** The web viewer's loopback port (default 7421; any free one if taken). null turns it off. */
  webPort?: number | null;
  /** A Reflex Relay to sync through and keep the encrypted log on (ws:// or wss://). */
  relay?: string;
  /** Listen and discover on the local network (default true). */
  lan?: boolean;
  /** Apple peer-to-peer Wi-Fi next to LAN (default: on, on macOS with the helper built). */
  p2p?: boolean;
  /** Fault injection on the transports (link/transports/fault.ts), e.g. "lan:delay=80". Changeable while running. */
  fault?: string;
  /** Send every change over every live path, not just the fastest. */
  everyPath?: boolean;
  log?: (msg: string) => void;
}

const APPROVAL_WAIT_S = 300;
type Decision = "approved" | "denied" | "revoked";

export class Link {
  readonly dir: string;
  readonly home: Home;
  #opts: LinkOptions;
  #id!: Identity;
  #me!: Me;
  #inbox!: Inbox;
  #store!: SpaceStore;
  #assets!: AssetStore;
  #catalog!: Catalog;
  #offers = new Offers();
  #coord!: Coordinator;
  #server: Server | null = null;
  #agentServer: Server | null = null;
  #push: Awaited<ReturnType<typeof startAgentHost>> | null = null;
  #db!: DatabaseSync;
  #web: Awaited<ReturnType<typeof startWebViewer>> | null = null;
  #questions: AgentRecord[] = [];
  #rl: ReturnType<typeof createInterface> | null = null;
  #ports: Record<string, number> = {};
  #keys!: { rpc: string; admin: string };
  #decisions = new Map<string, (() => void)[]>();
  #faults: FaultTransport[] = [];
  #log: (msg: string) => void;
  #relay: RelaySync | null = null;
  #relayT: RelayTransport | null = null;
  /** A sign-in the person is approving in this terminal, step by step. */
  #signIn: ((line: string) => Promise<void>) | null = null;
  #shares!: Shares;
  #shared!: SharedSpaces;
  #here!: Here;

  constructor(opts: LinkOptions) {
    this.#opts = opts;
    this.dir = opts.dir;
    this.home = home(opts.dir);
    this.#log = opts.log ?? ((m) => console.log(`link: ${m}`));
  }

  async start(): Promise<void> {
    this.#id = identity(this.dir, { name: this.#opts.name });
    this.#me = { key: this.#id.key, person: this.#id.person, name: this.#id.name, kind: "link" };
    this.#keys = { rpc: localKey(this.dir, "rpc.key"), admin: localKey(this.dir, "admin.key") };
    this.#refuseSecondLink();

    const db = openDb(this.home.db);
    this.#db = db;
    this.#inbox = new Inbox(db);
    this.#store = new SpaceStore(db, this.#id.actor, this.#inbox);
    this.#assets = new AssetStore(this.home.assets);
    this.#catalog = new Catalog(db, this.#id.key);
    this.#shares = new Shares(this.#catalog, () => ({ person: this.#id.person, key: this.#id.key }));
    // Who each recovered Send goes to (link/routing.ts).
    this.#inbox.recipientsFor = (space, send) => route(db, this.#store, space, send);
    const rec = this.#store.recover();
    const devices = this.#catalog.devices();
    if (this.#catalog.rejected > 0) this.#log(`ignored ${this.#catalog.rejected} catalog records with bad signatures`);

    const transports: Transport[] = [];
    if (this.#opts.lan !== false) transports.push(new LanTransport({ device: this.#id.key.device, port: this.#opts.port ?? 7420 }));
    if (this.#opts.p2p !== false) {
      const p2p = P2pTransport.available();
      if (p2p.ok) transports.push(new P2pTransport({ device: this.#id.key.device, log: this.#log }));
      else this.#log(`peer-to-peer Wi-Fi is off: ${p2p.why}`);
    }
    if (this.#opts.relay) {
      this.#relayT = new RelayTransport({
        url: this.#opts.relay,
        key: this.#id.key,
        room: () => roomFor(this.#id.person.id),
        watch: () => this.#catalog.devices().map((d) => d.device),
        log: this.#log,
      });
      transports.push(this.#relayT);
      this.#relay = new RelaySync({
        db,
        store: this.#store,
        assets: this.#assets,
        catalog: this.#catalog,
        transport: this.#relayT,
        key: this.#id.key,
        person: () => this.#id.person,
        connected: (device) => this.#coord.peers().some((p) => p.device === device),
        // A Space this person was removed from no longer goes to its log.
        syncs: (space) => this.#shares.myRole(space) !== null,
        role: (space) => this.#shares.myRole(space),
        writers: (d, space) => this.#shares.writers(d, space),
        device: (id, space) => this.#shared.device(id, space),
        log: this.#log,
      });
    }
    this.#coord = new Coordinator({
      me: this.#me,
      store: this.#store,
      assets: this.#assets,
      catalog: this.#catalog,
      offers: this.#offers,
      shares: this.#shares,
      transports: this.#faulty(transports),
      log: this.#log,
      everyPath: this.#opts.everyPath,
    });
    this.#shared = new SharedSpaces({
      shares: this.#shares,
      store: this.#store,
      catalog: this.#catalog,
      coord: this.#coord,
      relay: this.#relay,
      relayUrl: this.#relayT?.url ?? null,
      me: () => ({ person: this.#id.person, key: this.#id.key, name: this.#id.name }),
      lanPort: () => this.#ports.lan,
      log: this.#log,
    });
    this.#shared.onChanged = () => this.#sharesChanged();
    // Who is here, in each Space (here.ts): routed on the same sessions as changes.
    this.#here = new Here({
      send: (to, m) => {
        const p = this.#coord.peers().find((x) => x.device === to);
        if (p) this.#coord.send(p, { t: "here", ...m });
      },
      peers: (space) =>
        this.#coord.peers().flatMap((p) => {
          const d = this.#catalog.device(p.device);
          if (!d || (space && !this.#shares.allowed(d, space))) return [];
          return [{ device: p.device, own: d.person.id === this.#id.person.id, link: d.kind !== "ipad" }];
        }),
      owns: (space) => this.#shares.owns(space),
      web: (m) => this.#web?.here(m),
    });
    this.#coord.onUnbound = (p) => this.#here.dropped(p.device);
    if (this.#relay) this.#coord.receiving = (space, apply) => this.#relay!.aside(space, apply);
    // Tell each device where this person's devices meet when the LAN can't reach them.
    this.#coord.onBound = (p) => {
      const own = this.#catalog.device(p.device)?.person.id === this.#id.person.id;
      // Membership records first, so a member's Link holds the Space before the coordinator announces it.
      this.#shared.bound(p);
      if (own && this.#catalog.device(p.device)?.kind === "ipad") this.#sendShares(p);
      this.#here.replay(p.device);
      if (!this.#relayT || !own) return;
      this.#coord.send(p, { t: "relay", url: this.#relayT.url, room: roomFor(this.#id.person.id) });
      // Another Link of this person keeps the same log: it gets the Space keys, end to end.
      const d = this.#catalog.device(p.device);
      if (d?.kind === "link" && d.person.id === this.#id.person.id)
        this.#coord.send(p, { t: "relay_keys", keys: this.#relay!.exportKeys() });
    };
    // What the person's iPads report: the Space on screen, the pen, recognized handwriting (presence.ts).
    const presence = new Presence(() => new Set(this.#coord.peers().map((p) => p.device)));
    this.#coord.onMessage = (p, h) => {
      const d = this.#catalog.device(p.device);
      const ownIpad = d?.kind === "ipad" && d.person.id === this.#id.person.id;
      if (ownIpad && h.t === "presence") this.#here.local(p.device, this.#id.person, d.name, h);
      if (ownIpad && presence.receive(p.device, h)) return;
      if (ownIpad) return void this.#ipadMessage(p, d, h);
      if (d?.kind !== "link") return;
      if (this.#shared.message(p, h)) return;
      if (h.t === "here")
        // Another person's Link speaks only for its person, unless it is the owner's Link passing on the others'.
        return this.#here.remote(p.device, h, (space, person) => this.#shares.allowed(d, space) && (d.person.id === this.#id.person.id || person === d.person.id || this.#shares.get(space)?.device === d.device));
      // Keys of shared Spaces come with their share records, from the owner.
      if (h.t === "relay_keys" && this.#relay && d.person.id === this.#id.person.id)
        this.#relay.importKeys(h.keys as { space: string; key: string }[], p.name, (space) => this.#shares.get(space) !== undefined);
    };
    this.#coord.onPaired((d) => process.stdout.write(`\nPaired with ${d.name} (${d.device}).\n`));
    this.#coord.pendingAgents = () => this.#catalog.agents().filter((a) => a.status === "pending").map(({ id, name, color }) => ({ id, name, color }));
    this.#coord.onAgentDecision = (device, id, status) => {
      if (this.#catalog.agent(id)?.status !== "pending") return;
      this.#decide(id, status, device);
    };
    // The Agent layer, on the durable Spaces and Inbox. Recipients are set before recovery indexes any Send.
    const host = await startAgentHost({
      db,
      home: this.dir,
      store: this.#store,
      inbox: this.#inbox,
      assets: this.#assets,
      assetAdded: (hash) => this.#coord.announceAsset(hash),
      catalog: this.#catalog,
      person: this.#id.person,
      socket: agentSocketPath(this.dir),
      token: this.#keys.rpc,
      devPerson: Boolean(this.#opts.dev),
      // Someone else's Space shared with this person: this person's own Agents don't see it.
      hidden: (space) => !this.#shares.owns(space),
      presence: () => ({
        devices: this.#coord.peers().filter((p) => this.#catalog.devices().find((d) => d.device === p.device)?.kind !== "link").length,
        viewing: presence.viewing(),
      }),
      writing: (space) => presence.writing(space),
      deviceHints: (space, region) => presence.hints(space, region),
      announce: (a) => this.#announce(a),
      decision: (id, ms, signal) => this.#waitDecision(id, ms, signal),
      log: (event, data = {}) => this.#log(`agent layer: ${event} ${JSON.stringify(data)}`),
    });
    this.#agentServer = host.server;
    this.#push = host;
    this.#nameMembers();
    this.#ports = (await this.#coord.start()).ports;
    this.#shared.start();
    await this.#listen();
    if (this.#opts.webPort !== null)
      this.#web = await startWebViewer({
        store: this.#store,
        assets: this.#assets,
        catalog: this.#catalog,
        person: () => this.#id.person,
        people: () => this.#shared.people(),
        here: () => this.#here.all(),
        port: this.#opts.webPort ?? 7421,
        log: this.#log,
      });
    writeFileSync(
      this.home.runtime,
      JSON.stringify({ pid: process.pid, socket: this.home.socket, lan: this.#ports.lan, p2p: this.#ports.p2p, device: this.#id.key.device }, null, 2),
    );
    this.#log(
      `${this.#id.name} (${this.#id.key.device}) for ${this.#id.person.name} · ${rec.spaces} Spaces, ` +
        `${rec.replayed} journal entries replayed, ${this.#inbox.all().length} Sends in the Inbox, ` +
        `${devices.length} paired devices · ${this.#ports.lan !== undefined ? `LAN :${this.#ports.lan}` : "no LAN"}` +
        `${this.#ports.p2p ? ` · peer-to-peer :${this.#ports.p2p}` : ""}${this.#relayT ? ` · Relay ${this.#relayT.url}` : ""} · ${this.home.socket}`,
    );
    // Like a pairing code, the viewer's address carries its key and is shown only here.
    if (this.#web) this.#log(`web viewer: ${this.#web.url}`);
    if (this.#opts.prompt && process.stdin.isTTY) this.#terminal();
  }

  /** Wraps the transports (LAN, peer-to-peer Wi-Fi where it runs, Relay) in fault injection when the Link was started with --fault. */
  #faulty(list: Transport[]): Transport[] {
    if (this.#opts.fault === undefined) return list;
    const faults = parseFaults(this.#opts.fault);
    this.#faults = list.map((t) => new FaultTransport(t, faults.get(t.name)));
    this.#log(`fault injection on: ${this.#opts.fault || "(nothing yet)"}`);
    return this.#faults;
  }

  /** This terminal: Enter shows a fresh pairing code; y or n answers the Agent question on screen. */
  #terminal(): void {
    this.#rl = createInterface({ input: process.stdin, output: process.stdout });
    this.#rl.on("line", (line) => {
      if (this.#signIn) return void this.#signIn(line);
      if (this.#relay && /^\s*[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}\s*$/.test(line)) return void this.#approveSignIn(line.trim().toUpperCase());
      if (/^\s*(invite|role|remove|shares)\b/i.test(line)) return void this.#shareCommand(line.trim());
      const a = this.#questions[0];
      if (a && this.#catalog.agent(a.id)?.status === "pending" && /^(y(es)?|n(o)?)$/i.test(line.trim())) {
        this.#questions.shift();
        this.#decide(a.id, /^y/i.test(line.trim()) ? "approved" : "denied", "terminal");
        return this.#ask();
      }
      if (this.#ports.lan === undefined) return void process.stdout.write("Pairing needs the LAN; this Link was started without it.\n");
      void this.showPairingCode();
    });
    if (this.#ports.lan !== undefined) void this.showPairingCode();
    if (this.#relay) process.stdout.write("\nTo let a cloud Agent in through the Relay, type the code its sign-in page shows.\n");
    process.stdout.write("To share a Space with someone: invite <space> [editor|viewer]. Then role <space> <person> <editor|viewer>, remove <space> <person>, shares.\n");
  }

  /** The person shares a Space from this terminal: invite, role, remove, shares. */
  #shareCommand(line: string): void {
    const [cmd, space = "", a = "", b = ""] = line.split(/\s+/);
    const say = (m: string): void => void process.stdout.write(m);
    try {
      switch (cmd.toLowerCase()) {
        case "invite": {
          const role = a === "viewer" ? "viewer" : "editor";
          const inv = this.#shared.invite(space, role);
          void qrText(inv.uri).then((qr) =>
            say(`\nInvite to '${space}' as ${role === "editor" ? "an editor" : "a viewer"} (single use, 24 hours). Send it to them; they open it on their iPad or run \`reflex link join '<invite>'\`.\n\n${qr}\n${inv.uri}\n`),
          );
          return;
        }
        case "role":
          if (b !== "editor" && b !== "viewer") return say("Usage: role <space> <person> <editor|viewer>\n");
          this.#shared.setRole(space, this.#personId(space, a), b);
          return say(`Done.\n`);
        case "remove":
          this.#shared.remove(space, this.#personId(space, a));
          return say(`Removed. '${space}' has a new key; their devices get nothing new from now on.\n`);
        default:
          return say(`${JSON.stringify(this.#shared.summary(), null, 2)}\n`);
      }
    } catch (e) {
      say(`${(e as Error).message}\n`);
    }
  }

  #owner<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw e instanceof LinkError ? e : new LinkError("not_owner", (e as Error).message);
    }
  }

  /** A person in a shared Space, by ID or by name. */
  #personId(space: string, who: string): string {
    const m = this.#shares.get(space)?.members.find((x) => x.person.id === who || x.person.name.toLowerCase() === who.toLowerCase());
    if (!m) throw new LinkError("unknown_person", `Nobody called '${who}' is in '${space}'.`, "Run `reflex link shares` to see who is.");
    return m.person.id;
  }

  /** What an iPad of this person's asks about sharing. Inviting and changing roles need an iPad that paired by scanning this Link's code. */
  #ipadMessage(p: Peer, d: { via?: string }, h: Record<string, unknown>): void {
    const reply = (m: { t: string; [k: string]: unknown }): void => this.#coord.send(p, m);
    const fail = (e: unknown): void => reply({ t: "share_error", message: (e as Error).message });
    const space = String(h.space ?? "");
    const person = d.via === "offer";
    try {
      switch (h.t) {
        case "invite_create": {
          if (!person) throw new Error("Only an iPad that paired by scanning this Link's code can invite people.");
          const inv = this.#shared.invite(space, h.role === "viewer" ? "viewer" : "editor");
          process.stdout.write(`\n${p.name} made an invite to '${space}' as ${inv.role}:\n${inv.uri}\n`);
          return reply({ t: "invite", space, role: inv.role, uri: inv.uri, expires: inv.expires });
        }
        case "member_set": {
          if (!person) throw new Error("Only an iPad that paired by scanning this Link's code can change who is in a Space.");
          const who = String(h.person ?? "");
          if (h.role === "remove") this.#shared.remove(space, who);
          else this.#shared.setRole(space, who, h.role === "viewer" ? "viewer" : "editor");
          return;
        }
        case "join_invite":
          this.#shared.join(String(h.uri ?? "")).then((r) => reply({ t: "joined", ...r }), fail);
          return;
      }
    } catch (e) {
      fail(e);
    }
  }

  /** Tells an iPad of this person's which shared Spaces there are, who is in each, and its person's role. */
  #sendShares(p: Peer): void {
    this.#coord.send(p, { t: "shares", shares: this.#shared.summary(), invites: this.#shared.invites.live().map((i) => i.invite) });
  }

  #sharesChanged(): void {
    this.#nameMembers();
    for (const p of this.#coord.peers()) {
      const d = this.#catalog.device(p.device);
      if (d?.kind === "ipad" && d.person.id === this.#id.person.id) this.#sendShares(p);
    }
  }

  /** People in shared Spaces, named in Send Bundles and scenes. */
  #nameMembers(): void {
    for (const pe of this.#shared.people()) this.#push?.core.name(pe.id, pe.name);
  }

  /**
   * A cloud Agent signing in through the Relay: the person typed the code its
   * sign-in page shows. They pick one Space and how long, here and only here.
   */
  async #approveSignIn(code: string): Promise<void> {
    const relay = this.#relay!;
    const say = (m: string): void => void process.stdout.write(m);
    let who: { client: string };
    try {
      who = await relay.lookup(code);
    } catch (e) {
      return say(`\n${(e as Error).message}\n`);
    }
    const spaces = this.#store.ids().filter((id) => this.#store.kind(id) === "space");
    if (!spaces.length) return say(`\n"${who.client}" wants a Space, but this Link has none yet.\n`);
    say(`\n"${who.client}" is signing in through the Relay and asks for one Space.\nWhich Space? (${spaces.join(", ")}) Press Enter alone to refuse.\n`);
    let space = "";
    this.#signIn = async (line) => {
      const v = line.trim();
      if (!space) {
        if (!v) {
          this.#signIn = null;
          return say("Refused. Nothing was shared.\n");
        }
        if (!spaces.includes(v)) return say(`No Space '${v}'. Which Space? (${spaces.join(", ")})\n`);
        space = v;
        return say(`For how long may "${who.client}" use '${space}'? [1h] (e.g. 30m, 8h, 7d)\n`);
      }
      const m = /^(\d+)\s*([mhd])$/.exec(v || "1h");
      const ms = m ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"] : NaN;
      if (!ms || ms > 30 * 86_400_000) return say("Give a time like 30m, 8h or 7d (at most 30d).\n");
      this.#signIn = null;
      try {
        const g = await relay.issue(code, space, ms, who.client);
        say(`Granted "${g.name}" '${g.space}' until ${new Date(g.expires).toLocaleString()} (${g.gid}). Its page continues now.\nTake it back any time: reflex link relay revoke ${g.gid}\n`);
      } catch (e) {
        say(`Could not grant it: ${(e as Error).message}\n`);
      }
    };
  }

  /** Prints a new single-use pairing code: a QR to scan, and the same code as text to type. */
  async showPairingCode(): Promise<void> {
    const uri = this.pairingCode();
    const qr = await qrText(uri);
    process.stdout.write(`\nPair an iPad: open Reflex, tap Connect, and scan this code or type it (single use, 10 minutes).\n\n${qr}\n${uri}\n\nPress Enter for a new code.\n`);
  }

  /** A new single-use pairing code. Only the process running the Link can make one; the RPC can't. */
  pairingCode(): string {
    return this.#offers.create({ device: this.#id.key.device, key: b64(this.#id.key.publicRaw), name: this.#id.name, person: this.#id.person }, this.#ports.lan).uri;
  }

  #ask(): void {
    const a = this.#questions.find((q) => this.#catalog.agent(q.id)?.status === "pending");
    this.#questions = a ? this.#questions.slice(this.#questions.indexOf(a)) : [];
    if (a) process.stdout.write(`\nAllow "${a.name}" (${a.id}) to use your Spaces? Answer here [y/N], or on your iPad.\n`);
  }

  #refuseSecondLink(): void {
    if (!existsSync(this.home.runtime)) return;
    const { pid } = JSON.parse(readFileSync(this.home.runtime, "utf8"));
    try {
      process.kill(pid, 0);
      if (pid !== process.pid)
        throw new LinkError("already_running", `A Link is already running from ${this.dir} (pid ${pid}).`, "Use that one, or pass --home for a second profile.");
    } catch (e) {
      if (e instanceof LinkError) throw e; // otherwise the old Link is gone
    }
  }

  async stop(): Promise<void> {
    this.#rl?.close();
    this.#push?.dispatcher.stop();
    await this.#web?.close();
    this.#signIn = null;
    await this.#shared?.stop();
    await new Promise<void>((r) => (this.#agentServer ? this.#agentServer.close(() => r()) : r()));
    await this.#coord.stop();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    rmSync(this.home.runtime, { force: true });
    rmSync(this.home.socket, { force: true });
  }

  // Local RPC

  #listen(): Promise<void> {
    rmSync(this.home.socket, { force: true }); // a stale socket from a Link that was killed
    return new Promise((resolve, reject) => {
      const server = createServer((s) => this.#serve(s));
      server.once("error", reject);
      server.listen(this.home.socket, () => {
        this.#server = server;
        resolve();
      });
    });
  }

  #serve(socket: Socket): void {
    const conn: Conn = { role: null, agent: null };
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req: { id: number; method: string; params?: Record<string, unknown> };
        try {
          req = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        this.#handle(conn, req.method, req.params ?? {})
          .then((result) => socket.writable && socket.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n"))
          .catch((e: Error) => {
            const err = e instanceof LinkError ? e : new LinkError("internal", e.message);
            if (!(e instanceof LinkError)) this.#log(`error in ${req.method}: ${e.stack ?? e.message}`);
            if (socket.writable)
              socket.write(JSON.stringify({ id: req.id, ok: false, error: { reason: err.reason, message: err.message, fix: err.fix } }) + "\n");
          });
      }
    });
  }

  async #handle(c: Conn, method: string, p: Record<string, unknown>): Promise<unknown> {
    if (method === "auth") {
      const role = p.role === "admin" ? "admin" : "agent";
      const want = Buffer.from(role === "admin" ? this.#keys.admin : this.#keys.rpc);
      const got = Buffer.from(String(p.key ?? ""));
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new LinkError("bad_credential", "Wrong local credential.");
      c.role = role;
      return { device: this.#id.key.device, name: this.#id.name, person: this.#id.person };
    }
    if (!c.role) throw new LinkError("not_authenticated", "Call auth first.");

    if (c.role === "admin") {
      const admin = this.#admin(method, p);
      if (admin) return admin;
    }
    if (method === "agent.hello") return this.#agentHello(c, p);
    if (method.startsWith("space.") || method.startsWith("inbox.") || method === "spaces.list") {
      if (c.role === "agent") {
        if (!c.agent) throw new LinkError("not_approved", "Say who you are first with agent.hello.");
        // Re-check every call, so a revoked Agent loses access at once.
        if (this.#catalog.agent(c.agent.id)?.status !== "approved")
          throw new LinkError("not_approved", `Agent ${c.agent.id} is no longer approved.`);
      }
      return this.#spaceCall(c, method, p);
    }
    throw new LinkError("unknown_method", `No method '${method}'.`);
  }

  // Agents

  async #agentHello(c: Conn, p: Record<string, unknown>): Promise<unknown> {
    const name = String(p.name ?? "").trim();
    const credential = String(p.credential ?? "");
    if (!name) throw new LinkError("missing_name", "An Agent must say its name.", 'Pass name, e.g. "Claude Code · reflex repo".');
    if (credential.length < 32) throw new LinkError("missing_credential", "An Agent must present a random credential of at least 32 characters.");
    let a = this.#catalog.byCredential(credential);
    if (!a) {
      a = this.#catalog.request(name, credential);
      this.#announce(a);
    }
    if (a.status === "pending") {
      const wait = Math.min(Number(p.wait_s ?? APPROVAL_WAIT_S), APPROVAL_WAIT_S);
      await this.#waitDecision(a.id, wait * 1000);
      a = this.#catalog.agent(a.id)!;
    }
    if (a.status === "pending")
      throw new LinkError("approval_pending", `Waiting for the user to approve ${a.name} (${a.id}).`, "Ask the person to tap Allow on their iPad, or answer y in the terminal running `reflex link`, then connect again.");
    if (a.status !== "approved") throw new LinkError("agent_denied", `The user ${a.status} ${a.name} (${a.id}).`);
    c.agent = a;
    return { agent: a.id, name: a.name, color: a.color };
  }

  /** Asks the person about a new Agent: on every connected iPad, and on this terminal. */
  #announce(a: AgentRecord): void {
    this.#log(`new Agent "${a.name}" (${a.id}) wants to use your Spaces. Allow it on your iPad or answer here.`);
    this.#coord.askAboutAgent({ id: a.id, name: a.name, color: a.color });
    if (!this.#rl) return;
    this.#questions.push(a);
    if (this.#questions.length === 1) this.#ask();
  }

  #waitDecision(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const list = this.#decisions.get(id) ?? [];
      const done = (): void => {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      list.push(done);
      this.#decisions.set(id, list);
    });
  }

  #decide(id: string, status: Decision, by: string): AgentRecord {
    const a = this.#catalog.decide(id, status, by);
    // The question is answered, on whichever surface: stop asking it here.
    this.#questions = this.#questions.filter((q) => q.id !== id);
    this.#log(`Agent ${a.name} (${a.id}) ${status} by ${by}`);
    this.#coord.announceAgents();
    for (const w of this.#decisions.get(id) ?? []) w();
    this.#decisions.delete(id);
    return a;
  }

  // Spaces, for approved Agents and the user's own commands

  #spaceCall(c: Conn, method: string, p: Record<string, unknown>): unknown {
    const space = String(p.space ?? "");
    const need = (): void => {
      if (!this.#store.has(space)) throw new LinkError("unknown_space", `No Space '${space}'.`, "Call spaces.list to see them, or space.open to make one.");
    };
    const now = Date.now();
    switch (method) {
      case "spaces.list":
        return this.#store.ids().map((id) => this.#store.info(id));
      case "space.open": {
        const { created } = this.#store.ensure(space, String(p.kind ?? "space"));
        return { ...this.#store.info(space), created };
      }
      case "space.read":
        need();
        return JSON.parse(this.#store.read(space, (s) => s.scene(JSON.stringify(p.query ?? {}))));
      case "space.apply": {
        need();
        if (!c.agent) throw new LinkError("not_an_agent", "Only an Agent can apply a batch.");
        const id = c.agent.id;
        const request = String(p.request ?? randomBytes(6).toString("hex"));
        return JSON.parse(this.#store.commit(space, "agent", (s) => s.applyAgentBatch(id, request, JSON.stringify(p.batch), now)));
      }
      case "inbox.pending":
        return this.#inbox.pending(this.#recipient(c), p.space ? space : undefined);
      case "inbox.delivered":
      case "inbox.ack":
      case "inbox.failed": {
        const send = String(p.send ?? "");
        const state = method === "inbox.ack" ? "acknowledged" : method === "inbox.delivered" ? "delivered" : "failed";
        this.#inbox.mark(space, send, this.#recipient(c), state, p.reason ? String(p.reason) : undefined);
        return { space, send, receipts: this.#inbox.receipts(space, send) };
      }
      default:
        throw new LinkError("unknown_method", `No method '${method}'.`);
    }
  }

  #recipient(c: Conn): string {
    if (c.agent) return `agent:${c.agent.id}`;
    throw new LinkError("not_an_agent", "Only an Agent has an Inbox.");
  }

  // The user's own commands

  #admin(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "status":
        return this.status();
      case "agents.list":
        return this.#catalog.agents();
      case "agents.decide": {
        const status = String(p.status);
        if (status === "approved")
          throw new LinkError(
            "needs_person",
            "Approving an Agent needs you, not a command: anything with your shell could run one.",
            "Tap Allow on your iPad, or answer y in the Link's terminal.",
          );
        if (status !== "denied" && status !== "revoked") throw new LinkError("bad_status", `'${status}' is not denied or revoked.`);
        return this.#decide(String(p.id), status, "command");
      }
      case "pair.offer":
      case "pair.wait":
        throw new LinkError("needs_person", "Pairing codes are shown only on the Link's own terminal.", "Press Enter in the terminal running `reflex link` for a new code.");
      case "pair.join":
        return this.#join(String(p.uri));
      case "dev.intent":
      case "dev.undo":
      case "dev.send": {
        // Acting as the person without an iPad: only on a Link started with --dev.
        if (!this.#opts.dev) throw new LinkError("needs_dev", "Acting as the person needs a Link started with --dev.", "Restart it with `reflex link --dev`.");
        const space = String(p.space ?? "");
        if (!this.#store.has(space)) throw new LinkError("unknown_space", `No Space '${space}'.`);
        const person = this.#id.person.id;
        const device = this.#id.key.device;
        const now = Date.now();
        if (method === "dev.intent")
          return JSON.parse(this.#store.commit(space, "person", (s) => s.applyUserIntent(person, device, JSON.stringify(p.intent), now)));
        if (method === "dev.undo") return JSON.parse(this.#store.commit(space, "person", (s) => s.undo(person, device, now)));
        return JSON.parse(this.#store.commit(space, "send", (s) => s.freezeSend(person, device, JSON.stringify(p.raw), now)));
      }
      case "library.list":
      case "library.edit": {
        // The person's own Library: list it, rename or delete an entry (SPEC §7). Applied as this
        // Link's person, so it syncs, shows in history, and undo brings it back.
        if (!this.#store.has("library")) {
          if (method === "library.list") return [];
          throw new LinkError("unknown_id", "The Library is empty: no Agent has saved anything yet.");
        }
        if (method === "library.list") {
          const scene = JSON.parse(this.#store.read("library", (s) => s.scene(JSON.stringify({ detail: "full", ids: [] }))));
          return ((scene.library ?? []) as { kind: string; name: string; summary?: string; by?: Record<string, string> }[]).map(({ kind, name, summary, by }) => ({ kind, name, summary, by }));
        }
        const intent = p.to ? { intent: "library_rename", kind: p.kind, name: p.name, to: p.to } : { intent: "library_delete", kind: p.kind, name: p.name };
        const r = JSON.parse(this.#store.commit("library", "person", (s) => s.applyUserIntent(this.#id.person.id, this.#id.key.device, JSON.stringify(intent), Date.now())));
        if (!r.ok) throw new LinkError(r.errors?.[0]?.code ?? "invalid_input", r.errors?.[0]?.msg ?? "The Library change was refused.", r.errors?.[0]?.fix);
        return { ...intent, entry: r.entry };
      }
      case "assets.put": {
        const hash = this.#assets.put(Buffer.from(String(p.base64 ?? ""), "base64"));
        this.#coord.announceAsset(hash);
        return { hash };
      }
      case "assets.get": {
        return { hash: p.hash, base64: this.#assets.get(String(p.hash)).toString("base64") };
      }
      case "fault": {
        if (!this.#faults.length)
          throw new LinkError("needs_fault", "Fault injection needs a Link started with --fault.", 'Restart it with `reflex link --fault ""`.');
        let faults;
        try {
          faults = parseFaults(String(p.spec ?? ""));
        } catch (e) {
          throw new LinkError("bad_fault", (e as Error).message);
        }
        for (const t of this.#faults) t.set(faults.get(t.name));
        this.#log(`fault injection now: ${String(p.spec) || "(none)"}`);
        return Object.fromEntries(this.#faults.map((t) => [t.name, t.faults()]));
      }
      case "inbox.all":
        return this.#inbox.all().map((e) => ({ ...e, receipts: this.#inbox.receipts(e.space, e.send) }));
      case "relay.grants":
        return this.#needRelay().grants();
      case "relay.revoke":
        // Taking access away is always allowed; giving it needs the person at the terminal.
        return this.#needRelay().revoke(String(p.grant ?? ""));
      case "share.list":
        return { shares: this.#shared.summary(), invites: this.#shared.invites.live().map(({ invite, space, role, expires }) => ({ invite, space, role, expires })) };
      case "share.join":
        return this.#shared.join(String(p.uri ?? "")).catch((e: Error) => {
          throw new LinkError("join_failed", e.message, "Check the invite is whole and fresh, and that its Link is running.");
        });
      case "share.invite":
        throw new LinkError("needs_person", "Inviting someone gives them a Space, so it needs you, not a command.", "Type `invite <space> [editor|viewer]` in the terminal running `reflex link`, or tap Share on your iPad.");
      case "share.role": {
        // Taking access away is always allowed; giving more needs the person.
        if (p.role !== "viewer")
          throw new LinkError("needs_person", "Making someone an editor gives them more, so it needs you, not a command.", "Type `role <space> <person> editor` in the Link's terminal, or use your iPad.");
        const space = String(p.space ?? "");
        return this.#owner(() => this.#shared.setRole(space, this.#personId(space, String(p.person ?? "")), "viewer"));
      }
      case "share.remove": {
        const space = String(p.space ?? "");
        return this.#owner(() => this.#shared.remove(space, this.#personId(space, String(p.person ?? ""))));
      }
      case "relay.issue":
        throw new LinkError("needs_person", "A cloud Agent gets a Space only when you type its sign-in code into the Link's terminal.", "Type the code its sign-in page shows into the terminal running `reflex link`.");
      default:
        return undefined;
    }
  }

  async #join(uri: string): Promise<unknown> {
    let offer;
    try {
      offer = parseOffer(uri);
    } catch (e) {
      throw new LinkError("bad_pairing_code", (e as Error).message);
    }
    if (offer.device === this.#id.key.device) throw new LinkError("own_code", "That is this Link's own pairing code.", "Scan it from the other device.");
    // A device that holds nothing yet becomes the offering person's device.
    if (offer.person.id !== this.#id.person.id && this.#store.ids().length === 0 && this.#catalog.devices().length === 0) {
      adoptPerson(this.dir, offer.person);
      this.#id.person = offer.person;
      this.#me.person = offer.person;
      this.#log(`this device now belongs to ${offer.person.name} (${offer.person.id})`);
    }
    try {
      return await this.#coord.join(offer);
    } catch (e) {
      throw new LinkError("pairing_failed", (e as Error).message, "Check both devices are on the same network and the code is fresh.");
    }
  }

  #needRelay(): RelaySync {
    if (!this.#relay) throw new LinkError("no_relay", "This Link isn't using a Relay.", "Start it with `reflex link --relay <url>`.");
    return this.#relay;
  }

  status(): unknown {
    return {
      device: this.#id.key.device,
      name: this.#id.name,
      person: this.#id.person,
      lan_port: this.#ports.lan,
      p2p_port: this.#ports.p2p ?? null,
      socket: this.home.socket,
      spaces: this.#store.ids().map((id) => this.#store.info(id)),
      journal: this.#store.journalStats(),
      assets: this.#assets.list().length,
      inbox: this.#inbox.all().map((e) => ({ space: e.space, send: e.send, via: e.via, receipts: this.#inbox.receipts(e.space, e.send) })),
      paired: this.#catalog.devices().map((d) => ({ device: d.device, name: d.name, person: d.person, connected: this.#coord.peers().some((p) => p.device === d.device) })),
      peers: this.#coord.peers().map((p) => {
        const active = p.paths.active();
        const path = (s: NonNullable<typeof active>) => ({ transport: s.path.transport, remote: s.path.remote, ...s.measurements() });
        return {
          device: p.device,
          name: p.name,
          since: p.since,
          ...(active ? path(active) : {}),
          paths: p.paths.all().map((e) => ({ ...path(e.session), active: e.session === active, since: e.since })),
        };
      }),
      agents: this.#catalog.agents().map((a) => ({ id: a.id, name: a.name, status: a.status, color: a.color })),
      relay: this.#relay ? { ...this.#relay.status(), grants: this.#relay.grants() } : null,
      shares: this.#shared.summary(),
      here: this.#here.all(),
      push: {
        targets: (this.#push?.pushes.all() ?? []).map((t) => ({ ...t, live: this.#push?.live(t) ?? false })),
        attempts: this.#push?.pushes.attempts({ limit: 20 }) ?? [],
      },
    };
  }
}
