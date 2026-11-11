// Reflex Link: composition of storage, Inbox, sync, transports, pairing and
// Agent approval, behind a local RPC on a Unix socket.
//
// One Link per user profile. Local clients connect to the socket (in a 0700
// folder) and present a per-profile credential: `admin.key` for the user's own
// `reflex-link` commands, `rpc.key` for Agent connections. An Agent then says
// who it is with a credential it made itself; the first time, the user is
// asked to approve it, and until they do it sees no Space content.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { adoptPerson, home, identity, localKey, type Home, type Identity } from "./home.ts";
import { Catalog, type AgentRecord } from "./pairing/catalog.ts";
import { b64 } from "./pairing/crypto.ts";
import type { Me } from "./pairing/handshake.ts";
import { Offers, parseOffer } from "./pairing/offer.ts";
import { AssetStore } from "./storage/assets.ts";
import { openDb } from "./storage/db.ts";
import { Inbox } from "./storage/inbox.ts";
import { SpaceStore } from "./storage/journal.ts";
import { Coordinator } from "./sync/coordinator.ts";
import { LanTransport } from "./transports/lan.ts";

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
  /** Ask about new Agents on this terminal, as well as through `reflex-link approve`. */
  prompt?: boolean;
  log?: (msg: string) => void;
}

const APPROVAL_WAIT_S = 300;

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
  #ports: Record<string, number> = {};
  #keys!: { rpc: string; admin: string };
  #decisions = new Map<string, (() => void)[]>();
  #pairWaiters = new Map<string, ((device: string) => void)[]>();
  #log: (msg: string) => void;

  constructor(opts: LinkOptions) {
    this.#opts = opts;
    this.dir = opts.dir;
    this.home = home(opts.dir);
    this.#log = opts.log ?? ((m) => console.log(`link: ${m}`));
  }

  async start(): Promise<void> {
    this.#id = identity(this.dir, { name: this.#opts.name });
    this.#me = { key: this.#id.key, person: this.#id.person, name: this.#id.name };
    this.#keys = { rpc: localKey(this.dir, "rpc.key"), admin: localKey(this.dir, "admin.key") };
    this.#refuseSecondLink();

    const db = openDb(this.home.db);
    this.#inbox = new Inbox(db);
    this.#store = new SpaceStore(db, this.#id.actor, this.#inbox);
    const rec = this.#store.recover();
    this.#assets = new AssetStore(this.home.assets);
    this.#catalog = new Catalog(db, this.#id.key);
    const devices = this.#catalog.devices();
    if (this.#catalog.rejected > 0) this.#log(`ignored ${this.#catalog.rejected} catalog records with bad signatures`);

    this.#coord = new Coordinator({
      me: this.#me,
      store: this.#store,
      assets: this.#assets,
      catalog: this.#catalog,
      offers: this.#offers,
      transports: [new LanTransport({ device: this.#id.key.device, port: this.#opts.port ?? 7420 })],
      log: this.#log,
    });
    this.#coord.onPaired((d) => {
      for (const w of this.#pairWaiters.get("*") ?? []) w(d.device);
      this.#pairWaiters.delete("*");
    });
    this.#ports = (await this.#coord.start()).ports;
    await this.#listen();
    writeFileSync(
      this.home.runtime,
      JSON.stringify({ pid: process.pid, socket: this.home.socket, lan: this.#ports.lan, device: this.#id.key.device }, null, 2),
    );
    this.#log(
      `${this.#id.name} (${this.#id.key.device}) for ${this.#id.person.name} · ${rec.spaces} Spaces, ` +
        `${rec.replayed} journal entries replayed, ${this.#inbox.all().length} Sends in the Inbox, ` +
        `${devices.length} paired devices · LAN :${this.#ports.lan} · ${this.home.socket}`,
    );
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
      throw new LinkError("approval_pending", `Waiting for the user to approve ${a.name} (${a.id}).`, `Approve it with \`reflex-link approve ${a.id}\`, then connect again.`);
    if (a.status !== "approved") throw new LinkError("agent_denied", `The user ${a.status} ${a.name} (${a.id}).`);
    c.agent = a;
    return { agent: a.id, name: a.name, color: a.color };
  }

  #announce(a: AgentRecord): void {
    this.#log(`new Agent "${a.name}" wants to connect. Approve: reflex-link approve ${a.id}   Deny: reflex-link deny ${a.id}`);
    if (!this.#opts.prompt || !process.stdin.isTTY) return;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Allow "${a.name}" (${a.id}) to use your Spaces? [y/N] `, (ans) => {
      rl.close();
      if (this.#catalog.agent(a.id)?.status !== "pending") return;
      this.#decide(a.id, /^y(es)?$/i.test(ans.trim()) ? "approved" : "denied");
    });
  }

  #waitDecision(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const list = this.#decisions.get(id) ?? [];
      const done = (): void => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, ms);
      list.push(done);
      this.#decisions.set(id, list);
    });
  }

  #decide(id: string, status: "approved" | "denied" | "revoked"): AgentRecord {
    const a = this.#catalog.decide(id, status);
    this.#log(`Agent ${a.name} (${a.id}) ${status}`);
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
        if (status !== "approved" && status !== "denied" && status !== "revoked")
          throw new LinkError("bad_status", `'${status}' is not approved, denied or revoked.`);
        return this.#decide(String(p.id), status);
      }
      case "pair.offer": {
        const o = this.#offers.create({ device: this.#id.key.device, key: b64(this.#id.key.publicRaw), name: this.#id.name, person: this.#id.person }, this.#ports.lan);
        return { offer: o.offer, uri: o.uri, expires: o.expires };
      }
      case "pair.wait": {
        const offer = String(p.offer);
        return new Promise((resolve, reject) => {
          if (!this.#offers.live(offer)) return reject(new LinkError("offer_expired", "That pairing code expired.", "Run `reflex-link pair` again."));
          const t = setTimeout(() => reject(new LinkError("offer_expired", "No device paired before the code expired.", "Run `reflex-link pair` again.")), this.#offers.remaining(offer));
          const list = this.#pairWaiters.get("*") ?? [];
          list.push((device) => {
            clearTimeout(t);
            resolve(this.#catalog.device(device));
          });
          this.#pairWaiters.set("*", list);
        });
      }
      case "pair.join":
        return this.#join(String(p.uri));
      case "dev.intent":
      case "dev.undo":
      case "dev.send": {
        // Stand-ins for the iPad's person edits until T6 joins the iPad to the Link.
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
      case "assets.put": {
        const hash = this.#assets.put(Buffer.from(String(p.base64 ?? ""), "base64"));
        this.#coord.announceAsset(hash);
        return { hash };
      }
      case "assets.get": {
        return { hash: p.hash, base64: this.#assets.get(String(p.hash)).toString("base64") };
      }
      case "inbox.all":
        return this.#inbox.all().map((e) => ({ ...e, receipts: this.#inbox.receipts(e.space, e.send) }));
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

  status(): unknown {
    return {
      device: this.#id.key.device,
      name: this.#id.name,
      person: this.#id.person,
      lan_port: this.#ports.lan,
      socket: this.home.socket,
      spaces: this.#store.ids().map((id) => this.#store.info(id)),
      journal: this.#store.journalStats(),
      assets: this.#assets.list().length,
      inbox: this.#inbox.all().map((e) => ({ space: e.space, send: e.send, via: e.via, receipts: this.#inbox.receipts(e.space, e.send) })),
      paired: this.#catalog.devices().map((d) => ({ device: d.device, name: d.name, person: d.person, connected: this.#coord.peers().some((p) => p.device === d.device) })),
      peers: this.#coord.peers().map((p) => ({ device: p.device, name: p.name, since: p.since, transport: p.session.path.transport, remote: p.session.path.remote, ...p.session.measurements() })),
      agents: this.#catalog.agents().map((a) => ({ id: a.id, name: a.name, status: a.status, color: a.color })),
    };
  }
}
