// The Agent layer inside the Link: the capability table (`@reflex/agent`)
// running on the Link's durable Spaces, Inbox and assets, served to the MCP
// and CLI surfaces on `agent.sock`.
//
// Every write an Agent makes is journaled before its result is returned, and
// every Send is indexed in the durable Inbox in the same transaction that
// makes it durable, so a Link that is killed and restarted still delivers it.
import { Core, ReflexError, type Identity } from "../agent/src/capabilities/index.ts";
import { serveHost, type Listener } from "../agent/src/host/server.ts";
import type { Who } from "../agent/src/host/rpc.ts";
import type { Assets, Bounds, Delivery, FrozenSend, Inbox as AgentInbox, SpaceEntry, SendStore as AgentSpaces, WaitFilter, WriteOrigin } from "../agent/src/store.ts";
import type { Catalog, AgentRecord } from "./pairing/catalog.ts";
import type { AssetStore } from "./storage/assets.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Inbox } from "./storage/inbox.ts";
import type { SendStore } from "./storage/sends.ts";

import { recipient } from "./routing.ts";
import { ClaudeChannel } from "./adapters/claude-channel.ts";
import { Webhook } from "./adapters/webhook.ts";
import { Dispatcher } from "./adapters/dispatch.ts";
import { PushStore } from "./adapters/store.ts";
import type { PushTarget } from "./adapters/contract.ts";
import { randomBytes } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";

/** The Agent layer's view of the Link's durable Inbox. */
class LinkInbox implements AgentInbox {
  #inbox: Inbox;
  #store: SendStore;
  inFlight: (space: string, send: string, recipient: string) => boolean = () => false;

  constructor(inbox: Inbox, store: SendStore) {
    this.#inbox = inbox;
    this.#store = store;
  }

  #frozen(space: string, send: string): FrozenSend | undefined {
    const v = this.#store.get(send);
    return v?.space === space ? v as unknown as FrozenSend : undefined;
  }

  take(agent: string, f: WaitFilter): Delivery | undefined {
    for (const e of this.#inbox.pending(recipient(agent), f.space)) {
      const send = this.#frozen(e.space, e.send);
      if (!send) continue;
      // Sends store keys (`<agent>/<id>`); the Agent filters by its own IDs.
      const local = (k?: string) => (k?.startsWith(`${agent}/`) ? k.slice(agent.length + 1) : k);
      if (f.region && local(send.region) !== f.region) continue;
      // A tap on that Element, whether its Behavior notifies or Sends.
      if (f.element && local(send.element) !== f.element) continue;
      // A push of this Send is under way; it is delivered there, or comes back here if the push fails.
      if (this.inFlight(e.space, e.send, recipient(agent))) continue;
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
  #added?: (hash: string) => void;
  constructor(assets: AssetStore, added?: (hash: string) => void) {
    this.#assets = assets;
    this.#added = added;
  }
  put(bytes: Buffer) {
    const hash = this.#assets.put(bytes);
    this.#added?.(hash);
    return hash;
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
  /** The Link's profile folder, where push targets' secrets are kept. */
  home: string;
  store: SendStore;
  inbox: Inbox;
  assets: AssetStore;
  /** An Agent stored an asset (a model or picture it placed): offer it to connected devices now. */
  assetAdded?: (hash: string) => void;
  catalog: Catalog;
  person: { id: string; name: string };
  socket: string;
  token: string;
  /** Spaces this person's Agents can't see: ones someone else shared with them (link/sharing.ts). */
  hidden?: (space: string) => boolean;
  /** How many of the person's devices are connected (not other Links), and the Spaces on their screens. */
  presence?: () => { devices: number; viewing?: string[] };
  /** Whether the person is writing in a Space now, from a device's live pen signal; undefined when no device shows it. */
  writing?: (space: string) => boolean | undefined;
  /** The devices' recognized handwriting lines for one watched Region. */
  deviceHints?: (space: string, region: string) => { strokes: string[]; text: string; confidence: number }[];
  /** Asks the person to approve a new Agent (on the Link's terminal and on paired iPads). */
  announce: (a: AgentRecord) => void;
  /** Asks connected iPads again about an Agent still waiting (one may have missed the question). */
  remind?: (a: AgentRecord) => void;
  /** Resolves once the person decides about this Agent, or after `ms`. */
  decision: (id: string, ms: number, signal: AbortSignal) => Promise<void>;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * How long a call waits for the person to approve the Agent before it answers "still waiting, call again".
 * Under a minute, so it ends well inside every harness's tool timeout (Claude Code's Bash tool stops at 2 min).
 */
const approvalWaitMs = () => Number(process.env.REFLEX_APPROVAL_WAIT_S ?? 50) * 1000;
/** After the person turns an Agent away, how long before it may ask them again. */
const reaskMs = () => Number(process.env.REFLEX_REASK_S ?? 600) * 1000;

export async function startAgentHost(o: AgentHostOptions) {
  o.inbox.recipientsFor = () => o.catalog.agents().filter((a) => a.status === "approved").map((a) => recipient(a.id));
  const names = Object.fromEntries(o.catalog.agents().map((a) => [a.id, a.name]));
  const inbox = new LinkInbox(o.inbox, o.store);
  const core = new Core({
    getSend: (id) => o.store.get(id),
    inbox,
    assets: new LinkAssets(o.assets, o.assetAdded),
    person: { person: o.person.id, name: o.person.name },
    names,
    progressEvery: Number(process.env.REFLEX_PROGRESS_S ?? 15),
    log: o.log,
  });

  const notApproved = (a: AgentRecord, msg: string, fix: string) =>
    new ReflexError("not_approved", [{ code: "not_approved", msg, fix }]);

  async function authorize(who: Who, signal: AbortSignal, progress?: (p: { elapsed_s: number; timeout_s: number; message: string }) => void): Promise<Identity> {
    const name = String(who?.name ?? "").trim().slice(0, 80);
    const credential = String(who?.credential ?? "");
    if (!name || credential.length < 32) throw new ReflexError("invalid_input", [{ code: "invalid_input", msg: "An Agent must say its name and present its credential.", fix: "Connect through `reflex mcp` or the reflex CLI." }]);
    let a = o.catalog.byCredential(credential);
    if (!a) {
      a = o.catalog.request(name, credential);
      o.log("agent_requested", { agent: a.id, name });
      o.announce(a);
    } else if (a.status === "denied" || a.status === "revoked") {
      // Only the person can let an Agent in, so the way back for one they turned away is to ask them again,
      // but not on every call: once per REASK_MS, so an Agent that keeps calling can't keep asking.
      const since = Date.now() - (a.decided_at ?? 0);
      const REASK_MS = reaskMs();
      if (since < REASK_MS) {
        const wait = Math.ceil((REASK_MS - since) / 60_000);
        throw new ReflexError("rate_limited", [
          {
            code: "rate_limited",
            msg: `The person ${a.status} ${a.name} ${since < 60_000 ? "just now" : `${Math.round(since / 60_000)} min ago`}.`,
            fix: `Stop calling Reflex for now. You can ask them again in about ${wait} min; tell them to expect the question.`,
          },
        ]);
      }
      a = o.catalog.askAgain(a.id);
      o.log("agent_requested", { agent: a.id, name, again: true });
      o.announce(a);
    }
    if (a.status === "pending") {
      o.remind?.(a);
      const ms = approvalWaitMs();
      const started = Date.now();
      const message = `Waiting for you to tap Allow on your iPad for ${a.name}`;
      const tick = setInterval(() => progress?.({ elapsed_s: Math.round((Date.now() - started) / 1000), timeout_s: ms / 1000, message }), 10_000);
      try {
        await o.decision(a.id, ms, signal);
      } finally {
        clearInterval(tick);
      }
      a = o.catalog.agent(a.id)!;
    }
    if (a.status === "pending") {
      const asked = Math.max(1, Math.round((Date.now() - a.requested_at) / 60_000));
      throw new ReflexError(
        "not_approved",
        [
          {
            code: "not_approved",
            msg: `Still waiting for the person to tap Allow for ${a.name} on their iPad (asked ${asked} min ago). Nothing is wrong; the question stays up until they answer.`,
            fix: `Tell the person: "Tap Allow in Reflex on your iPad." Then call this tool again. Don't give up or switch tools: you are let in as soon as they tap.`,
          },
        ],
        ["Call the same tool again: it waits for the person's answer."],
      );
    }
    if (a.status !== "approved") throw notApproved(a, `The person ${a.status} ${a.name}.`, "Call again to ask the person once more, and tell them to expect the question on their iPad or in the Link's terminal.");
    for (const send of o.store.list()) o.inbox.adopt(send.space, recipient(a.id));
    return { agent: a.id, name: a.name, color: a.color };
  }

  // Push Send Adapters (link/adapters/): targets, secrets and attempts are kept here, outside the adapters.
  const approved = (agent: string) => o.catalog.agent(agent)?.status === "approved";
  const pushes = new PushStore(o.db, o.home);
  const channel = new ClaudeChannel();
  const webhook = new Webhook();
  const adapters = [channel, webhook];
  // Adapters whose live end is a surface's connection (a `listen` frame), and how each reports opening.
  const surfaces = new Map([
    [channel.name, { adapter: channel, event: "channel", fix: "Connect through `reflex mcp --channel`." }],
  ]);
  const ajv = new Ajv2020({ strict: false });
  const validConfig = new Map(adapters.map((a) => [a.name, ajv.compile(a.config)]));
  const invalid = (msg: string, fix: string) => new ReflexError("invalid_input", [{ code: "invalid_input", msg, fix }]);
  const dispatcher = new Dispatcher({
    inbox: o.inbox,
    store: pushes,
    adapters,
    approved,
    bundle: (agent, space, send) => {
      const a = o.catalog.agent(agent);
      if (!a) return undefined;
      const b = core.bundleFor({ agent: a.id, name: a.name, color: a.color }, space, send);
      return b && { bundle: b.json, images: b.images };
    },
    log: o.log,
  });
  inbox.inFlight = (space, send, to) => dispatcher.inFlight(space, send, to);
  dispatcher.start();

  const listen = (l: Listener): string => {
    const s = surfaces.get(l.adapter);
    if (!s) throw invalid(`No push adapter '${l.adapter}' takes a connection.`, `Use ${[...surfaces.keys()].join(" or ")}.`);
    const valid = validConfig.get(l.adapter)!;
    if (!valid(l.config)) throw invalid(`The ${l.adapter} config is not valid: ${ajv.errorsText(valid.errors)}.`, s.fix);
    const target = pushes.upsert({ agent: l.who.agent, adapter: l.adapter, instance: l.client, config: l.config, callback: "mcp" });
    s.adapter.attach(target, l, () => {
      pushes.touch(target.id);
      o.log(`${s.event}_closed`, { target: target.id, agent: l.who.name });
    });
    o.log(`${s.event}_open`, { target: target.id, agent: l.who.name, config: l.config });
    return target.id;
  };

  const shown = (t: PushTarget) => ({ target: t.id, adapter: t.adapter, config: t.config, callback: t.callback, live: adapters.some((a) => a.name === t.adapter && a.liveSince(t) !== undefined), created_at: t.created_at });
  // `reflex adapters`: an Agent's own webhook targets. Only the Agent itself manages them, once approved.
  const manage = (who: Identity, action: string, args: Record<string, unknown>): Record<string, any> => {
    const mine = pushes.all().filter((t) => t.agent === who.agent);
    if (action === "list") return { ok: true, targets: mine.map(shown) };
    if (action === "remove") {
      const t = mine.find((x) => x.id === args.target);
      if (!t) throw invalid(`You have no push target '${String(args.target)}'.`, "List yours with `reflex adapters list`.");
      pushes.remove(t.id);
      o.log("push_target_removed", { target: t.id, agent: who.name, adapter: t.adapter });
      return { ok: true, removed: t.id };
    }
    if (action !== "add") throw invalid(`Unknown adapters action '${action}'.`, "Use add, list or remove.");
    if (args.adapter !== webhook.name) throw invalid(`'${String(args.adapter)}' can't be added by hand.`, `Add a ${webhook.name}; ${[...surfaces.keys()].join(" and ")} targets open on their own from \`reflex mcp\`.`);
    const config = (args.config ?? {}) as Record<string, unknown>;
    const valid = validConfig.get(webhook.name)!;
    if (!valid(config)) throw invalid(`The webhook config is not valid: ${ajv.errorsText(valid.errors)}.`, "Pass --url https://… (or http:// for a receiver on this machine).");
    const t = pushes.upsert({ agent: who.agent, adapter: webhook.name, instance: String(config.url), config, callback: "tools" });
    // A new secret each time a webhook is added; adding the same URL again rotates it.
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    pushes.setSecret(t.id, secret);
    o.log("push_target_added", { target: t.id, agent: who.name, adapter: webhook.name, url: config.url });
    return { ok: true, ...shown(pushes.get(t.id)!), secret, next: "Keep the secret in your receiver to check each request's reflex-signature. It is not shown again; adding the same URL again makes a new one." };
  };

  const server = await serveHost({ core, socket: o.socket, token: o.token, authorize, listen, adapters: manage, log: o.log });
  return { core, server, pushes, dispatcher, live: (t: PushTarget) => adapters.some((a) => a.name === t.adapter && a.liveSince(t) !== undefined) };
}
