// The Agent layer inside the Link: the capability table (`@reflex/agent`)
// running on the Link's durable Spaces, Inbox and assets, served to the MCP
// and CLI surfaces on `agent.sock`.
//
// Every write an Agent makes is journaled before its result is returned, and
// every Send is indexed in the durable Inbox in the same transaction that
// makes it durable, so a Link that is killed and restarted still delivers it.
import type { Space } from "@reflex/kernel/node";
import { Core, ReflexError, type Identity } from "../agent/src/capabilities/index.ts";
import { SvgRenderer } from "../agent/src/render.ts";
import { serveHost } from "../agent/src/host/server.ts";
import type { Who } from "../agent/src/host/rpc.ts";
import type { Assets, Bounds, Delivery, FrozenSend, Inbox as AgentInbox, SpaceEntry, SpaceStore as AgentSpaces, WaitFilter, WriteOrigin } from "../agent/src/store.ts";
import type { Catalog, AgentRecord } from "./pairing/catalog.ts";
import type { AssetStore } from "./storage/assets.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Inbox } from "./storage/inbox.ts";
import type { SpaceStore } from "./storage/journal.ts";

const recipient = (agent: string) => `agent:${agent}`;

/** The Agent layer's view of the Link's Spaces. */
class LinkSpaces implements AgentSpaces {
  #store: SpaceStore;
  #db: DatabaseSync;
  #inbox: Inbox;

  constructor(store: SpaceStore, db: DatabaseSync, inbox: Inbox) {
    this.#store = store;
    this.#db = db;
    this.#inbox = inbox;
  }

  #entry(id: string): SpaceEntry {
    const store = this.#store;
    const meta = this.#db.prepare("SELECT title, size, width, viewport FROM space_meta WHERE space = ?").get(id) as
      | { title: string | null; size: string; width: number | null; viewport: string }
      | undefined;
    const agents = new Set(this.agents(id));
    return {
      name: id,
      kind: store.kind(id) as SpaceEntry["kind"],
      ...(meta?.title ? { title: meta.title } : {}),
      size: (meta?.size ?? "infinite") as SpaceEntry["size"],
      ...(meta?.width ? { width: meta.width } : {}),
      viewport: meta ? (JSON.parse(meta.viewport) as Bounds) : [0, 0, 1366, 1024],
      // A getter: the store reloads a replica from disk when a write fails.
      get space() {
        return store.read(id, (s) => s);
      },
      agents,
    };
  }

  agents(space: string): string[] {
    return (this.#db.prepare("SELECT agent FROM space_agents WHERE space = ? ORDER BY at").all(space) as { agent: string }[]).map((r) => r.agent);
  }

  get(name: string) {
    return this.#store.has(name) ? this.#entry(name) : undefined;
  }

  create(name: string, o: { kind?: "space" | "library"; title?: string; size?: SpaceEntry["size"]; width?: number }) {
    this.#store.ensure(name, o.kind ?? "space");
    this.#db
      .prepare("INSERT INTO space_meta (space, title, size, width) VALUES (?, ?, ?, ?) ON CONFLICT (space) DO NOTHING")
      .run(name, o.title ?? null, o.size ?? "infinite", o.width ?? null);
    return this.#entry(name);
  }

  list() {
    return this.#store.ids().map((id) => this.#entry(id));
  }

  write<T>(entry: SpaceEntry, origin: WriteOrigin, fn: (s: Space) => T): T {
    return this.#store.commit(entry.name, origin, fn);
  }

  attach(entry: SpaceEntry, agent: string) {
    this.#db.prepare("INSERT INTO space_agents (space, agent, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(entry.name, agent, Date.now());
    this.#inbox.adopt(entry.name, recipient(agent));
  }
}

/** The Agent layer's view of the Link's durable Inbox. */
class LinkInbox implements AgentInbox {
  #inbox: Inbox;
  #store: SpaceStore;

  constructor(inbox: Inbox, store: SpaceStore) {
    this.#inbox = inbox;
    this.#store = store;
  }

  #frozen(space: string, send: string): FrozenSend | undefined {
    const v = JSON.parse(this.#store.read(space, (s) => s.send(send)));
    return v ?? undefined;
  }

  take(agent: string, f: WaitFilter): Delivery | undefined {
    for (const e of this.#inbox.pending(recipient(agent), f.space)) {
      const send = this.#frozen(e.space, e.send);
      if (!send) continue;
      if (f.region && send.region !== f.region) continue;
      if (f.element && !(send.kind === "tap" && send.element === f.element)) continue;
      this.#inbox.mark(e.space, e.send, recipient(agent), "delivered");
      return { send, redelivered: e.state === "delivered" };
    }
    return undefined;
  }

  ack(agent: string, send: string) {
    const e = this.#inbox.find(send);
    if (!e || !this.#inbox.recipients(e.space, send).includes(recipient(agent))) return false;
    this.#inbox.mark(e.space, send, recipient(agent), "acknowledged");
    return true;
  }

  pending(agent: string, space?: string) {
    return this.#inbox.pending(recipient(agent), space).length;
  }

  recipients(send: string) {
    const e = this.#inbox.find(send);
    return e ? this.#inbox.recipients(e.space, send).map((r) => r.replace(/^agent:/, "")) : [];
  }

  arrival(_agent: string, signal: AbortSignal) {
    return this.#inbox.next(signal);
  }
}

class LinkAssets implements Assets {
  #assets: AssetStore;
  constructor(assets: AssetStore) {
    this.#assets = assets;
  }
  get(hash: string) {
    try {
      return this.#assets.has(hash) ? this.#assets.get(hash) : undefined;
    } catch {
      return undefined; // a damaged asset reads as missing; Reflex renders the crop instead
    }
  }
}

export interface AgentHostOptions {
  db: DatabaseSync;
  store: SpaceStore;
  inbox: Inbox;
  assets: AssetStore;
  catalog: Catalog;
  person: { id: string; name: string };
  socket: string;
  token: string;
  devPerson: boolean;
  /** Asks the person to approve a new Agent (on the Link's terminal and on paired iPads). */
  announce: (a: AgentRecord) => void;
  /** Resolves once the person decides about this Agent, or after `ms`. */
  decision: (id: string, ms: number, signal: AbortSignal) => Promise<void>;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/** How long a first call waits for the person to approve the Agent before it returns `not_approved`. */
const APPROVAL_WAIT_MS = 120_000;

export async function startAgentHost(o: AgentHostOptions) {
  const spaces = new LinkSpaces(o.store, o.db, o.inbox);
  o.inbox.recipientsFor = (space) => spaces.agents(space).map(recipient);
  const names = Object.fromEntries(o.catalog.agents().map((a) => [a.id, a.name]));
  const core = new Core({
    spaces,
    inbox: new LinkInbox(o.inbox, o.store),
    assets: new LinkAssets(o.assets),
    renderer: new SvgRenderer(),
    person: { person: o.person.id, name: o.person.name },
    names,
    progressEvery: Number(process.env.REFLEX_PROGRESS_S ?? 15),
    log: o.log,
  });

  const notApproved = (a: AgentRecord, msg: string, fix: string) =>
    new ReflexError("not_approved", [{ code: "not_approved", msg, fix }]);

  async function authorize(who: Who, signal: AbortSignal): Promise<Identity> {
    const name = String(who?.name ?? "").trim().slice(0, 80);
    const credential = String(who?.credential ?? "");
    if (!name || credential.length < 32) throw new ReflexError("invalid_input", [{ code: "invalid_input", msg: "An Agent must say its name and present its credential.", fix: "Connect through `reflex mcp` or the reflex CLI." }]);
    let a = o.catalog.byCredential(credential);
    if (!a) {
      a = o.catalog.request(name, credential);
      o.log("agent_requested", { agent: a.id, name });
      o.announce(a);
    } else if (a.status === "denied" || a.status === "revoked") {
      // Only the person can let an Agent in, so the way back for one they turned away is to ask them again.
      a = o.catalog.askAgain(a.id);
      o.log("agent_requested", { agent: a.id, name, again: true });
      o.announce(a);
    }
    if (a.status === "pending") {
      await o.decision(a.id, APPROVAL_WAIT_MS, signal);
      a = o.catalog.agent(a.id)!;
    }
    if (a.status === "pending")
      throw notApproved(a, `The person has not approved ${a.name} yet.`, "Ask them to tap Allow on their iPad, or answer y in the Link's terminal, then call again.");
    if (a.status !== "approved") throw notApproved(a, `The person ${a.status} ${a.name}.`, "Call again to ask the person once more, and tell them to expect the question on their iPad or in the Link's terminal.");
    return { agent: a.id, name: a.name, color: a.color };
  }

  const server = await serveHost({ core, socket: o.socket, token: o.token, authorize, devPerson: o.devPerson, log: o.log });
  return { core, server };
}
