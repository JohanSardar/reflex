// The capability table (ADR-0003): every tool exists exactly once, here. The
// MCP server and the CLI are thin surfaces over `Core.call`, so the two can't
// drift apart.
import { randomBytes } from "node:crypto";
import { IMPLEMENTED, TOOLS, explain, inputSchema, validateError, validateInput, validateOutput, type ProtocolError, type Tool } from "../protocol.ts";
import type { Renderer, SceneElement } from "../render.ts";
import type { Assets, Bounds, FrozenSend, Inbox, SpaceEntry, SpaceStore } from "../store.ts";
import { project, type MarkRef } from "./bundle.ts";
import { normalizeOps } from "./normalize.ts";
import * as library from "../library.ts";

export type Identity = { agent: string; name: string; color: string };
export type Person = { person: string; name: string };
export type Ctx = {
  who: Identity;
  /** Aborts a waiting call: MCP cancellation, a closed pipe, Ctrl-C. */
  signal?: AbortSignal;
  /** Called while a call is held open, so the surface can send keepalives. */
  progress?: (p: { elapsed_s: number; timeout_s: number }) => void;
};
export type Result = { json: Record<string, any>; images: Buffer[]; isError: boolean };

export class ReflexError extends Error {
  body: { reason: string; errors: ProtocolError[]; next?: string[] };
  constructor(reason: string, errors: ProtocolError[], next?: string[]) {
    super(errors[0]?.msg ?? reason);
    this.body = { reason, errors, ...(next?.length ? { next } : {}) };
  }
}
const fail = (code: string, msg: string, fix: string, next?: string[]) => new ReflexError(code, [{ code, msg, fix }], next);

const MARK_ID = /^m[0-9]{1,6}$/;
const overlaps = (a: Bounds, b: Bounds) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const pad = (b: Bounds, p: number): Bounds => [b[0] - p, b[1] - p, b[2] + 2 * p, b[3] + 2 * p];
const union = (bs: Bounds[]): Bounds => {
  const x0 = Math.min(...bs.map((b) => b[0]));
  const y0 = Math.min(...bs.map((b) => b[1]));
  return [x0, y0, Math.max(1, Math.max(...bs.map((b) => b[0] + b[2])) - x0), Math.max(1, Math.max(...bs.map((b) => b[1] + b[3])) - y0)];
};
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

export class Core {
  spaces: SpaceStore;
  inbox: Inbox;
  assets?: Assets;
  renderer: Renderer;
  person: Person;
  progressEvery: number;
  log: (event: string, data?: Record<string, unknown>) => void;
  #names = new Map<string, string>();
  /** Mark IDs are per Send: agent -> send -> marks, for placement and read. */
  #marks = new Map<string, Map<string, MarkRef[]>>();
  #lastSend = new Map<string, string>();

  constructor(o: {
    spaces: SpaceStore;
    inbox: Inbox;
    assets?: Assets;
    renderer: Renderer;
    person: Person;
    /** Display names by principal ID, such as every approved Agent's. */
    names?: Record<string, string>;
    progressEvery?: number;
    log?: Core["log"];
  }) {
    this.spaces = o.spaces;
    this.inbox = o.inbox;
    this.assets = o.assets;
    for (const [id, name] of Object.entries(o.names ?? {})) this.#names.set(id, name);
    this.renderer = o.renderer;
    this.person = o.person;
    this.progressEvery = o.progressEvery ?? 15;
    this.log = o.log ?? (() => {});
    this.#names.set(o.person.person, o.person.name);
  }

  // ---------- the one entry point ----------

  async call(tool: string, args: unknown, ctx: Ctx): Promise<Result> {
    this.#names.set(ctx.who.agent, ctx.who.name);
    const pending = () => this.inbox.pending(ctx.who.agent);
    try {
      if (!(TOOLS as readonly string[]).includes(tool))
        throw fail("invalid_input", `There is no tool '${tool}'.`, `Use one of: ${TOOLS.join(", ")}.`);
      const t = tool as Tool;
      const input = (args ?? {}) as Record<string, any>;
      if (!IMPLEMENTED.has(t))
        throw fail(
          "unavailable",
          `${t} is not available yet in this build of Reflex.`,
          t === "read_me"
            ? "Go ahead without it: the apply tool's description and its input schema list every built-in type and its fields."
            : "Use open_space, read, look, apply and wait_for_user.",
        );
      this.#check(t, input);
      const out = await this.#run(t, input, ctx);
      const v = validateOutput(t);
      if (!v(out.json)) this.log("output_invalid", { tool: t, errors: v.errors });
      return { ...out, isError: false };
    } catch (e) {
      const body =
        e instanceof ReflexError
          ? e.body
          : { reason: "internal", errors: [{ code: "internal", msg: `Reflex failed: ${(e as Error).message}`.slice(0, 400), fix: "Retry; report this if it repeats." }] };
      if (!(e instanceof ReflexError)) this.log("internal_error", { tool, error: String((e as Error).stack ?? e) });
      const json = { ok: false, ...body, pending_sends: pending() };
      if (!validateError(json)) this.log("error_invalid", { tool, errors: validateError.errors });
      return { json, images: [], isError: true };
    }
  }

  #check(tool: Tool, input: Record<string, any>) {
    const v = validateInput(tool);
    // apply's ops are checked one by one in normalizeOps, against the variant each one means.
    const probe = tool === "apply" && Array.isArray(input.ops) ? { ...input, ops: input.ops.length ? [{ op: "remove", ids: ["x"] }] : [] } : input;
    if (!v(probe)) throw new ReflexError("invalid_input", explain(v.errors ?? [], tool, Object.keys(inputSchema(tool).properties ?? {})));
  }

  #run(tool: Tool, a: Record<string, any>, ctx: Ctx): Promise<Omit<Result, "isError">> | Omit<Result, "isError"> {
    switch (tool) {
      case "list_spaces":
        return this.listSpaces(ctx);
      case "open_space":
        return this.openSpace(a, ctx);
      case "read":
        return this.read(a, ctx);
      case "look":
        return this.look(a, ctx);
      case "apply":
        return this.apply(a, ctx);
      case "wait_for_user":
        return this.waitForUser(a, ctx);
      case "read_me":
        return this.readMe(a, ctx);
      default:
        throw fail("unavailable", `${tool} is not available yet.`, "Use open_space, read, look, apply and wait_for_user.");
    }
  }

  // ---------- helpers ----------

  #who() {
    return this.person.name === "You" ? "the person's" : `${this.person.name}'s`;
  }

  #entry(name: string): SpaceEntry {
    const e = this.spaces.get(name);
    if (!e || e.kind !== "space") {
      const known = this.spaces.list().filter((s) => s.kind === "space").map((s) => s.name);
      throw fail(
        "unknown_space",
        `No Space '${name}'.${known.length ? ` Spaces: ${known.join(", ")}.` : ""}`,
        `Create it with open_space(space: '${name}', create: true).`,
        [`open_space(space: '${name}', create: true)`],
      );
    }
    return e;
  }

  #names_(): Record<string, string> {
    return Object.fromEntries(this.#names);
  }

  scene(entry: SpaceEntry, viewer: { agent: string } | { person: string }, detail: "full" | "outline" | "strokes", ids?: string[]): any[] {
    const q = { detail, viewer, names: this.#names_(), ...(ids ? { ids } : {}) };
    return JSON.parse(entry.space.scene(JSON.stringify(q))).elements;
  }

  #strokes(entry: SpaceEntry, viewer: { agent: string } | { person: string }, ids?: string[]): Record<string, number[][]> {
    return Object.fromEntries(this.scene(entry, viewer, "strokes", ids).map((s: any) => [s.id, s.points]));
  }

  #marksFor(agent: string, send?: string): MarkRef[] | undefined {
    const s = send ?? this.#lastSend.get(agent);
    return s ? this.#marks.get(agent)?.get(s) : undefined;
  }

  // ---------- tools ----------

  listSpaces(ctx: Ctx) {
    const spaces = this.spaces
      .list()
      .filter((s) => s.kind === "space")
      .map((s) => ({
        space: s.name,
        ...(s.title ? { title: s.title } : {}),
        unread: false,
        pending_sends: this.inbox.pending(ctx.who.agent, s.name),
        agents: [...s.agents].map((a) => this.#names.get(a) ?? a),
        people: [this.person.name],
      }));
    return { json: { spaces, pending_sends: this.inbox.pending(ctx.who.agent) }, images: [] };
  }

  openSpace(a: Record<string, any>, ctx: Ctx) {
    let entry = this.spaces.get(a.space);
    let created = false;
    if (!entry && a.create) {
      entry = this.spaces.create(a.space, { title: a.title, size: a.size, width: a.width });
      created = true;
      this.log("space_created", { space: a.space, by: ctx.who.name });
    }
    entry = this.#entry(a.space);
    this.spaces.attach(entry, ctx.who.agent);
    const outline = this.scene(entry, { agent: ctx.who.agent }, "outline");
    const onScreen = outline.filter((e) => overlaps(entry.viewport, e.bounds));
    const scene = onScreen.slice(0, 500);
    const pending = this.inbox.pending(ctx.who.agent);
    const here = this.inbox.pending(ctx.who.agent, entry.name);
    return {
      json: {
        space: entry.name,
        created,
        you: { agent: ctx.who.agent, name: ctx.who.name, color: ctx.who.color },
        people: [this.person],
        viewport: entry.viewport,
        scene,
        elsewhere: { on_screen: onScreen.length - scene.length, off_screen: outline.length - onScreen.length },
        pending_sends: pending,
        next: here
          ? `${plural(here, "Send")} waiting. Call wait_for_user(timeout_s: 0) to read ${here === 1 ? "it" : "them"}.`
          : created
            ? `Draw with apply(space: '${entry.name}', ops: [...]), then wait_for_user for ${this.#who()} reply.`
            : `Change it with apply, or wait_for_user for ${this.#who()} next Send.`,
      },
      images: [],
    };
  }

  read(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    const viewer = { agent: ctx.who.agent };
    const detail: "outline" | "full" | "strokes" = a.detail ?? "outline";
    const marks = this.#marksFor(ctx.who.agent) ?? [];
    const pending_sends = this.inbox.pending(ctx.who.agent);
    if (detail !== "outline") {
      if (!a.ids) throw fail("invalid_input", `read(detail: "${detail}") needs ids.`, `Pass ids, such as ids: ["n-auth"]. Call read(space: '${a.space}') for the IDs.`);
      // Mark IDs read as their strokes.
      const want: string[] = a.ids.flatMap((id: string) => (MARK_ID.test(id) ? (marks.find((m) => m.id === id)?.strokes ?? [id]) : [id]));
      const found = detail === "full" ? this.scene(entry, viewer, "full", want) : this.scene(entry, viewer, "strokes", want);
      const got = new Set(found.map((e: any) => e.id));
      const missing = want.filter((id) => !got.has(id));
      if (missing.length) {
        const all = this.scene(entry, viewer, "outline").map((e: any) => e.id);
        throw new ReflexError(
          "unknown_id",
          missing.map((id) => ({
            code: "unknown_id",
            msg: detail === "strokes" && all.includes(id) ? `'${id}' is not Ink or a Mark.` : `No Element '${id}'.`,
            fix: detail === "strokes" ? "Pass the IDs of Ink Elements or Marks from a Send." : `Call read(space: '${a.space}') for the IDs.`,
          })),
          [`read(space: '${a.space}')`],
        );
      }
      if (detail === "full") return { json: { space: entry.name, elements: found, pending_sends }, images: [] };
      const markOf = new Map(marks.flatMap((m) => m.strokes.map((s) => [s, m.id] as const)));
      const strokes = found.map((s: any) => ({ ...s, ...(markOf.has(s.id) ? { mark: markOf.get(s.id) } : {}) }));
      return { json: { space: entry.name, strokes, pending_sends }, images: [] };
    }
    const outline: any[] = this.scene(entry, viewer, "outline");
    let area: Bounds | undefined = a.bounds;
    if (a.near) {
      const mark = MARK_ID.test(a.near) ? marks.find((m) => m.id === a.near) : undefined;
      const el = outline.find((e) => e.id === a.near);
      const b = mark?.bounds ?? el?.bounds;
      if (!b) throw fail("unknown_id", `No Element or Mark '${a.near}'.`, `Call read(space: '${a.space}') for the IDs.`);
      area = pad(b, 300);
    }
    const hit = area ? outline.filter((e) => overlaps(area!, e.bounds)) : outline;
    const shown = hit.slice(0, 2000);
    const ids = new Set(shown.map((e) => e.id));
    const rest = outline.filter((e) => !ids.has(e.id));
    const onScreen = rest.filter((e) => overlaps(entry.viewport, e.bounds)).length;
    return {
      json: { space: entry.name, outline: shown, elsewhere: { on_screen: onScreen, off_screen: rest.length - onScreen }, pending_sends },
      images: [],
    };
  }

  #render(entry: SpaceEntry, agent: string, bounds: Bounds, width: number) {
    const viewer = { agent };
    // Everything is drawn and the image clips to bounds, so a connector whose end is outside still points the right way.
    const elements: SceneElement[] = this.scene(entry, viewer, "full");
    const strokes = this.#strokes(
      entry,
      viewer,
      elements.filter((e: SceneElement) => e.type === "ink").map((e: SceneElement) => e.id),
    );
    return this.renderer.render({ elements, strokes, bounds, width });
  }

  look(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    if (a.ids && a.bounds) throw fail("invalid_input", "look takes ids or bounds, not both.", "Pass only ids, or only bounds.");
    const all: SceneElement[] = this.scene(entry, { agent: ctx.who.agent }, "outline");
    let bounds: Bounds;
    if (a.bounds) bounds = a.bounds;
    else {
      let ids: string[] | undefined = a.ids;
      const marks = this.#marksFor(ctx.who.agent) ?? [];
      if (!ids) {
        const focus = JSON.parse(entry.space.scene(JSON.stringify({ detail: "full", ids: [] }))).focus?.[ctx.who.agent];
        if (focus?.bounds) ids = undefined;
        if (focus?.bounds) bounds = focus.bounds;
        else ids = focus?.ids;
      }
      if (ids) {
        const bs: Bounds[] = [];
        const missing: string[] = [];
        for (const id of ids) {
          const b = all.find((e) => e.id === id)?.bounds ?? marks.find((m) => m.id === id)?.bounds;
          if (b) bs.push(b);
          else missing.push(id);
        }
        if (missing.length) throw fail("unknown_id", `No Element '${missing.join("', '")}'.`, `Call read(space: '${a.space}') for the IDs.`);
        bounds = pad(union(bs), 40);
      }
      // Neither: the whole Space, or the person's viewport when it is empty.
      bounds ??= all.length ? pad(union(all.map((e) => e.bounds)), 40) : entry.viewport;
    }
    const { png, px } = this.#render(entry, ctx.who.agent, bounds, a.width ?? 1024);
    return { json: { bounds, px, pending_sends: this.inbox.pending(ctx.who.agent) }, images: [png] };
  }

  async apply(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    const agent = ctx.who.agent;
    if (a.in_reply_to && !this.inbox.recipients(a.in_reply_to).includes(agent))
      throw fail("unknown_send", `No Send '${a.in_reply_to}' in your Inbox.`, "Pass the send ID from a Send Bundle, or leave in_reply_to out.", ["wait_for_user(timeout_s: 0)"]);
    const norm = normalizeOps(a.ops);
    if (norm.errors.length) throw new ReflexError(norm.errors.length === 1 ? norm.errors[0].code : "batch_rejected", norm.errors, [`read(space: '${a.space}')`]);

    // Placement next to a Mark: Marks live in Send Bundles, not in the kernel.
    let marks = this.#marksFor(agent, a.in_reply_to) ?? [];
    // Mark IDs live in memory; after a restart, an answer to a Send delivered before it rebuilds them from the frozen Send.
    if (a.in_reply_to && !this.#marks.get(agent)?.has(a.in_reply_to)) {
      const frozen: FrozenSend | null = JSON.parse(entry.space.send(a.in_reply_to));
      if (frozen) marks = this.#project(frozen, false, agent).marks;
    }
    const outline: SceneElement[] = this.scene(entry, { agent }, "outline");
    const has = (id: string) => outline.some((e) => e.id === id);
    const errors: ProtocolError[] = [];
    const ops = norm.ops.map((op, i) => {
      const markOf = (id: unknown, field: string) => {
        if (typeof id !== "string" || !MARK_ID.test(id) || has(id)) return undefined;
        const m = marks.find((m) => m.id === id);
        if (!m) errors.push({ op: i, field, code: "unknown_id", msg: `No Mark '${id}'${a.in_reply_to ? ` in Send ${a.in_reply_to}` : ""}.`, fix: "Use a Mark ID from the Send you are answering, with in_reply_to." });
        return m;
      };
      // An answer without a position goes next to what the person marked, not to the Space's origin.
      if (op.op === "add" && op.type !== "connector" && !op.at && !op.points && marks.length && a.in_reply_to) op.at = { near: marks[0].id };
      const at = op.op === "add" || op.op === "arrange" ? op.at : op.op === "patch" ? op.set?.at : undefined;
      if (at) {
        for (const rel of ["right_of", "left_of", "above", "below", "near", "inside"]) {
          const m = markOf(at[rel], `/at/${rel}`);
          if (!m) continue;
          const [x, y, w, h] = m.bounds;
          const gap = at.gap ?? (rel === "inside" ? 24 : 40);
          // The size of what is placed: a patched Element's own bounds, or an arranged group's extent
          // (exact for row and column; grid and tree take the larger of the two, so the group never lands on the Mark).
          let own = op.op === "patch" ? outline.find((e) => e.id === op.id)?.bounds : undefined;
          if (op.op === "arrange") {
            const bs = (op.ids as string[]).map((id) => outline.find((e) => e.id === id)?.bounds).filter((b): b is Bounds => !!b);
            const g = (op.gap ?? 40) * Math.max(0, bs.length - 1);
            const ws = bs.map((b) => b[2]);
            const hs = bs.map((b) => b[3]);
            const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
            if (bs.length) own = [0, 0, op.layout === "column" ? Math.max(...ws) : sum(ws) + g, op.layout === "row" ? Math.max(...hs) : sum(hs) + g];
          }
          const sw = op.w ?? op.set?.w ?? own?.[2] ?? 200;
          const sh = op.h ?? op.set?.h ?? own?.[3] ?? 120;
          const pos = { right_of: [x + w + gap, y], near: [x + w + gap, y], left_of: [x - gap - sw, y], below: [x, y + h + gap], above: [x, y - gap - sh], inside: [x + gap, y + gap] }[rel]!;
          const placed = { x: Math.round(pos[0]), y: Math.round(pos[1]) };
          if (op.op === "patch") op.set = { ...op.set, at: placed };
          else op.at = placed;
        }
      }
      if (op.op === "add" && op.type === "connector") {
        const center = (id: string) => {
          const m = markOf(id, "/from");
          const b = m?.bounds ?? outline.find((e) => e.id === id)?.bounds;
          return b ? [Math.round(b[0] + b[2] / 2), Math.round(b[1] + b[3] / 2)] : undefined;
        };
        const fromMark = typeof op.from === "string" && MARK_ID.test(op.from) && !has(op.from);
        const toMark = typeof op.to === "string" && MARK_ID.test(op.to) && !has(op.to);
        if (fromMark || toMark) {
          const p0 = center(op.from);
          const p1 = center(op.to);
          if (p0 && p1) {
            op.points = [p0, p1];
            delete op.from;
            delete op.to;
            norm.repaired.push(`ops[${i}]: a connector to a Mark is drawn as a free line`);
          }
        }
      }
      return op;
    });
    // define saves to the Library: each one is checked like any extension first, so a bad one rejects the whole batch.
    const checked = library.checkDefines(ops.map((op, index) => ({ op, index })).filter((x) => x.op.op === "define"));
    errors.push(...checked.errors);
    if (errors.length) throw new ReflexError(errors.length === 1 ? errors[0].code : "batch_rejected", errors);

    // define saves to the Library, which is its own Space.
    const defines = ops.filter((o) => o.op === "define");
    const rest = ops.filter((o) => o.op !== "define");
    const request = a.request ?? `r_${randomBytes(8).toString("hex")}`;
    const now = Date.now();
    let result: Record<string, any> | undefined;
    if (rest.length || !defines.length) {
      result = JSON.parse(this.spaces.write(entry, "agent", (s) => s.applyAgentBatch(agent, request, JSON.stringify({ ops: rest }), now)));
      if (!result!.ok) {
        // Kernel op indexes count the ops sent; map them back to the caller's.
        const index = ops.map((o, i) => [o, i] as const).filter(([o]) => o.op !== "define").map(([, i]) => i);
        const errs = (result!.errors as ProtocolError[]).map((e) => ({ ...e, op: index[e.op ?? 0] ?? e.op }));
        const next = [...new Set(errs.flatMap((e) => {
          const close = /Closest: '([^']+)'/.exec(e.msg)?.[1];
          return close ? [`read(space: '${a.space}', ids: ['${close}'], detail: 'full')`] : e.code === "unknown_id" ? [`read(space: '${a.space}')`] : [];
        }))];
        throw new ReflexError(result!.reason, errs, next);
      }
    }
    if (defines.length) {
      const lib = this.spaces.get(library.LIBRARY) ?? this.spaces.create(library.LIBRARY, { kind: "library" });
      const r = JSON.parse(this.spaces.write(lib, "agent", (s) => s.applyAgentBatch(agent, `${request}.define`, JSON.stringify({ ops: defines }), now)));
      if (!r.ok) throw new ReflexError(r.reason, r.errors);
      result ??= r;
    }
    if (a.in_reply_to) this.inbox.ack(agent, a.in_reply_to);
    const json: Record<string, any> = {
      ok: true,
      batch: result!.batch,
      ...(Object.keys(result!.ids ?? {}).length ? { ids: result!.ids } : {}),
      repaired: [...norm.repaired, ...(result!.repaired ?? [])],
      lints: [...(result!.lints ?? []), ...checked.lints],
      pending_sends: this.inbox.pending(agent),
    };
    const images: Buffer[] = [];
    if (a.look) {
      const after: SceneElement[] = this.scene(entry, { agent }, "outline");
      const touched = new Set<string>(Object.values(result!.ids ?? {}) as string[]);
      for (const op of rest) {
        if (op.id) touched.add(op.id);
        for (const id of op.ids ?? []) touched.add(id);
      }
      const bs = after.filter((e) => touched.has(e.id)).map((e) => e.bounds);
      const bounds = pad(union(bs.length ? bs : after.map((e) => e.bounds).concat([[0, 0, 1, 1]])), 60);
      const { png, px } = this.#render(entry, agent, bounds, 1024);
      json.look = { bounds, px };
      images.push(png);
    }
    return { json, images };
  }

  readMe(a: Record<string, any>, ctx: Ctx) {
    const name = (id: string) => this.#names.get(id) ?? id;
    const pending_sends = this.inbox.pending(ctx.who.agent);
    if (a.topic === "index") return { json: { topic: "index", text: library.index(this.spaces, name), source: "builtin", pending_sends }, images: [] };
    const found = library.topic(this.spaces, a.topic, name);
    if (!found) {
      const known = library.topics(this.spaces);
      throw fail("unknown_topic", `No Guide, Recipe or Embed Template '${a.topic}'.`, `Call read_me("index") for what there is${known.length > 1 ? `: ${known.slice(1, 20).join(", ")}` : ""}.`, ['read_me(topic: "index")']);
    }
    return { json: { topic: a.topic, text: found.text, source: found.source, pending_sends }, images: [] };
  }

  async waitForUser(a: Record<string, any>, ctx: Ctx) {
    const agent = ctx.who.agent;
    if (a.after) this.inbox.ack(agent, a.after);
    const filter = { space: a.space, region: a.region, element: a.element };
    const started = Date.now();
    const deadline = started + a.timeout_s * 1000;
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

  #deliver(frozen: FrozenSend, redelivered: boolean, ctx: Ctx) {
    const { bundle, images } = this.#project(frozen, redelivered, ctx.who.agent);
    this.#lastSend.set(ctx.who.agent, frozen.send);
    this.log("send_delivered", { agent: ctx.who.name, send: frozen.send, redelivered });
    return { json: bundle, images: images.map((i) => i.png) };
  }

  /** Builds a Send's Bundle for one Agent and remembers its Mark IDs, which answers place things by. */
  #project(frozen: FrozenSend, redelivered: boolean, agent: string) {
    const entry = this.#entry(frozen.space);
    const viewer = { agent };
    const elements: SceneElement[] = this.scene(entry, viewer, "full");
    const strokes = this.#strokes(entry, viewer, elements.filter((e) => e.type === "ink").map((e) => e.id));
    const others = this.inbox.recipients(frozen.send).filter((x) => x !== agent);
    const { bundle, images, marks } = project({
      frozen,
      entry,
      elements,
      outline: this.scene(entry, viewer, "outline"),
      strokes,
      personName: this.#names.get(frozen.from.person) ?? frozen.from.person,
      alsoSentTo: others.map((o) => this.#names.get(o) ?? o),
      redelivered,
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

  // ---------- the person's side without an iPad: `reflex dev person`, on a Link started with --dev ----------

  #findForPerson(entry: SpaceEntry, id: string): SceneElement {
    const all: SceneElement[] = this.scene(entry, { person: this.person.person }, "full");
    const text = (e: SceneElement) => String(e.text ?? e.title ?? e.latex ?? "").toLowerCase();
    const el =
      all.find((e) => e.id === id) ??
      all.find((e) => e.id.endsWith(`:${id}`)) ??
      all.find((e) => e.type !== "connector" && e.type !== "ink" && text(e).includes(id.toLowerCase()));
    if (!el) throw fail("unknown_id", `No Element '${id}'.`, `Elements: ${all.map((e) => e.id).join(", ")}`);
    return el;
  }

  /** Draws one finished stroke as the person. `points` are [x, y] pairs. */
  personStroke(space: string, points: number[][], o: { color?: string; width?: number } = {}) {
    const entry = this.#entry(space);
    const id = `ink-${randomBytes(4).toString("hex")}`;
    // A real Pencil stroke carries time and pressure: [x, y, t, pressure].
    const timed = points.map((p, i) => [p[0], p[1], i * 8, 0.6]);
    const r = JSON.parse(
      this.spaces.write(entry, "person", (s) =>
        s.applyUserIntent(
          this.person.person,
          "dev-person",
          JSON.stringify({ intent: "add_stroke", id, stroke: { points: timed, width: o.width ?? 3 }, color: o.color ?? "red" }),
          Date.now(),
        ),
      ),
    );
    if (!r.ok) throw new ReflexError(r.reason, r.errors);
    return { id };
  }

  /** A loose hand-drawn circle around an Element. */
  personCircle(space: string, target: string) {
    const el = this.#findForPerson(this.#entry(space), target);
    const [x, y, w, h] = el.bounds;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const pts: number[][] = [];
    for (let i = 0; i <= 36; i++) {
      const t = (i / 36) * Math.PI * 2.05 + 0.3;
      pts.push([Math.round(cx + Math.cos(t) * (w / 2 + 22) * (1 + 0.04 * Math.sin(3 * t))), Math.round(cy + Math.sin(t) * (h / 2 + 20))]);
    }
    return this.personStroke(space, pts);
  }

  /** An underline under an Element. */
  personUnderline(space: string, target: string) {
    const el = this.#findForPerson(this.#entry(space), target);
    const [x, y, w, h] = el.bounds;
    return this.personStroke(space, [
      [x, y + h + 10],
      [x + w / 2, y + h + 13],
      [x + w, y + h + 9],
    ]);
  }

  /** Presses Send: freezes the person's strokes and changes and delivers the Send. */
  personSend(space: string, o: { said?: string; trigger?: string; embedAnchors?: Record<string, unknown>[] } = {}) {
    const entry = this.#entry(space);
    const send = `s_${randomBytes(5).toString("hex")}`;
    const raw = {
      send,
      trigger: o.trigger ?? (o.said ? "voice" : "button"),
      viewport: entry.viewport,
      ...(o.said ? { said: o.said } : {}),
      // What Embeds answered about the Marks on them (`reflex dev` asks them in the browser).
      ...(o.embedAnchors?.length ? { embed_anchors: o.embedAnchors } : {}),
    };
    // Freezing it makes it durable and puts it in the Inbox of every Agent on this Space.
    const frozen = JSON.parse(this.spaces.write(entry, "send", (s) => s.freezeSend(this.person.person, "dev-person", JSON.stringify(raw), Date.now()))) as FrozenSend;
    if ((frozen as any).ok === false) throw new ReflexError((frozen as any).reason, (frozen as any).errors);
    const recipients = this.inbox.recipients(send);
    this.log("send_frozen", { send, space, recipients: recipients.map((r) => this.#names.get(r) ?? r), strokes: frozen.strokes.length });
    return { send, recipients: recipients.map((r) => this.#names.get(r) ?? r) };
  }
}
