// Receives frozen Sends from today's kernel-backed iPad sync. No canvas mutations.
import { project, type KernelMark, type MarkRef } from "./bundle.ts";
import type { Renderer, SceneElement } from "../render.ts";
import type { Assets, Bounds, FrozenSend, Inbox, SpaceEntry, SpaceStore } from "../store.ts";
import type { ProtocolError } from "../protocol.ts";
export type Identity = { agent: string; name: string; color: string };
export type Ctx = { who: Identity; signal?: AbortSignal; progress?: (p: { elapsed_s: number; timeout_s: number }) => void };
export type Result = { json: Record<string, any>; images: Buffer[]; files?: { id: string; name: string; mime: string; data: Buffer }[]; isError: boolean };
export class ReflexError extends Error {
  body: { reason: string; errors: ProtocolError[]; next?: string[] };
  constructor(reason: string, errors: ProtocolError[], next?: string[]) { super(errors[0]?.msg ?? reason); this.body = { reason, errors, ...(next ? { next } : {}) }; }
}
export class Core {
  spaces: SpaceStore;
  inbox: Inbox;
  assets?: Assets;
  progressEvery: number;
  log: (event: string, data?: Record<string, unknown>) => void;
  renderer: Renderer;
  #marks = new Map<string, Map<string, MarkRef[]>>();
  #lastSend = new Map<string, string>();
  #names = new Map<string, string>();
  constructor(o: { renderer: Renderer; spaces: SpaceStore; inbox: Inbox; assets?: Assets; person: { person: string; name: string }; names?: Record<string, string>; progressEvery?: number; log?: Core["log"] }) {
    this.renderer = o.renderer;
    this.spaces = o.spaces; this.inbox = o.inbox; this.assets = o.assets;
    this.progressEvery = o.progressEvery ?? 15; this.log = o.log ?? (() => {});
    this.#names = new Map(Object.entries(o.names ?? {})); this.#names.set(o.person.person, o.person.name);
  }
  #entry(name: string): SpaceEntry {
    const entry = this.spaces.get(name);
    if (!entry) throw new Error(`Unknown iPad document '${name}'.`);
    return entry;
  }
  scene(entry: SpaceEntry, viewer: { agent: string }, detail: string, ids?: string[]): any[] {
    return JSON.parse(entry.space.scene(JSON.stringify({ detail, viewer, names: Object.fromEntries(this.#names), ...(ids ? { ids } : {}) }))).elements;
  }
  #strokes(entry: SpaceEntry, viewer: { agent: string }, ids?: string[]): Record<string, number[][]> {
    return Object.fromEntries(this.scene(entry, viewer, "strokes", ids).map(s => [s.id, s.points]));
  }
  async call(tool: string, args: unknown, ctx: Ctx): Promise<Result> {
    try {
      if (tool !== "wait_for_user") throw new Error(`Unknown tool '${tool}'. Use wait_for_user.`);
      const a = (args ?? {}) as Record<string, any>;
      if (typeof a !== "object" || Array.isArray(a) || Object.keys(a).some(k => !["space", "after", "timeout_s"].includes(k)) ||
          (a.space !== undefined && typeof a.space !== "string") || (a.after !== undefined && typeof a.after !== "string") ||
          (a.timeout_s !== undefined && (typeof a.timeout_s !== "number" || !Number.isFinite(a.timeout_s) || a.timeout_s < 0 || a.timeout_s > 3600))) throw new Error("Use space, after and timeout_s (0–3600).");
      // No open_space tool: an approved receiver attaches to existing and future iPad documents on wait.
      for (const entry of this.spaces.list()) if (entry.kind === "space" && (!a.space || entry.name === a.space)) this.spaces.attach(entry, ctx.who.agent);
      return { ...await this.waitForUser(a, ctx), isError: false };
    } catch (e) {
      return { json: { ok: false, reason: "invalid_input", errors: [{ code: "invalid_input", msg: (e as Error).message, fix: "Use wait_for_user." }] }, images: [], isError: true };
    }
  }
  async waitForUser(a: Record<string, any>, ctx: Ctx) {
    const agent = ctx.who.agent;
    if (a.after) this.inbox.ack(agent, a.after);
    const filter = { space: a.space, region: a.region, element: a.element };
    const started = Date.now();
    const deadline = started + (a.timeout_s ?? 280) * 1000;
    for (;;) {
      const d = this.inbox.take(agent, filter);
      if (d) return this.#deliver(d.send, d.redelivered, ctx);
      const left = deadline - Date.now();
      if (left <= 0 || ctx.signal?.aborted) break;
      const tick = new AbortController();
      const stop = () => tick.abort();
      ctx.signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, Math.min(left, this.progressEvery * 1000));
      await this.inbox.arrival(agent, tick.signal);
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", stop);
      if (ctx.signal?.aborted) {
        this.log("wait_cancelled", { agent: ctx.who.name, after_s: Math.round((Date.now() - started) / 1000) });
        break;
      }
      ctx.progress?.({ elapsed_s: Math.round((Date.now() - started) / 1000), timeout_s: a.timeout_s });
    }
    return {
      json: { status: "still_waiting", pending_sends: this.inbox.pending(agent), next: "Nothing yet. Call wait_for_user again with the same arguments." },
      images: [],
    };
  }


  /**
   * A Send's Bundle for one Agent, as wait_for_user returns it, for a push Send Adapter. Building it counts
   * as delivering it (answers are placed next to its Marks); the caller records the receipt.
   */
  bundleFor(who: Identity, space: string, send: string): { json: Record<string, any>; images: Buffer[] } | undefined {
    const entry = this.spaces.get(space);
    const frozen = entry ? (JSON.parse(entry.space.send(send)) as FrozenSend | null) : null;
    if (!frozen) return undefined;
    this.#names.set(who.agent, who.name);
    return this.#deliver(frozen, false, { who }, true);
  }

  #deliver(frozen: FrozenSend, redelivered: boolean, ctx: Ctx, pushed = false) {
    const { bundle, images } = this.#project(frozen, redelivered, ctx.who.agent, pushed);
    this.#lastSend.set(`${ctx.who.agent}|${frozen.space}`, frozen.send);
    this.log("send_delivered", { agent: ctx.who.name, send: frozen.send, redelivered, ...(pushed ? { pushed } : {}), marks: bundle.marks.map((m: any) => m.kind) });
    return { json: bundle, images: images.map((i) => i.png) };
  }

  /** Builds a Send's Bundle for one Agent and remembers its Mark IDs, which answers place things by. */
  #project(frozen: FrozenSend, redelivered: boolean, agent: string, pushed = false) {
    const entry = this.#entry(frozen.space);
    const viewer = { agent };
    const elements: SceneElement[] = this.scene(entry, viewer, "full");
    const strokes = this.#strokes(entry, viewer, elements.filter((e) => e.type === "ink").map((e) => e.id));
    const others = this.inbox.recipients(frozen.send).filter((x) => x !== agent);
    // The kernel groups the strokes into Marks and resolves their Anchors at the Send's frontier.
    const kernelMarks: KernelMark[] = JSON.parse(entry.space.marks(frozen.send, JSON.stringify({ viewer })))?.marks ?? [];
    const { bundle, images, marks } = project({
      frozen,
      entry,
      elements,
      outline: this.scene(entry, viewer, "outline"),
      strokes,
      marks: kernelMarks,
      personName: this.#names.get(frozen.from.person) ?? frozen.from.person,
      alsoSentTo: others.map((o) => this.#names.get(o) ?? o),
      redelivered,
      pushed,
      pendingAfter: Math.max(0, this.inbox.pending(agent) - 1),
      renderer: this.renderer,
      asset: (hash) => this.assets?.get(hash),
      displayId: (key) => (key.startsWith(`${agent}/`) ? key.slice(agent.length + 1) : key.replace("/", ":")),
    });
    const byAgent = this.#marks.get(agent) ?? new Map();
    byAgent.set(frozen.send, marks);
    this.#marks.set(agent, byAgent);
    return { bundle, images, marks };
  }

}
