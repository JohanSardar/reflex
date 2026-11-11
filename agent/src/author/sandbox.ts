// A throwaway Reflex for one extension: the real capability table on an
// in-memory Space called "dev", with a stand-in Agent and the person played
// by the author's mouse. `reflex dev` shows it in the browser; `reflex test`
// replays saved examples on it.
import { Core, type Ctx } from "../capabilities/index.ts";
import { SvgRenderer } from "../render.ts";
import { checkEmbed, checkGuide, checkRecipe, exampleParams, instantiate, type Problem } from "../extensions/checks.ts";
import { checkAdapter, deliverDry, type Delivered } from "../extensions/adapter.ts";
import type { Loaded } from "../extensions/files.ts";
import { MemoryInbox, MemorySpaces } from "./memory.ts";

export const SPACE = "dev";
const AGENT: Ctx["who"] = { agent: "a_dev", name: "Dev Agent", color: "violet" };
const PERSON = { person: "p_dev", name: "You" };

export type SendResult = {
  bundle: Record<string, any>;
  images: string[];
  /** What each Embed answered about the Marks on it. */
  anchors: { mark?: string; element: string; anchor: unknown }[];
  adapter?: Delivered;
};

export class Sandbox {
  readonly inbox = new MemoryInbox();
  readonly spaces = new MemorySpaces(this.inbox);
  readonly core: Core;
  readonly ctx: Ctx = { who: AGENT };
  readonly loaded?: Loaded;
  checks: Problem[] = [];
  /** What the Agent reads: each call the stand-in Agent made and what came back. */
  reads: { call: string; args: unknown; result: unknown }[] = [];
  lints: unknown[] = [];
  params: Record<string, unknown> = {};
  /** Strokes drawn since the last Send, as [x, y] points. */
  strokes: number[][][] = [];
  last?: SendResult & { strokes: number[][][]; said?: string };

  constructor(loaded?: Loaded) {
    this.loaded = loaded;
    this.core = new Core({ spaces: this.spaces, inbox: this.inbox, renderer: new SvgRenderer(), person: PERSON, progressEvery: 1 });
  }

  async #call(tool: string, args: Record<string, unknown>) {
    const r = await this.core.call(tool, args, this.ctx);
    this.reads.push({ call: tool, args, result: r.json });
    return r;
  }

  /** Runs the extension's checks and puts it on the dev Space the way an Agent would. */
  async start(): Promise<this> {
    await this.#call("open_space", { space: SPACE, create: true });
    const l = this.loaded;
    if (!l) return this;
    const ext = l.ext;
    if (ext.kind === "guide") this.checks = checkGuide(ext);
    if (ext.kind === "adapter") this.checks = await checkAdapter(ext);
    if (ext.kind === "recipe") {
      this.checks = checkRecipe(ext);
      this.params = ext.example ?? exampleParams(ext.params as Record<string, any>);
      const ops = instantiate(ext.template, this.params);
      const r = await this.#call("apply", { space: SPACE, ops });
      this.lints = r.json.lints ?? r.json.errors ?? [];
    }
    if (ext.kind === "embed") {
      this.checks = checkEmbed(ext);
      this.params = ext.example ?? exampleParams(ext.params as Record<string, any>);
      const define = { op: "define", kind: "embed", name: ext.name, summary: ext.summary, params: ext.params, template: ext.template, ...(ext.guide ? { guide: ext.guide } : {}), ...(ext.allow ? { allow: ext.allow } : {}) };
      let r = await this.#call("apply", { space: SPACE, ops: [define, { op: "add", type: "embed", id: "embed-1", template: ext.name, params: this.params, at: { x: 0, y: 0 } }] });
      // While it doesn't pass its checks it can't be saved, but the author still sees it running.
      if (r.isError) r = await this.#call("apply", { space: SPACE, ops: [{ op: "add", type: "embed", id: "embed-1", html: ext.template, params: this.params, ...(ext.allow ? { allow: ext.allow } : {}), at: { x: 0, y: 0 } }] });
      this.lints = r.json.lints ?? r.json.errors ?? [];
    }
    // What an Agent would read to learn the extension.
    if (ext.kind !== "adapter") await this.#call("read_me", { topic: "index" });
    if (ext.kind === "embed" || ext.kind === "guide") await this.#call("read_me", { topic: ext.name }).catch(() => undefined);
    await this.#call("read", { space: SPACE });
    return this;
  }

  stroke(points: number[][]) {
    const r = this.core.personStroke(SPACE, points);
    this.strokes.push(points);
    return r;
  }

  /** Presses Send as the person, then reads it as the Agent would. */
  async send(o: { said?: string; anchors?: { element: string; strokes: number; anchor: unknown; bounds: [number, number, number, number] }[] } = {}): Promise<SendResult> {
    const anchors = (o.anchors ?? []).filter((a) => a.anchor);
    this.core.personSend(SPACE, { said: o.said, embedAnchors: anchors.map((a) => ({ element: a.element, anchor: a.anchor, bounds: a.bounds })) });
    const r = await this.core.call("wait_for_user", { timeout_s: 0, space: SPACE, ...(this.last ? { after: this.last.bundle.send } : {}) }, this.ctx);
    const bundle = r.json;
    const overlap = (a: number[], b: number[]) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    const result: SendResult = {
      bundle,
      images: r.images.map((b) => b.toString("base64")),
      anchors: anchors.map((a) => ({ mark: (bundle.marks ?? []).find((m: any) => m.bounds && overlap(m.bounds, a.bounds))?.id, element: a.element, anchor: a.anchor })),
    };
    if (this.loaded?.ext.kind === "adapter" && bundle.kind) result.adapter = await deliverDry(this.loaded.ext, bundle);
    this.last = { ...result, strokes: this.strokes, said: o.said };
    this.strokes = [];
    return result;
  }

  /** The last Send as a conformance example: its strokes, and the Marks and Anchors they must produce. */
  example(): Record<string, unknown> | undefined {
    const l = this.last;
    if (!l || !this.loaded) return undefined;
    return {
      extension: this.loaded.ext.name,
      kind: this.loaded.ext.kind,
      params: this.params,
      strokes: l.strokes,
      ...(l.said ? { said: l.said } : {}),
      expect: {
        marks: (l.bundle.marks ?? []).map((m: any) => Object.fromEntries(Object.entries(m).filter(([k]) => ["id", "kind", "on", "near", "from", "to", "text_guess"].includes(k)))),
        ...(l.anchors.length ? { anchors: l.anchors } : {}),
      },
    };
  }
}
