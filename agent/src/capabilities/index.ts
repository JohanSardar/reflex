// The capability table (ADR-0003): every tool exists exactly once, here. The
// MCP server and the CLI are thin surfaces over `Core.call`, so the two can't
// drift apart.
import { createHash, randomBytes } from "node:crypto";
import { IMPLEMENTED, TOOLS, explain, inputSchema, validateError, validateInput, validateOutput, type ProtocolError, type Tool } from "../protocol.ts";
import type { Renderer, SceneElement } from "../render.ts";
import type { Assets, Bounds, FrozenSend, Inbox, SpaceEntry, SpaceStore } from "../store.ts";
import { project, type KernelMark, type MarkRef } from "./bundle.ts";
import { normalizeOps } from "./normalize.ts";
import * as library from "../library.ts";
import { RECIPES, checkParams, expand, fromLibrary, typeGuide, type Recipe } from "../extensions.ts";
import { runExec } from "../exec.ts";

export type Identity = { agent: string; name: string; color: string };
export type Person = { person: string; name: string };
export type Ctx = {
  who: Identity;
  /** Aborts a waiting call: MCP cancellation, a closed pipe, Ctrl-C. */
  signal?: AbortSignal;
  /** Called while a call is held open, so the surface can send keepalives. */
  progress?: (p: { elapsed_s: number; timeout_s: number }) => void;
};
/** A file's bytes a result carries besides its JSON (read of a file Element). */
export type FileOut = { id: string; name: string; mime: string; data: Buffer };
export type Result = { json: Record<string, any>; images: Buffer[]; files?: FileOut[]; isError: boolean };
type Out = Omit<Result, "isError">;

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
  #extensions: library.Extension[];
  /** Mark IDs are per Send: agent -> send -> marks, for placement and read. */
  #marks = new Map<string, Map<string, MarkRef[]>>();
  /** The last Send each Agent got in each Space: `<agent>|<space>` -> send. */
  #lastSend = new Map<string, string>();
  #colors = new Map<string, string>();
  presence: () => { devices: number };

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
    /** Extensions read_me also answers for, beyond the installed ones and the Library (the one `reflex dev` is authoring). */
    extensions?: library.Extension[];
    /** How many of the person's devices are connected now, for request_attention. */
    presence?: () => { devices: number };
  }) {
    this.#extensions = o.extensions ?? [];
    this.spaces = o.spaces;
    this.inbox = o.inbox;
    this.assets = o.assets;
    for (const [id, name] of Object.entries(o.names ?? {})) this.#names.set(id, name);
    this.renderer = o.renderer;
    this.person = o.person;
    this.progressEvery = o.progressEvery ?? 15;
    this.log = o.log ?? (() => {});
    this.presence = o.presence ?? (() => ({ devices: 0 }));
    this.#names.set(o.person.person, o.person.name);
  }

  // ---------- the one entry point ----------

  async call(tool: string, args: unknown, ctx: Ctx): Promise<Result> {
    this.#names.set(ctx.who.agent, ctx.who.name);
    this.#colors.set(ctx.who.agent, ctx.who.color);
    const pending = () => this.inbox.pending(ctx.who.agent);
    try {
      if (!(TOOLS as readonly string[]).includes(tool))
        throw fail("invalid_input", `There is no tool '${tool}'.`, `Use one of: ${TOOLS.join(", ")}.`);
      const t = tool as Tool;
      const input = (args ?? {}) as Record<string, any>;
      if (!IMPLEMENTED.has(t)) throw fail("unavailable", `${t} is not available in this build of Reflex.`, "Use open_space, read, look, apply and wait_for_user.");
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

  #run(tool: Tool, a: Record<string, any>, ctx: Ctx): Promise<Out> | Out {
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
      case "exec":
        return this.exec(a, ctx);
      case "read_me":
        return this.readMe(a, ctx);
      case "recipe":
        return this.recipe(a, ctx);
      case "request_attention":
        return this.requestAttention(a, ctx);
      case "revert":
        return this.revert(a, ctx);
    }
  }

  // ---------- helpers ----------

  #who() {
    return this.person.name === "You" ? "the person's" : `${this.person.name}'s`;
  }

  #entry(name: string): SpaceEntry {
    const e = this.spaces.get(name);
    if (e?.kind === "library" || name === "library")
      throw fail(
        "invalid_input",
        `'${name}' is the person's Library, where Recipes and Embed Templates saved with define live; it is not a Space to draw in.`,
        "Pick another name for your Space. read_me(\"index\") lists what the Library holds.",
        [`read_me(topic: "index")`],
      );
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

  /** The Marks of one Send, or of the last Send this Agent got in this Space. */
  #marksFor(agent: string, send: string | undefined, space: string): MarkRef[] | undefined {
    const s = send ?? this.#lastSend.get(`${agent}|${space}`);
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
    if (a.space === "library") this.#entry(a.space); // says why the name is taken
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
    const marks = this.#marksFor(ctx.who.agent, undefined, entry.name) ?? [];
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
      if (detail === "full") {
        const { files, bytes } = this.#fileContents(found);
        return { json: { space: entry.name, elements: found, ...(files.length ? { files } : {}), pending_sends }, images: [], files: bytes };
      }
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
    return this.renderer.render({ elements, strokes, bounds, width, asset: (h) => this.assets?.get(h) });
  }

  look(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    if (a.ids && a.bounds) throw fail("invalid_input", "look takes ids or bounds, not both.", "Pass only ids, or only bounds.");
    const all: SceneElement[] = this.scene(entry, { agent: ctx.who.agent }, "outline");
    let bounds: Bounds;
    if (a.bounds) bounds = a.bounds;
    else {
      let ids: string[] | undefined = a.ids;
      const marks = this.#marksFor(ctx.who.agent, undefined, entry.name) ?? [];
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
    let marks = this.#marksFor(agent, a.in_reply_to, entry.name) ?? [];
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

    // define saves to the Library, which is its own Space. The kernel counts ops within what it is sent,
    // so its op indexes (in errors, ids and repairs) are mapped back to the caller's.
    const defines = ops.filter((o) => o.op === "define");
    const rest = ops.filter((o) => o.op !== "define");
    const where = (pick: (o: Record<string, any>) => boolean) => ops.map((o, i) => [o, i] as const).filter(([o]) => pick(o)).map(([, i]) => i);
    const restIndex = where((o) => o.op !== "define");
    const defIndex = where((o) => o.op === "define");
    const remap = (r: Record<string, any>, index: number[]) => {
      const at = (k: number) => index[k] ?? k;
      if (r.ids) r.ids = Object.fromEntries(Object.entries(r.ids).map(([k, v]) => [k.replace(/^ops\[(\d+)\]/, (_, n) => `ops[${at(Number(n))}]`), v]));
      if (r.repaired) r.repaired = (r.repaired as string[]).map((x) => x.replace(/^ops\[(\d+)\]/, (_, n) => `ops[${at(Number(n))}]`));
      if (r.errors) r.errors = (r.errors as ProtocolError[]).map((e) => ({ ...e, op: at(e.op ?? 0), msg: e.msg.replace(/ops\[(\d+)\]/g, (_, n) => `ops[${at(Number(n))}]`) }));
      return r;
    };
    const request = a.request ?? `r_${randomBytes(8).toString("hex")}`;
    const now = Date.now();
    let result: Record<string, any> | undefined;
    if (rest.length || !defines.length) {
      result = remap(JSON.parse(this.spaces.write(entry, "agent", (s) => s.applyAgentBatch(agent, request, JSON.stringify({ ops: rest }), now))), restIndex);
      if (!result!.ok) {
        const errs = result!.errors as ProtocolError[];
        const next = [...new Set(errs.flatMap((e) => {
          const close = /Closest: '([^']+)'/.exec(e.msg)?.[1];
          return close ? [`read(space: '${a.space}', ids: ['${close}'], detail: 'full')`] : e.code === "unknown_id" ? [`read(space: '${a.space}')`] : [];
        }))];
        throw new ReflexError(result!.reason, errs, next);
      }
    }
    if (defines.length) {
      const lib = this.spaces.get(library.LIBRARY) ?? this.spaces.create(library.LIBRARY, { kind: "library" });
      const r = remap(JSON.parse(this.spaces.write(lib, "agent", (s) => s.applyAgentBatch(agent, `${request}.define`, JSON.stringify({ ops: defines }), now))), defIndex);
      if (!r.ok) throw new ReflexError(r.reason, r.errors);
      if (result) result.repaired = [...(result.repaired ?? []), ...(r.repaired ?? [])];
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
    if (a.topic === "index") return { json: { topic: "index", text: library.index(this.spaces, name, this.#extensions), source: "builtin", pending_sends }, images: [] };
    const found = library.topic(this.spaces, a.topic, name, this.#extensions) ?? (typeGuide(a.topic) ? { text: typeGuide(a.topic)!, source: "builtin" as const } : undefined);
    if (!found) {
      const known = library.topics(this.spaces, this.#extensions);
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

  // ---------- files ----------

  /** The contents of the file Elements among `found`: text inline, and every file's bytes for the surface. */
  #fileContents(found: Record<string, any>[]) {
    const files: Record<string, any>[] = [];
    const bytes: FileOut[] = [];
    for (const e of found.filter((e) => e.type === "file")) {
      const hash = /^asset:([0-9a-f]{64})$/.exec(e.src ?? "")?.[1];
      const data = hash ? this.assets?.get(hash) : undefined;
      const f: Record<string, any> = { id: e.id, name: e.name, mime: e.mime, size: e.size };
      if (!data) f.missing = true;
      else {
        bytes.push({ id: e.id, name: e.name, mime: e.mime, data });
        const text = textOf(e.mime, e.name, data);
        if (text !== undefined) {
          f.text = text.length > 100_000 ? text.slice(0, 100_000) : text;
          if (text.length > 100_000) f.truncated = true;
        }
      }
      files.push(f);
    }
    return { files, bytes };
  }

  #library() {
    return library.entries(this.spaces);
  }

  #byName = (id?: string) => (id ? (this.#names.get(id) ?? id) : undefined);

  #findRecipe(name: string): Recipe | undefined {
    return RECIPES.find((r) => r.name === name) ?? this.#library().map((e) => fromLibrary(e, this.#byName)).find((r) => r?.name === name);
  }

  // ---------- read_me, recipe, exec, request_attention, revert ----------

  async recipe(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    const r = this.#findRecipe(a.name);
    if (!r)
      throw fail("unknown_recipe", `No Recipe '${a.name}'.`, `read_me("index") lists the Recipes: ${[...RECIPES.map((x) => x.name)].join(", ")}.`, [`read_me(topic: "index")`]);
    const checked = checkParams(r, a.params ?? {});
    if (!checked.ok)
      throw new ReflexError(
        "invalid_params",
        checked.errors.map((m) => ({ code: "invalid_params", msg: `${a.name}: ${m}.`.slice(0, 400), fix: `read_me("${a.name}") lists its params.` })),
        [`read_me(topic: "${a.name}")`],
      );
    let ops: Record<string, any>[] = expand(r.template, checked.params);
    if (!Array.isArray(ops) || !ops.length) throw fail("invalid_params", `Recipe '${a.name}' expanded to no ops.`, "Check its params.");
    // A Recipe applied twice in one Space gets fresh IDs, and every reference inside it follows.
    const taken = new Set(this.scene(entry, { agent: ctx.who.agent }, "outline").filter((e: any) => e.by === "you").map((e: any) => e.id));
    const renamed = new Map<string, string>();
    for (const op of ops) {
      if (op.op !== "add" || typeof op.id !== "string" || !taken.has(op.id)) continue;
      let n = 2;
      while (taken.has(`${op.id}-${n}`)) n++;
      renamed.set(op.id, `${op.id}-${n}`);
      taken.add(`${op.id}-${n}`);
    }
    if (renamed.size) ops = renameIds(ops, renamed);
    if (a.at) ops[0] = { ...ops[0], at: a.at };
    const res = await this.apply({ space: a.space, ops, ...(a.in_reply_to ? { in_reply_to: a.in_reply_to } : {}), ...(a.look ? { look: true } : {}), ...(a.request ? { request: a.request } : {}) }, ctx);
    // Report the ops with every ID filled in, so the Agent can patch any part.
    const filled = ops.map((op, i) => (op.op === "add" && res.json.ids?.[`ops[${i}]`] ? { ...op, id: res.json.ids[`ops[${i}]`] } : op));
    const { ok, batch, ids, repaired, lints, look, pending_sends } = res.json;
    return { json: { ok, batch, ops: filled, ...(ids ? { ids } : {}), repaired, lints, ...(look ? { look } : {}), pending_sends }, images: res.images };
  }

  async exec(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    const scene = this.scene(entry, { agent: ctx.who.agent }, "outline");
    const out = await runExec(a.code, scene);
    if ("error" in out)
      throw new ReflexError("exec_failed", [{ code: "exec_failed", msg: `The code failed: ${out.error}`.slice(0, 400), fix: "Fix the code and run it again. Nothing was applied." }], out.logs.length ? out.logs.slice(-3).map((l) => `log: ${l}`.slice(0, 400)) : undefined);
    const logs = out.logs;
    if (!out.ops.length) {
      if (a.in_reply_to) this.inbox.ack(ctx.who.agent, a.in_reply_to);
      return { json: { ok: true, repaired: [], lints: [], result: out.result, logs, pending_sends: this.inbox.pending(ctx.who.agent) }, images: [] };
    }
    const res = await this.apply({ space: a.space, ops: out.ops, ...(a.in_reply_to ? { in_reply_to: a.in_reply_to } : {}), ...(a.look ? { look: true } : {}), ...(a.request ? { request: a.request } : {}) }, ctx);
    return { json: { ...res.json, result: out.result, logs }, images: res.images };
  }

  requestAttention(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    if (a.ids) {
      const have = new Set(this.scene(entry, { agent: ctx.who.agent }, "outline").map((e: any) => e.id));
      const missing = (a.ids as string[]).filter((id) => !have.has(id));
      if (missing.length) throw fail("unknown_id", `No Element '${missing.join("', '")}'.`, `Call read(space: '${a.space}') for the IDs.`);
    }
    const r = JSON.parse(this.spaces.write(entry, "agent", (s) => s.requestAttention(ctx.who.agent, JSON.stringify({ message: a.message, ids: a.ids }), Date.now())));
    if (!r.ok) throw new ReflexError(r.reason, r.errors);
    const status = this.presence().devices > 0 ? "shown" : "queued";
    this.log("attention", { agent: ctx.who.name, space: entry.name, status });
    return { json: { status, pending_sends: this.inbox.pending(ctx.who.agent) }, images: [] };
  }

  revert(a: Record<string, any>, ctx: Ctx) {
    const entry = this.#entry(a.space);
    const selector = { ...(a.batch ? { batch: a.batch } : { last: a.last ?? 1 }), names: this.#names_() };
    const request = `rv_${randomBytes(8).toString("hex")}`;
    const r = JSON.parse(this.spaces.write(entry, "agent", (s) => s.revert(JSON.stringify({ agent: ctx.who.agent }), request, JSON.stringify(selector), Date.now())));
    if (!r.ok) throw new ReflexError(r.reason, r.errors, r.reason === "unknown_batch" ? [`read(space: '${a.space}')`] : undefined);
    this.log("reverted", { agent: ctx.who.name, space: entry.name, reverted: r.reverted, kept: r.kept?.length ?? 0 });
    return { json: { ok: true, batch: r.batch, reverted: r.reverted, ...(r.kept?.length ? { kept: r.kept } : {}), pending_sends: this.inbox.pending(ctx.who.agent) }, images: [] };
  }

  // ---------- Behaviors (the Link runs set and apply_recipe as the Element's owner) ----------

  #ran = new Set<string>();

  /**
   * Runs the set and apply_recipe actions of a Behavior trigger the person fired (a frozen
   * Send with `actions`), as the Agent that owns the Element. Each action has a fixed request ID,
   * so a rerun after a restart is a duplicate the kernel ignores.
   */
  async runBehaviors(space: string, send: string) {
    if (this.#ran.has(send)) return;
    this.#ran.add(send);
    const entry = this.spaces.get(space);
    if (!entry || entry.kind !== "space") return;
    const frozen = JSON.parse(entry.space.send(send)) as (FrozenSend & { actions?: any[]; owner?: { agent?: string } }) | null;
    const agent = frozen?.owner?.agent;
    if (!frozen?.actions?.length || !agent || !frozen.element) return;
    const who: Identity = { agent, name: this.#names.get(agent) ?? agent, color: this.#colors.get(agent) ?? "blue" };
    const element = frozen.element.startsWith(`${agent}/`) ? frozen.element.slice(agent.length + 1) : frozen.element;
    // Each action is one batch with a fixed request ID, so one already in the Space (say, before a restart) is skipped.
    const done = new Set<string>(JSON.parse(entry.space.timeline(JSON.stringify({ limit: 1_000_000 }))).entries.map((e: { id?: string }) => e.id));
    for (const [i, b] of frozen.actions.entries()) {
      const request = `${send}.b${i}`;
      if (done.has(batchId(agent, request))) continue;
      let r: Result | undefined;
      if (b.do === "set") r = await this.call("apply", { space, request, ops: [{ op: "patch", id: b.target ?? element, set: b.set }] }, { who });
      else if (b.do === "apply_recipe") r = await this.call("recipe", { space, request, name: b.recipe, params: b.params ?? {}, at: { near: element } }, { who });
      if (r) this.log("behavior_ran", { send, element, do: b.do, agent: who.name, ok: !r.isError, ...(r.isError ? { reason: r.json.reason, error: r.json.errors?.[0]?.msg } : {}) });
    }
  }

  // ---------- the person's side without an iPad: `reflex dev person`, on a Link started with --dev ----------

  /** What the person said since their last Send, word by word with times, and handwriting hints. */
  #said = new Map<string, { text: string; start_ms: number; end_ms: number }[]>();
  /** When the dev person last finished a stroke, by Space. */
  #inkAt = new Map<string, number>();
  #hints = new Map<string, { strokes: string[]; text: string; confidence: number }[]>();

  #findForPerson(entry: SpaceEntry, id: string): SceneElement {
    const all: SceneElement[] = this.scene(entry, { person: this.person.person }, "full");
    const text = (e: SceneElement) => String(e.text ?? e.title ?? e.latex ?? e.name ?? e.alt ?? "").toLowerCase();
    const el =
      all.find((e) => e.id === id) ??
      all.find((e) => e.id.endsWith(`:${id}`)) ??
      all.find((e) => e.type !== "connector" && e.type !== "ink" && text(e).includes(id.toLowerCase()));
    if (!el) throw fail("unknown_id", `No Element '${id}'.`, `Elements: ${all.map((e) => e.id).join(", ")}`);
    return el;
  }

  #intent(entry: SpaceEntry, intent: Record<string, unknown>) {
    const r = JSON.parse(this.spaces.write(entry, "person", (s) => s.applyUserIntent(this.person.person, "dev-person", JSON.stringify(intent), Date.now())));
    if (!r.ok) throw new ReflexError(r.reason, r.errors);
    return r;
  }

  /** Draws one finished stroke as the person. `points` are [x, y] pairs, drawn at about 8 ms a point, ending now. */
  personStroke(space: string, points: number[][], o: { color?: string; width?: number } = {}) {
    const entry = this.#entry(space);
    const id = `ink-${randomBytes(4).toString("hex")}`;
    // A real Pencil stroke carries time and pressure: [x, y, t, pressure].
    const timed = points.map((p, i) => [p[0], p[1], i * 8, 0.6]);
    this.#intent(entry, { intent: "add_stroke", id, stroke: { points: timed, width: o.width ?? 3 }, color: o.color ?? "red" });
    this.#inkAt.set(entry.name, Date.now());
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

  /** A slightly wobbly line through the middle of an Element. */
  personStrike(space: string, target: string) {
    const el = this.#findForPerson(this.#entry(space), target);
    const [x, y, w, h] = el.bounds;
    const pts: number[][] = [];
    for (let i = 0; i <= 12; i++) pts.push([Math.round(x - 12 + ((w + 24) * i) / 12), Math.round(y + h / 2 + 3 * Math.sin(i))]);
    return this.personStroke(space, pts);
  }

  /** An arrow from one Element to another: a shaft, then a head drawn as a second stroke. */
  personArrow(space: string, from: string, to: string) {
    const entry = this.#entry(space);
    const a = this.#findForPerson(entry, from).bounds;
    const b = this.#findForPerson(entry, to).bounds;
    const c = (r: Bounds) => [r[0] + r[2] / 2, r[1] + r[3] / 2];
    const [ax, ay] = c(a);
    const [bx, by] = c(b);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
    // From just inside A's edge to just outside B's edge.
    const exit = (r: Bounds, dir: number) => {
      const sx = r[2] / 2 / Math.max(1e-6, Math.abs(ux));
      const sy = r[3] / 2 / Math.max(1e-6, Math.abs(uy));
      return Math.min(sx, sy) * dir;
    };
    const s0 = [ax + ux * (exit(a, 1) - 10), ay + uy * (exit(a, 1) - 10)];
    const s1 = [bx - ux * (Math.abs(exit(b, 1)) + 6), by - uy * (Math.abs(exit(b, 1)) + 6)];
    const shaft: number[][] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      shaft.push([Math.round(s0[0] + (s1[0] - s0[0]) * t - uy * 6 * Math.sin(Math.PI * t)), Math.round(s0[1] + (s1[1] - s0[1]) * t + ux * 6 * Math.sin(Math.PI * t))]);
    }
    const shaftId = this.personStroke(space, shaft).id;
    const head = [
      [s1[0] - ux * 22 - uy * 14, s1[1] - uy * 22 + ux * 14],
      [s1[0], s1[1]],
      [s1[0] - ux * 22 + uy * 14, s1[1] - uy * 22 - ux * 14],
    ].map((p) => p.map(Math.round));
    const headId = this.personStroke(space, head).id;
    return { id: shaftId, ids: [shaftId, headId] };
  }

  /** Handwriting next to an Element: a few letter-sized strokes, with the device's recognized text as a hint. */
  personWrite(space: string, target: string, text: string, o: { confidence?: number } = {}) {
    const entry = this.#entry(space);
    const b = this.#findForPerson(entry, target).bounds;
    const x0 = b[0] + b[2] + 24;
    const y0 = b[1] + Math.round(b[3] / 2) - 14;
    const ids: string[] = [];
    const letters = Math.min(10, Math.max(2, Math.ceil(text.length / 2)));
    for (let i = 0; i < letters; i++) {
      const lx = x0 + i * 20;
      const pts: number[][] = [];
      for (let k = 0; k <= 8; k++) pts.push([Math.round(lx + k * 2), Math.round(y0 + 14 + 12 * Math.sin((k / 8) * Math.PI * 2 + i))]);
      ids.push(this.personStroke(space, pts, { width: 2 }).id);
    }
    const list = this.#hints.get(entry.name) ?? [];
    list.push({ strokes: ids, text, confidence: o.confidence ?? 0.82 });
    this.#hints.set(entry.name, list);
    return { id: ids[0], ids };
  }

  /**
   * One line of handwritten working inside a Region, below the lines already there, as the
   * person would write a step of a solution. Digits and letters are small strokes; x and +
   * are two crossing strokes and = two short bars, as a hand draws them. The device's
   * recognized text for the line comes as a hint, as Apple's recognizer gives it line by line.
   */
  personWriteLine(space: string, region: string, text: string, o: { confidence?: number } = {}) {
    const entry = this.#entry(space);
    const all: SceneElement[] = this.scene(entry, { person: this.person.person }, "full");
    const r = this.#findForPerson(entry, region);
    if (r.type !== "region") throw fail("invalid_input", `'${region}' is a ${r.type}, not a Region.`, `Regions: ${all.filter((e) => e.type === "region").map((e) => e.id).join(", ") || "none"}`);
    const [rx, ry, rw, rh] = r.bounds;
    const inside = (b: Bounds) => b[0] + b[2] / 2 >= rx && b[0] + b[2] / 2 <= rx + rw && b[1] + b[3] / 2 >= ry && b[1] + b[3] / 2 <= ry + rh;
    const mine = all.filter((e) => e.type === "ink" && e.owner?.person === this.person.person && inside(e.bounds));
    const top = mine.length ? Math.max(...mine.map((e) => e.bounds[1] + e.bounds[3])) + 34 : ry + 64;
    if (top + 30 > ry + rh) throw fail("too_large", `Region '${region}' is full.`, "Write in a bigger Region, or ask the Agent to resize it.");
    const ids: string[] = [];
    const y = top + 14; // the line's middle
    let x = rx + 40;
    const stroke = (pts: number[][]) => ids.push(this.personStroke(space, pts.map((p) => p.map(Math.round)), { width: 2, color: "black" }).id);
    for (const ch of text) {
      if (ch === " ") {
        x += 14;
        continue;
      }
      if (ch === "x" || ch === "+" || ch === "×") {
        const d = ch === "x" ? 9 : 10;
        if (ch === "+") {
          stroke([[x, y], [x + 2 * d, y]]);
          stroke([[x + d, y - d], [x + d, y + d]]);
        } else {
          stroke([[x, y - d], [x + 2 * d, y + d]]);
          stroke([[x + 2 * d, y - d], [x, y + d]]);
        }
      } else if (ch === "=") {
        stroke([[x, y - 4], [x + 18, y - 4]]);
        stroke([[x, y + 4], [x + 18, y + 4]]);
      } else if (ch === "-" || ch === "−") {
        stroke([[x, y], [x + 16, y]]);
      } else if (GLYPHS[ch]) {
        for (const g of GLYPHS[ch]) stroke(g.map(([gx, gy]) => [x + gx, y - 12 + gy]));
      } else {
        const pts: number[][] = [];
        for (let k = 0; k <= 8; k++) pts.push([x + k * 2, y + 6 * Math.sin((k / 8) * Math.PI * 2 + x)]);
        stroke(pts);
      }
      x += 24;
      if (x > rx + rw - 30) break;
    }
    const list = this.#hints.get(entry.name) ?? [];
    list.push({ strokes: ids, text, confidence: o.confidence ?? 0.86 });
    this.#hints.set(entry.name, list);
    return { id: ids[0], ids };
  }

  /**
   * A watch snapshot of one Region (SPEC §9): all of the person's Ink in it now, claiming
   * nothing, so their turn goes on and the Region's own Send still carries the work. The Link's
   * watcher decides when (debounce and budgets, link/watch.ts). Handwriting hints are the dev
   * person's; an iPad's come with its Sends.
   */
  watchSnapshot(space: string, region: string, o: { stillWriting: boolean }) {
    const entry = this.#entry(space);
    const send = `s_${randomBytes(5).toString("hex")}`;
    const hints = this.#hints.get(entry.name) ?? [];
    const raw = { send, trigger: "watch", region, user_still_writing: o.stillWriting, viewport: entry.viewport, ...(hints.length ? { hints } : {}) };
    const frozen = JSON.parse(this.spaces.write(entry, "send", (s) => s.freezeSend(this.person.person, "link-watch", JSON.stringify(raw), Date.now())));
    if (frozen.ok === false) throw new ReflexError(frozen.reason, frozen.errors);
    return frozen as FrozenSend;
  }

  /** The person speaks while holding the mic: words are timed as they are said, so Marks drawn between land between them. */
  personSay(space: string, text: string) {
    const entry = this.#entry(space);
    const list = this.#said.get(entry.name) ?? [];
    // The words were just spoken: they end now, so what is drawn next comes after them.
    const words = text.split(/\s+/).filter(Boolean);
    const now = Date.now();
    const from = Math.max(now - words.length * 260, (this.#inkAt.get(entry.name) ?? 0) + 1, (list.at(-1)?.end_ms ?? 0) + 1);
    const step = Math.max(1, (now - from) / Math.max(1, words.length));
    words.forEach((w, i) => list.push({ text: w, start_ms: Math.round(from + i * step), end_ms: Math.round(from + (i + 1) * step) }));
    this.#said.set(entry.name, list);
    return { words: list.length };
  }

  /** Moves an Element as the person would by dragging it. */
  personMove(space: string, target: string, by: [number, number]) {
    const entry = this.#entry(space);
    const el = this.#findForPerson(entry, target);
    this.#intent(entry, { intent: "move", ids: [el.id], by });
    return { id: el.id };
  }

  /** Adds a file from this computer as the person would from Photos or Files: a PNG or JPEG becomes an image, anything else a file. */
  personAddFile(space: string, file: { name: string; bytes: Buffer; mime?: string }, o: { near?: string } = {}) {
    const entry = this.#entry(space);
    if (!this.assets?.put) throw fail("unavailable", "This Link can't store files.", "Run it with its asset store.");
    const mime = file.mime ?? mimeOf(file.name);
    const hash = this.assets.put(file.bytes);
    const id = `f-${randomBytes(4).toString("hex")}`;
    let at: Record<string, unknown> = { x: 0, y: 0 };
    if (o.near) {
      const b = this.#findForPerson(entry, o.near).bounds;
      at = { x: b[0], y: b[1] + b[3] + 60 };
    } else {
      const v = entry.viewport;
      at = { x: v[0] + 40, y: v[1] + 40 };
    }
    const size = mime.startsWith("image/") ? (imageSize(file.bytes) ?? [480, 360]) : [220, 80];
    const scale = Math.min(1, 480 / size[0]);
    this.#intent(entry, {
      intent: "add_file",
      id,
      name: file.name,
      mime,
      size: file.bytes.length,
      src: `asset:${hash}`,
      at,
      w: Math.round(size[0] * scale),
      h: Math.round(size[1] * scale),
    });
    return { id, mime };
  }

  /** Fires a Behavior trigger on an Element, as a tap or long-press on the iPad would. */
  personFire(space: string, target: string, on = "tap", o: { values?: Record<string, unknown> } = {}) {
    const entry = this.#entry(space);
    const el = this.#findForPerson(entry, target);
    const send = `s_${randomBytes(5).toString("hex")}`;
    const raw = { send, trigger: "behavior", element: el.id, on, ...(o.values ? { values: o.values } : {}) };
    const frozen = JSON.parse(this.spaces.write(entry, "send", (s) => s.freezeSend(this.person.person, "dev-person", JSON.stringify(raw), Date.now())));
    if (frozen.ok === false) throw new ReflexError(frozen.reason, frozen.errors);
    const recipients = this.inbox.recipients(send);
    this.log("behavior_fired", { send, element: el.id, on, kind: frozen.kind, actions: (frozen.actions ?? []).map((b: any) => b.do) });
    return { send, kind: frozen.kind, actions: (frozen.actions ?? []).map((b: any) => b.do), recipients: recipients.map((r) => this.#names.get(r) ?? r) };
  }

  /** The person taps an Agent's color chip: reverts that Agent's last batch in this Space. */
  personRevert(space: string, agentName: string) {
    const entry = this.#entry(space);
    const agent = [...this.#names].find(([id, n]) => id === agentName || n === agentName || n.toLowerCase().includes(agentName.toLowerCase()))?.[0];
    if (!agent) throw fail("unknown_id", `No Agent '${agentName}'.`, `Agents: ${[...entry.agents].map((a) => this.#names.get(a) ?? a).join(", ")}`);
    const r = JSON.parse(
      this.spaces.write(entry, "person", (s) =>
        s.revert(JSON.stringify({ person: this.person.person, device: "dev-person" }), `chip-${Date.now()}`, JSON.stringify({ agent, last: 1, names: this.#names_() }), Date.now()),
      ),
    );
    if (!r.ok) throw new ReflexError(r.reason, r.errors);
    return { reverted: r.reverted, kept: r.kept ?? [], agent: this.#names.get(agent) ?? agent };
  }

  /** The history timeline the iPad shows for a Space. */
  timeline(space: string) {
    const entry = this.#entry(space);
    return JSON.parse(entry.space.timeline(JSON.stringify({ viewer: { person: this.person.person }, names: this.#names_(), limit: 50 })));
  }

  /** Presses Send: freezes the person's strokes and changes and delivers the Send. */
  personSend(space: string, o: { said?: string; trigger?: string; region?: string; embedAnchors?: Record<string, unknown>[] } = {}) {
    const entry = this.#entry(space);
    // A Region's own Send button: only what is inside that Region.
    const region = o.region ? this.#findForPerson(entry, o.region) : undefined;
    if (region && region.type !== "region") throw fail("invalid_input", `'${o.region}' is a ${region.type}, not a Region.`, "Pass the Region whose Send button the person pressed.");
    const send = `s_${randomBytes(5).toString("hex")}`;
    const words = this.#said.get(entry.name) ?? [];
    const hints = this.#hints.get(entry.name) ?? [];
    const said = o.said ?? (words.length ? words.map((w) => w.text).join(" ") : undefined);
    const raw = {
      send,
      trigger: region ? "region" : (o.trigger ?? (said ? "voice" : "button")),
      ...(region ? { region: region.id } : {}),
      viewport: entry.viewport,
      ...(said ? { said } : {}),
      ...(words.length ? { words } : {}),
      ...(hints.length ? { hints } : {}),
      // What Embeds answered about the Marks on them (`reflex dev` asks them in the browser).
      ...(o.embedAnchors?.length ? { embed_anchors: o.embedAnchors } : {}),
    };
    // Freezing it makes it durable and puts it in the Inbox of every Agent on this Space.
    const frozen = JSON.parse(this.spaces.write(entry, "send", (s) => s.freezeSend(this.person.person, "dev-person", JSON.stringify(raw), Date.now()))) as FrozenSend;
    if ((frozen as any).ok === false) throw new ReflexError((frozen as any).reason, (frozen as any).errors);
    this.#said.delete(entry.name);
    this.#hints.delete(entry.name);
    const recipients = this.inbox.recipients(send);
    this.log("send_frozen", { send, space, recipients: recipients.map((r) => this.#names.get(r) ?? r), strokes: frozen.strokes.length });
    return { send, recipients: recipients.map((r) => this.#names.get(r) ?? r) };
  }
}

/** Single-stroke shapes for the dev person's handwriting, in a 12×24 box (y down). */
const GLYPHS: Record<string, number[][][]> = {
  "0": [[[6, 0], [1, 4], [0, 12], [1, 20], [6, 24], [11, 20], [12, 12], [11, 4], [6, 0]]],
  "1": [[[3, 4], [7, 0], [7, 24]]],
  "2": [[[0, 5], [4, 0], [9, 0], [12, 5], [10, 11], [0, 24], [12, 24]]],
  "3": [[[0, 2], [10, 1], [5, 10], [11, 15], [9, 23], [0, 22]]],
  "4": [[[9, 24], [9, 0], [0, 16], [12, 16]]],
  "5": [[[12, 0], [2, 0], [1, 10], [8, 9], [12, 16], [8, 24], [0, 22]]],
  "6": [[[11, 1], [4, 5], [0, 15], [2, 23], [9, 23], [12, 17], [8, 12], [1, 15]]],
  "7": [[[0, 0], [12, 0], [4, 24]]],
  "8": [[[6, 12], [1, 6], [6, 0], [11, 6], [6, 12], [0, 18], [6, 24], [12, 18], [6, 12]]],
  "9": [[[11, 7], [6, 12], [1, 7], [6, 0], [11, 5], [11, 14], [8, 24]]],
  "(": [[[8, -2], [3, 6], [2, 14], [4, 22], [8, 28]]],
  ")": [[[4, -2], [9, 6], [10, 14], [8, 22], [4, 28]]],
  "/": [[[11, -2], [1, 26]]],
  y: [[[0, 8], [6, 18]], [[12, 8], [3, 32]]],
};

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript|x-sh|toml|sql|csv|x-ndjson))/;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|sql|log|ini|cfg|env)$/i;

/** A file's text, when it is a text file. */
function textOf(mime: string, name: string, data: Buffer): string | undefined {
  if (!TEXT_MIME.test(mime ?? "") && !TEXT_EXT.test(name ?? "")) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const bad = (text.match(/�/g) ?? []).length;
  return bad > Math.max(4, text.length / 100) ? undefined : text;
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
    pdf: "application/pdf", csv: "text/csv", txt: "text/plain", md: "text/markdown", json: "application/json",
  };
  return known[ext] ?? (TEXT_EXT.test(name) ? "text/plain" : "application/octet-stream");
}

/** Width and height of a PNG or JPEG, from its header. */
function imageSize(b: Buffer): [number, number] | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  return undefined;
}

const REF_KEYS = new Set(["id", "from", "to", "right_of", "left_of", "above", "below", "near", "inside", "target"]);
/** Renames IDs everywhere an op refers to them. */
function renameIds(v: any, map: Map<string, string>, key?: string): any {
  if (typeof v === "string") return key && REF_KEYS.has(key) && map.has(v) ? map.get(v) : v;
  if (Array.isArray(v)) return v.map((x) => renameIds(x, map, key === "ids" ? "id" : key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renameIds(x, map, k)]));
  return v;
}

/** The batch ID the kernel gives an Agent's request (kernel/core/src/lib.rs, apply_agent_batch). */
function batchId(agent: string, request: string): string {
  const h = createHash("sha256");
  for (const part of [agent, request]) {
    const bytes = Buffer.from(part);
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(bytes.length));
    h.update(len).update(bytes);
  }
  return `b_${h.digest("hex").slice(0, 12)}`;
}
