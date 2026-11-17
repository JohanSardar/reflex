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
// Approving an Agent needs the person: Allow on an approving iPad
// (catalog.ts mayApprove), or `y` in the Link's own terminal while no iPad
// approves yet. The first approving iPad pairs with a code from this terminal,
// or with a `reflex pair` code within 15 minutes of the profile's creation (or
// of forgetting the last approving iPad). After that only an approving iPad
// makes another one approve ("Let … approve Agents?"): the person's iPad is
// the boundary, not this terminal, which anything with the person's shell can
// run. No command approves an Agent; deny, revoke, forget and status need only
// `admin.key`. Code running as the person's OS user can still forge state (it
// can read identity.json and sign catalog records) until the keys move to the
// Keychain or the Secure Enclave. Acting as the person (`dev` commands) needs a
// Link started with --dev.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { socketPath as agentSocketPath, lines } from "../agent/src/host/rpc.ts";
import { startAgentHost } from "./agent-host.ts";
import { adoptPerson, type Home, home, type Identity, identity, localKey } from "./home.ts";
import { type AgentRecord, Catalog, mayApprove, type PairedDevice } from "./pairing/catalog.ts";
import { b64, newDeviceKey } from "./pairing/crypto.ts";
import type { Me } from "./pairing/handshake.ts";
import { Offers, parseOffer } from "./pairing/offer.ts";
import { recipient } from "./routing.ts";
import { AssetStore } from "./storage/assets.ts";
import { openDb } from "./storage/db.ts";
import { Inbox } from "./storage/inbox.ts";
import { SendStore } from "./storage/sends.ts";
import { Coordinator } from "./sync/coordinator.ts";
import { FaultTransport, parseFaults } from "./transports/fault.ts";
import { LanTransport } from "./transports/lan.ts";
import { P2pTransport } from "./transports/p2p.ts";
import { DEFAULT_RELAY, PAIRING_ROOM, RelayTransport, roomFor } from "./transports/relay.ts";
import type { Transport } from "./transports/transport.ts";

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
  /** A Reflex Relay to connect paired devices through (ws:// or wss://). */
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
  /** `reflex link stop` (the `shutdown` admin call): how this process stops. Default: just this Link. */
  onShutdown?: () => void;
}

/** Whether a Link answers on this socket: the test for "running" that a reused pid can't fool. */
function answering(socket: string, ms = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(socket);
    const done = (v: boolean): void => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(false), ms);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const APPROVAL_WAIT_S = 300;
/** The one line under a pairing code: what to do on the iPad. With a Relay the iPad can be anywhere. */
export const pairLine = (relay: boolean): string =>
  `On your iPad: open Reflex, tap Pair with Mac, and type the code. ${relay ? "The iPad finds this Mac on the same Wi-Fi or nearby, or through the relay from anywhere." : "The iPad needs to be on the same Wi-Fi as this Mac."} Single use, 10 minutes.`;
/** How long the pairing room stays open after the code is used or gone: the new iPad's first session runs there until it hears where the person's room is. */
const PAIRING_ROOM_LINGER_MS = 30_000;
/** How long after the profile is made (or its last approving iPad is forgotten) a `reflex pair` code pairs an approving iPad. */
const firstPairMs = (): number => Number(process.env.REFLEX_FIRST_PAIR_S ?? 900) * 1000;
type Decision = "approved" | "denied" | "revoked";

export class Link {
  readonly dir: string;
  readonly home: Home;
  #opts: LinkOptions;
  #id!: Identity;
  #me!: Me;
  #inbox!: Inbox;
  #store!: SendStore;
  #assets!: AssetStore;
  #catalog!: Catalog;
  #offers = new Offers();
  #coord!: Coordinator;
  #server: Server | null = null;
  #agentServer: Server | null = null;
  #push: Awaited<ReturnType<typeof startAgentHost>> | null = null;
  #questions: AgentRecord[] = [];
  #rl: ReturnType<typeof createInterface> | null = null;
  #ports: Record<string, number> = {};
  #keys!: { rpc: string; admin: string };
  #decisions = new Map<string, (() => void)[]>();
  #faults: FaultTransport[] = [];
  #log: (msg: string) => void;
  #relayT: RelayTransport | null = null;
  /** The Relay's pairing room, while a typed code is live (link/pairing/cpace.ts), and since when no code is. */
  #pairRoom: RelayTransport | null = null;
  #pairIdle = 0;
  /** On the default Relay, when the person runs their own: points a new iPad to it. */
  #pointer: RelayTransport | null = null;
  #pairTimer: NodeJS.Timeout | null = null;
  /** A sign-in the person is approving in this terminal, step by step. */
  #reask: NodeJS.Timeout | undefined;
  /** What this Link wrote into link.lock, while it holds it. */
  #lockBody: string | null = null;

  constructor(opts: LinkOptions) {
    this.#opts = opts;
    this.dir = opts.dir;
    this.home = home(opts.dir);
    const log = opts.log ?? ((m) => console.log(`link: ${m}`));
    // A question waiting in this terminal is shown again once the logs go quiet, so it is never buried.
    this.#log = (m) => {
      log(m);
      if (this.#rl && this.#questions.length) {
        clearTimeout(this.#reask);
        this.#reask = setTimeout(() => this.#ask(), 1500);
        this.#reask.unref();
      }
    };
  }

  async start(): Promise<void> {
    // The lock first: identity.json and the keys are made on first run, and two Links starting at once on a
    // fresh profile must not each make their own.
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await this.#lock();
    await this.#refuseSecondLink();
    this.#id = identity(this.dir, { name: this.#opts.name });
    this.#me = { key: this.#id.key, person: this.#id.person, name: this.#id.name, kind: "link" };
    this.#keys = { rpc: localKey(this.dir, "rpc.key"), admin: localKey(this.dir, "admin.key") };

    const db = openDb(this.home.db);
    this.#inbox = new Inbox(db);
    this.#store = new SendStore(db, this.#inbox);
    this.#assets = new AssetStore(this.home.assets);
    this.#catalog = new Catalog(db, this.#id.key);
    // Who each recovered Send goes to (link/routing.ts).
    this.#inbox.recipientsFor = () =>
      this.#catalog
        .agents()
        .filter((a) => a.status === "approved")
        .map((a) => recipient(a.id));
    const rec = { spaces: new Set(this.#store.list().map((s) => s.space)).size, replayed: 0 };
    const devices = this.#catalog.devices();
    if (this.#catalog.rejected > 0) this.#log(`ignored ${this.#catalog.rejected} catalog records with bad signatures`);

    const transports: Transport[] = [];
    // Who this Link is, in its Bonjour records: an iPad with a typed code needs its key and person (and shows its name).
    const txt = {
      k: b64(this.#id.key.publicRaw),
      n: this.#id.name.slice(0, 60),
      pi: this.#id.person.id,
      pn: this.#id.person.name.slice(0, 60),
    };
    if (this.#opts.lan !== false)
      transports.push(
        new LanTransport({
          device: this.#id.key.device,
          port: this.#opts.port ?? 7420,
          txt,
        }),
      );
    if (this.#opts.p2p !== false) {
      const p2p = P2pTransport.available();
      if (p2p.ok) transports.push(new P2pTransport({ device: this.#id.key.device, log: this.#log, txt }));
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
    }
    this.#coord = new Coordinator({
      me: this.#me,
      assets: this.#assets,
      catalog: this.#catalog,
      offers: this.#offers,
      transports: this.#faulty(transports),
      log: this.#log,
      everyPath: this.#opts.everyPath,
    });
    this.#coord.onSend = (send) => {
      this.#store.ingest(send);
    };
    // Generic session messages stay available for T25's send/send_ack transport.
    this.#coord.onBound = (p) => {
      if (this.#relayT && this.#catalog.device(p.device)?.person.id === this.#id.person.id)
        this.#coord.send(p, { t: "relay", url: this.#relayT.url, room: roomFor(this.#id.person.id) });
    };
    this.#coord.onPaired((d) => process.stdout.write(`\nPaired with ${d.name} (${d.device}).\n`));
    this.#coord.grantsApproval = (source) => this.#grantsApproval(source);
    this.#coord.onCodePaired = (d, agents) => {
      this.#log(
        `${d.name} (${d.device}) typed the pairing code${agents.length ? `; approving ${agents.length} Agent${agents.length === 1 ? "" : "s"} that asked for it` : ""}`,
      );
      for (const id of agents) {
        const status = this.#catalog.agent(id)?.status;
        if (status && status !== "approved") this.#decide(id, "approved", d.device);
      }
    };
    this.#coord.approvalHint = () => this.#approvalHint();
    this.#coord.pendingAgents = () =>
      this.#catalog
        .agents()
        .filter((a) => a.status === "pending")
        .map(({ id, name, color, requested_at }) => ({ id, name, color, requested_at }));
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
      catalog: this.#catalog,
      person: this.#id.person,
      socket: agentSocketPath(this.dir),
      token: this.#keys.rpc,
      announce: (a) => this.#announce(a),
      code: (agent) => this.typedCode(agent),
      codeFor: (agent) => this.#offers.codeFor(agent)?.code,
      relay: this.#relayT?.url,
      ipads: () =>
        this.#catalog
          .devices()
          .filter((d) => d.kind === "ipad" && d.person.id === this.#id.person.id)
          .map((d) => d.name),
      remind: (a) =>
        this.#coord.askAboutAgent({ id: a.id, name: a.name, color: a.color, requested_at: a.requested_at }),
      decision: (id, ms, signal) => this.#waitDecision(id, ms, signal),
      log: (event, data = {}) => this.#log(`agent layer: ${event} ${JSON.stringify(data)}`),
    });
    this.#agentServer = host.server;
    this.#push = host;
    this.#ports = (await this.#coord.start()).ports;
    await this.#listen();
    writeFileSync(
      this.home.runtime,
      JSON.stringify(
        {
          pid: process.pid,
          socket: this.home.socket,
          lan: this.#ports.lan,
          p2p: this.#ports.p2p,
          device: this.#id.key.device,
        },
        null,
        2,
      ),
    );
    this.#log(
      `${this.#id.name} (${this.#id.key.device}) for ${this.#id.person.name} · ${rec.spaces} pages with Sends, ` +
        `${this.#inbox.all().length} Sends in the Inbox, ` +
        `${devices.length} paired devices · ${this.#ports.lan !== undefined ? `LAN :${this.#ports.lan}` : "no LAN"}` +
        `${this.#ports.p2p ? ` · peer-to-peer :${this.#ports.p2p}` : ""}${this.#relayT ? ` · Relay ${this.#relayT.url}` : ""} · ${this.home.socket}`,
    );
    // Like a pairing code, the viewer's address carries its key and is shown only here.
    if (this.#opts.prompt && process.stdin.isTTY) this.#terminal();
    this.#pairTimer = setInterval(() => this.#syncPairingRoom(), 5_000);
    this.#pairTimer.unref();
  }

  /**
   * Waits in the Relay's pairing room while a typed code is live, so an iPad that isn't nearby can try it there.
   * It goes in under a relay identity of its own, made for this, so the room never sees this Link's device ID.
   * A Link on its own Relay also waits on the default one, only to tell a new iPad (which knows no other Relay)
   * where to go: `{t:"moved", relay}`. The code is checked on the person's Relay, never there.
   */
  #syncPairingRoom(): void {
    const url = this.#relayT?.url;
    if (!url) return;
    if (this.#offers.liveCode() !== undefined) {
      this.#pairIdle = 0;
      if (this.#pairRoom) return;
      const room = new RelayTransport({
        url,
        key: newDeviceKey().key,
        room: () => PAIRING_ROOM,
        watch: () => ["*"],
        log: this.#log,
        name: "relay-pairing",
      });
      room.onReady = () => this.#log(`relay: waiting in the pairing room on ${url} while the code is live`);
      this.#pairRoom = room;
      void this.#coord.addTransport(room);
      if (url !== DEFAULT_RELAY) {
        const pointer = new RelayTransport({
          url: DEFAULT_RELAY,
          key: newDeviceKey().key,
          room: () => PAIRING_ROOM,
          watch: () => ["*"],
          log: this.#log,
          name: "relay-pointer",
        });
        pointer.onReady = () =>
          this.#log(`relay: pointing new iPads from ${DEFAULT_RELAY} to ${url} while the code is live`);
        this.#pointer = pointer;
        void pointer.listen((p) => {
          void p
            .send(Buffer.from(JSON.stringify({ t: "moved", relay: url })), "control")
            .catch(() => {})
            .finally(() => setTimeout(() => p.close("pointed to the person's Relay"), 1000).unref());
        });
      }
      return;
    }
    if (!this.#pairRoom) return;
    this.#pairIdle ||= Date.now();
    if (Date.now() - this.#pairIdle < PAIRING_ROOM_LINGER_MS) return;
    void this.#coord.removeTransport(this.#pairRoom);
    void this.#pointer?.close();
    this.#pairRoom = this.#pointer = null;
    this.#log(`relay: left the pairing room (no code is live)`);
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
      const a = this.#questions[0];
      if (a && this.#catalog.agent(a.id)?.status === "pending" && /^(y(es)?|n(o)?)$/i.test(line.trim())) {
        // Once an iPad approves, this terminal can only refuse: anything with the person's shell can type here.
        if (/^y/i.test(line.trim()) && this.#approvers().length)
          return void process.stdout.write(
            `Allow it on your iPad (${this.#approvers()
              .map((d) => d.name)
              .join(", ")}): this terminal can only refuse once an iPad approves. Type n to refuse.\n`,
          );
        this.#questions.shift();
        this.#decide(a.id, /^y/i.test(line.trim()) ? "approved" : "denied", "terminal");
        return this.#ask();
      }
      if (this.#ports.lan === undefined && !this.#relayT)
        return void process.stdout.write("Pairing needs the LAN or a Relay; this Link was started without either.\n");
      void this.showPairingCode();
    });
    if (this.#ports.lan !== undefined || this.#relayT) void this.showPairingCode();
  }

  async showPairingCode(): Promise<void> {
    const { code } = this.typedCode();
    process.stdout.write(
      `\nPairing code: ${code.slice(0, 3)} ${code.slice(3)}\n${pairLine(this.#relayT !== null)}\nPress Enter for a new code.\n`,
    );
  }

  /** The live 6-digit code (a new one if none is live), with `agent` among the Agents typing it approves. */
  typedCode(agent?: string): { code: string; expires: number } {
    if (this.#ports.lan === undefined && !this.#relayT)
      throw new LinkError(
        "no_lan",
        "Pairing an iPad needs the local network or a Relay, and this Link was started with --no-lan and no Relay.",
        "Restart it without --no-lan, or with a Relay.",
      );
    const before = this.#offers.liveCode();
    const c = this.#offers.code(agent);
    if (c.code !== before)
      this.#log(
        `made a pairing code (6 digits, single use, 10 minutes)${this.#relayT ? `; it also works through the relay at ${this.#relayT.url}` : ""}`,
      );
    this.#syncPairingRoom();
    return { code: c.code, expires: c.expires };
  }

  #approvers(): PairedDevice[] {
    return this.#catalog.devices().filter((d) => mayApprove(d, this.#id.person.id));
  }

  /**
   * Until when a `reflex pair` code pairs an iPad that may approve, while none does: 15 minutes from the profile's
   * creation (`reflex setup` on a new profile), or from forgetting the last approving iPad (a reinstalled iPad).
   */
  #windowUntil(): number {
    const st = statSync(join(this.dir, "identity.json"));
    const born = this.#id.created_at ?? (st.birthtimeMs || st.mtimeMs);
    let forgot = 0;
    try {
      forgot = Number(JSON.parse(readFileSync(join(this.dir, "first-pair.json"), "utf8")).forgot_at) || 0;
    } catch {}
    return Math.max(born, forgot) + firstPairMs();
  }

  /** Whether a code from this source makes the iPad that scans it approve: only while no iPad approves. */
  #grantsApproval(source: "terminal" | "admin"): boolean {
    if (this.#approvers().length) return false;
    return source === "terminal" || Date.now() < this.#windowUntil();
  }

  /** What to do so an iPad may approve, in words for the log, the iPad and `reflex pair`. */
  #approvalHint(): string {
    const a = this.#approvers();
    if (a.length)
      return `Approving is on ${a.map((d) => d.name).join(", ")}: it asks "Let … approve Agents?" when another iPad pairs. If that iPad is gone (reinstalled, lost), run \`reflex link forget ${a[0].device}\`, then \`reflex pair\` and scan the new code on this one.`;
    if (Date.now() < this.#windowUntil()) return "Run `reflex pair` and scan its code on this iPad.";
    return "No iPad approves Agents yet. Run `reflex link stop`, then `reflex link` in a terminal: press Enter and scan the code it shows on your iPad.";
  }

  /** A new single-use pairing code, valid 10 minutes. `admin`: made by a command, not shown in this terminal (offer.ts). */
  pairingCode(source: "terminal" | "admin" = "terminal"): string {
    if (this.#ports.lan === undefined)
      throw new LinkError(
        "no_lan",
        "Pairing an iPad needs the local network, and this Link was started with --no-lan.",
        "Restart it without --no-lan.",
      );
    return this.#offers.create(
      { device: this.#id.key.device, key: b64(this.#id.key.publicRaw), name: this.#id.name, person: this.#id.person },
      this.#ports.lan,
      source,
    ).uri;
  }

  #ask(): void {
    const a = this.#questions.find((q) => this.#catalog.agent(q.id)?.status === "pending");
    this.#questions = a ? this.#questions.slice(this.#questions.indexOf(a)) : [];
    clearTimeout(this.#reask);
    if (!a) return;
    const ipads = this.#approvers().map((d) => d.name);
    process.stdout.write(
      ipads.length
        ? `\n>>> "${a.name}" (${a.id}) asks to receive your Sends. Tap Allow on your iPad (${ipads.join(", ")}). Type n and Enter here to refuse.\n`
        : `\n>>> Allow "${a.name}" (${a.id}) to receive your Sends? Type y and Enter here, or tap Allow on your iPad. [y/N]\n`,
    );
  }

  /**
   * One Link per profile, even when two start at once (`reflex mcp` and the CLI start one on demand).
   * `link.lock` holds `{pid, at}`, written whole to a temp file and linked into place, so a reader never sees it
   * half written. A lock is stale, and taken over (compare and swap), unless a Link answers on the socket or the lock
   * is under a minute old and its pid is alive (a Link still starting): a pid alone may belong to another program by now.
   */
  async #lock(): Promise<void> {
    const file = join(this.dir, "link.lock");
    const busy = (pid: number): LinkError =>
      new LinkError(
        "already_running",
        `A Link is already running from ${this.dir}${pid ? ` (pid ${pid})` : ""}.`,
        "Use that one, or pass --home for a second profile.",
      );
    for (let tries = 0; tries < 3; tries++) {
      const body = JSON.stringify({ pid: process.pid, at: Date.now(), n: randomBytes(4).toString("hex") });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      try {
        linkSync(tmp, file);
        this.#lockBody = body;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        rmSync(tmp, { force: true });
      }
      let raw = "";
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue; // gone already: try again
      }
      let held = { pid: 0, at: 0 };
      try {
        held = { ...held, ...JSON.parse(raw) };
      } catch {} // an older Link's bare pid
      let alive = false;
      try {
        if (held.pid && held.pid !== process.pid) process.kill(held.pid, 0);
        alive = Boolean(held.pid) && held.pid !== process.pid;
      } catch {}
      if ((await answering(this.home.socket)) || (alive && Date.now() - held.at < 60_000)) throw busy(held.pid);
      // Compare and swap: move the lock aside (atomic) and take it over only if it is the one judged stale. Another
      // Link that took it over meanwhile gets its lock back, and this one stops.
      const aside = `${file}.${process.pid}.stale`;
      try {
        renameSync(file, aside);
      } catch {
        continue;
      }
      const moved = readFileSync(aside, "utf8");
      if (moved !== raw) {
        try {
          linkSync(aside, file);
        } catch {}
        rmSync(aside, { force: true });
        throw busy(0);
      }
      rmSync(aside, { force: true });
    }
    throw busy(0);
  }

  /** A Link from before link.lock (or one whose lock was removed) still answering on this profile's socket. */
  async #refuseSecondLink(): Promise<void> {
    if (!(await answering(this.home.socket))) return;
    const pid = existsSync(this.home.runtime) ? JSON.parse(readFileSync(this.home.runtime, "utf8")).pid : 0;
    this.#unlock();
    throw new LinkError(
      "already_running",
      `A Link is already running from ${this.dir}${pid ? ` (pid ${pid})` : ""}.`,
      "Use that one, or pass --home for a second profile.",
    );
  }

  #unlock(): void {
    const file = join(this.dir, "link.lock");
    try {
      if (this.#lockBody && readFileSync(file, "utf8") === this.#lockBody) rmSync(file, { force: true });
    } catch {}
    this.#lockBody = null;
  }

  async stop(): Promise<void> {
    this.#rl?.close();
    if (this.#pairTimer) clearInterval(this.#pairTimer);
    await this.#pointer?.close();
    this.#push?.dispatcher.stop();
    await new Promise<void>((r) => (this.#agentServer ? this.#agentServer.close(() => r()) : r()));
    await this.#coord.stop();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    rmSync(this.home.runtime, { force: true });
    rmSync(this.home.socket, { force: true });
    this.#unlock();
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
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on(
      "data",
      lines((line) => {
        let req: { id: number; method: string; params?: Record<string, unknown> };
        try {
          req = JSON.parse(line);
        } catch {
          socket.destroy();
          return false;
        }
        this.#handle(conn, req.method, req.params ?? {})
          .then((result) => socket.writable && socket.write(`${JSON.stringify({ id: req.id, ok: true, result })}\n`))
          .catch((e: Error) => {
            const err = e instanceof LinkError ? e : new LinkError("internal", e.message);
            if (!(e instanceof LinkError)) this.#log(`error in ${req.method}: ${e.stack ?? e.message}`);
            if (socket.writable)
              socket.write(
                `${JSON.stringify({
                  id: req.id,
                  ok: false,
                  error: { reason: err.reason, message: err.message, fix: err.fix },
                })}\n`,
              );
          });
        return true;
      }),
    );
  }

  async #handle(c: Conn, method: string, p: Record<string, unknown>): Promise<unknown> {
    if (method === "auth") {
      const role = p.role === "admin" ? "admin" : "agent";
      const want = Buffer.from(role === "admin" ? this.#keys.admin : this.#keys.rpc);
      const got = Buffer.from(String(p.key ?? ""));
      if (got.length !== want.length || !timingSafeEqual(got, want))
        throw new LinkError("bad_credential", "Wrong local credential.");
      c.role = role;
      return { device: this.#id.key.device, name: this.#id.name, person: this.#id.person };
    }
    if (!c.role) throw new LinkError("not_authenticated", "Call auth first.");

    if (c.role === "admin") {
      const admin = this.#admin(method, p);
      if (admin) return admin;
    }
    if (method === "agent.hello") return this.#agentHello(c, p);
    throw new LinkError("unknown_method", `No method '${method}'.`);
  }

  // Agents

  async #agentHello(c: Conn, p: Record<string, unknown>): Promise<unknown> {
    const name = String(p.name ?? "").trim();
    const credential = String(p.credential ?? "");
    if (!name)
      throw new LinkError(
        "missing_name",
        "An Agent must say its name.",
        'Pass name, e.g. "Claude Code · reflex repo".',
      );
    if (credential.length < 32)
      throw new LinkError("missing_credential", "An Agent must present a random credential of at least 32 characters.");
    let a = this.#catalog.byCredential(credential);
    if (!a) {
      a = this.#catalog.request(name, credential);
      this.#announce(a);
    }
    if (a.status === "pending") {
      const wait = Math.min(Number(p.wait_s ?? APPROVAL_WAIT_S), APPROVAL_WAIT_S);
      await this.#waitDecision(a.id, wait * 1000);
      a = this.#catalog.knownAgent(a.id);
    }
    if (a.status === "pending")
      throw new LinkError(
        "approval_pending",
        `Waiting for the user to approve ${a.name} (${a.id}).`,
        "Ask the person to tap Allow on their iPad, then connect again.",
      );
    if (a.status !== "approved") throw new LinkError("agent_denied", `The user ${a.status} ${a.name} (${a.id}).`);
    c.agent = a;
    return { agent: a.id, name: a.name, color: a.color };
  }

  /** Asks the person about a new Agent: on every connected iPad, and on this terminal. */
  #announce(a: AgentRecord): void {
    this.#log(`new Agent "${a.name}" (${a.id}) wants to receive your Sends. Allow it on your iPad or answer here.`);
    this.#coord.askAboutAgent({ id: a.id, name: a.name, color: a.color, requested_at: a.requested_at });
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
            "Tap Allow on your iPad.",
          );
        if (status !== "denied" && status !== "revoked")
          throw new LinkError("bad_status", `'${status}' is not denied or revoked.`);
        return this.#decide(String(p.id), status, "command");
      }
      case "pair.offer": {
        // `reflex pair` and `reflex setup`, from any terminal: the live 6-digit code. The iPad that types it may
        // approve Agents. Each code is logged here, and the person's iPads hear of each new device.
        const { code, expires } = this.typedCode();
        return { code, offer: code, expires, line: pairLine(this.#relayT !== null) };
      }
      case "pair.check": {
        // Whether a code from pair.offer was used, and by which device (it may have been paired already).
        const last = this.#offers.lastCode;
        const device =
          last && last.code === String(p.offer ?? "") ? last.device : this.#offers.usedBy(String(p.offer ?? ""));
        const d = device ? this.#catalog.device(device) : undefined;
        return {
          used: Boolean(device),
          ...(d
            ? {
                device: d.device,
                name: d.name,
                approves: mayApprove(d, this.#id.person.id),
                asked: Boolean(d.approver_asked),
              }
            : {}),
          ...(d && !mayApprove(d, this.#id.person.id) ? { hint: this.#approvalHint() } : {}),
        };
      }
      case "forget": {
        // `reflex link forget <device>`: a device that is gone (a reinstalled or lost iPad). It can't connect or approve
        // until it pairs again. Forgetting the last approving iPad opens the first-pairing window again, so the
        // reinstalled one can become the approver with a `reflex pair` code; that is logged.
        const who = String(p.device ?? "").trim();
        const hits = this.#catalog
          .devices()
          .filter((d) => d.device === who || d.name.toLowerCase() === who.toLowerCase());
        if (!hits.length)
          throw new LinkError("unknown_device", `No paired device '${who}'.`, "Run `reflex link status` to see them.");
        if (hits.length > 1)
          throw new LinkError(
            "ambiguous",
            `${hits.length} paired devices are called '${who}'.`,
            "Name it by its ID (dev-…), from `reflex link status`.",
          );
        const was = mayApprove(hits[0], this.#id.person.id);
        const d = this.#coord.forgetDevice(hits[0].device) ?? hits[0];
        let opens: number | undefined;
        if (was && !this.#approvers().length) {
          writeFileSync(join(this.dir, "first-pair.json"), `${JSON.stringify({ forgot_at: Date.now() })}\n`, {
            mode: 0o600,
          });
          opens = this.#windowUntil();
          this.#log(
            `forgot the last iPad that approves Agents: for ${firstPairMs() / 60_000} minutes, \`reflex pair\` pairs one that approves`,
          );
        }
        return { device: d.device, name: d.name, ...(opens ? { window_until: opens } : {}) };
      }
      case "shutdown": {
        // `reflex link stop`: the Link that answers on this profile's socket stops, never a process found by pid.
        setTimeout(() => (this.#opts.onShutdown ? this.#opts.onShutdown() : void this.stop()), 50).unref?.();
        return { stopping: true, pid: process.pid };
      }
      case "pair.wait":
        throw new LinkError("unknown_method", "No method 'pair.wait'.");
      case "pair.join":
        return this.#join(String(p.uri));
      case "assets.put": {
        const hash = this.#assets.put(Buffer.from(String(p.base64 ?? ""), "base64"));
        return { hash };
      }
      case "assets.get":
        return { hash: p.hash, base64: this.#assets.get(String(p.hash)).toString("base64") };
      case "fault": {
        if (!this.#faults.length)
          throw new LinkError(
            "needs_fault",
            "Fault injection needs a Link started with --fault.",
            'Restart it with `reflex link --fault ""`.',
          );
        let faults: ReturnType<typeof parseFaults>;
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
      default:
        return undefined;
    }
  }

  async #join(uri: string): Promise<unknown> {
    let offer: ReturnType<typeof parseOffer>;
    try {
      offer = parseOffer(uri);
    } catch (e) {
      throw new LinkError("bad_pairing_code", (e as Error).message);
    }
    if (offer.device === this.#id.key.device)
      throw new LinkError("own_code", "That is this Link's own pairing code.", "Scan it from the other device.");
    // A device that holds nothing yet becomes the offering person's device.
    if (
      offer.person.id !== this.#id.person.id &&
      this.#store.list().length === 0 &&
      this.#catalog.devices().length === 0
    ) {
      adoptPerson(this.dir, offer.person);
      this.#id.person = offer.person;
      this.#me.person = offer.person;
      this.#log(`this device now belongs to ${offer.person.name} (${offer.person.id})`);
    }
    try {
      return await this.#coord.join(offer);
    } catch (e) {
      throw new LinkError(
        "pairing_failed",
        (e as Error).message,
        "Check both devices are on the same network and the code is fresh.",
      );
    }
  }

  status(): unknown {
    return {
      device: this.#id.key.device,
      name: this.#id.name,
      person: this.#id.person,
      lan_port: this.#ports.lan,
      p2p_port: this.#ports.p2p ?? null,
      socket: this.home.socket,
      pages: [...new Set(this.#store.list().map((s) => s.space))],
      assets: this.#assets.list().length,
      inbox: this.#inbox
        .all()
        .map((e) => ({ space: e.space, send: e.send, via: e.via, receipts: this.#inbox.receipts(e.space, e.send) })),
      paired: this.#catalog.devices().map((d) => ({
        device: d.device,
        name: d.name,
        person: d.person,
        connected: this.#coord.peers().some((p) => p.device === d.device),
      })),
      peers: this.#coord.peers().map((p) => {
        const active = p.paths.active();
        const path = (s: NonNullable<typeof active>) => ({
          transport: s.path.transport,
          remote: s.path.remote,
          ...s.measurements(),
        });
        return {
          device: p.device,
          name: p.name,
          since: p.since,
          ...(active ? path(active) : {}),
          paths: p.paths.all().map((e) => ({ ...path(e.session), active: e.session === active, since: e.since })),
        };
      }),
      agents: this.#catalog.agents().map((a) => ({ id: a.id, name: a.name, status: a.status, color: a.color })),
      relay: this.#relayT ? { url: this.#relayT.url, connected: this.#relayT.connected } : null,
      push: {
        targets: (this.#push?.pushes.all() ?? []).map((t) => ({ ...t, live: this.#push?.live(t) ?? false })),
        attempts: this.#push?.pushes.attempts({ limit: 20 }) ?? [],
      },
    };
  }
}
