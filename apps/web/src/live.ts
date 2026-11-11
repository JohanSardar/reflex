// One Space drawn live: whenever its replica (or the Library's, for Embed
// Templates) changes, the scene is read from the kernel and redrawn.
import type { Connection } from "./conn.ts";
import { Embeds, type Template } from "./embed.ts";
import { SceneView, extent, type El } from "./render.ts";

export class LiveSpace {
  readonly view: SceneView;
  readonly embeds = new Embeds();
  readonly conn: Connection;
  space = "";
  #frame = 0;
  #fitted = false;
  #library = "";
  #listeners: ((elements: El[]) => void)[] = [];

  constructor(conn: Connection, root: HTMLElement) {
    this.conn = conn;
    this.view = new SceneView(root, {
      embed: (e) => this.embeds.frame(e),
      asset: async (hash) => {
        const r = await conn.api(`/api/asset/${hash}`);
        return r.ok ? URL.createObjectURL(await r.blob()) : undefined;
      },
    });
    conn.on(({ space, event }) => {
      if (event.t === "hello" || (space && (space === this.space || conn.replicas.get(space)?.kind === "library"))) this.schedule();
    });
  }

  onDraw(fn: (elements: El[]) => void) {
    this.#listeners.push(fn);
  }

  show(space: string) {
    if (space === this.space) return;
    this.space = space;
    this.#fitted = false;
    this.schedule();
  }

  schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.draw();
    });
  }

  /** The scene as the person sees it: full detail, every owner named. */
  scene(): { elements: El[]; strokes: Record<string, number[][]> } {
    const r = this.conn.replicas.get(this.space);
    if (!r) return { elements: [], strokes: {} };
    const viewer = { person: this.conn.person.id };
    const q = (detail: string, ids?: string[]) => JSON.parse(r.space.scene(JSON.stringify({ detail, viewer, names: this.conn.names, ...(ids ? { ids } : {}) })));
    const elements: El[] = q("full").elements ?? [];
    const ink = elements.filter((e) => e.type === "ink").map((e) => e.id);
    const strokes = ink.length ? Object.fromEntries((q("strokes", ink).elements ?? []).map((s: { id: string; points: number[][] }) => [s.id, s.points])) : {};
    return { elements, strokes };
  }

  draw() {
    // Embed Templates come from the person's Library, which every viewer holds a replica of.
    for (const r of this.conn.replicas.values()) {
      if (r.kind !== "library") continue;
      const lib: Template[] = JSON.parse(r.space.scene(JSON.stringify({ detail: "full", ids: [] }))).library ?? [];
      for (const t of lib) if (t.kind === "embed") this.embeds.templates.set(t.name, t);
    }
    // A template that arrived or changed: rebuild the Embeds that use it.
    const sig = JSON.stringify([...this.embeds.templates.values()]);
    if (sig !== this.#library) {
      this.#library = sig;
      this.view.invalidate((e) => e.type === "embed");
    }
    const { elements, strokes } = this.scene();
    this.view.update(elements, strokes);
    if (!this.#fitted && elements.length) {
      this.#fitted = true;
      this.view.fit(extent(elements)!);
    } else this.view.apply();
    for (const l of this.#listeners) l(elements);
  }
}
