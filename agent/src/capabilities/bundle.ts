// Send Bundle projection (ARCHITECTURE §4.3): what one frozen Send reads like
// to one Agent. Mark grouping here is a basic stand-in (strokes that touch are
// one Mark; circles, underlines and strikes are told apart by shape). The real
// Mark grouping and Anchor resolution are T8 (H18).
import { readFileSync } from "node:fs";
import type { Renderer, SceneElement } from "../render.ts";
import type { Bounds, FrozenSend, SpaceEntry } from "../store.ts";

const sendSchema = JSON.parse(readFileSync(new URL("../../../protocol/schema/send-bundle.schema.json", import.meta.url), "utf8"));
const CHANGE_FIELDS = new Set(Object.keys(sendSchema.$defs.change.properties));

export type MarkRef = { id: string; strokes: string[]; bounds: Bounds };
export type Image = { n: number; shows: string; bounds: Bounds; png: Buffer };

const union = (bs: Bounds[]): Bounds => {
  const x0 = Math.min(...bs.map((b) => b[0]));
  const y0 = Math.min(...bs.map((b) => b[1]));
  const x1 = Math.max(...bs.map((b) => b[0] + b[2]));
  const y1 = Math.max(...bs.map((b) => b[1] + b[3]));
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
};
const pad = (b: Bounds, p: number): Bounds => [b[0] - p, b[1] - p, b[2] + 2 * p, b[3] + 2 * p];
const overlaps = (a: Bounds, b: Bounds) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const centerIn = (outer: Bounds, b: Bounds) => {
  const cx = b[0] + b[2] / 2;
  const cy = b[1] + b[3] / 2;
  return cx >= outer[0] && cx <= outer[0] + outer[2] && cy >= outer[1] && cy <= outer[1] + outer[3];
};
const dist2 = (a: Bounds, b: Bounds) => (a[0] + a[2] / 2 - b[0] - b[2] / 2) ** 2 + (a[1] + a[3] / 2 - b[1] - b[3] / 2) ** 2;

export type Projection = {
  bundle: Record<string, any>;
  images: Image[];
  marks: MarkRef[];
};

export function project(opts: {
  frozen: FrozenSend;
  entry: SpaceEntry;
  /** The full scene for the reading Agent (its own IDs, its coordinates). */
  elements: SceneElement[];
  /** The outline scene for the reading Agent. */
  outline: Record<string, any>[];
  strokes: Record<string, number[][]>;
  personName: string;
  alsoSentTo: string[];
  redelivered: boolean;
  pendingAfter: number;
  renderer: Renderer;
  displayId: (key: string) => string;
}): Projection {
  const { frozen, elements, outline, strokes } = opts;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const targets = elements.filter((e) => e.type !== "ink");

  // Group the Send's strokes: strokes whose boxes touch are one Mark.
  const strokeIds = frozen.strokes.map(opts.displayId).filter((id) => byId.has(id));
  const groups: { ids: string[]; bounds: Bounds }[] = [];
  for (const id of strokeIds) {
    const b = byId.get(id)!.bounds;
    const g = groups.find((g) => overlaps(pad(g.bounds, 30), b));
    if (g) {
      g.ids.push(id);
      g.bounds = union([g.bounds, b]);
    } else groups.push({ ids: [id], bounds: b });
  }

  const marks: Record<string, any>[] = [];
  const refs: MarkRef[] = [];
  const images: Image[] = [];
  groups.forEach((g, i) => {
    const id = `m${i + 1}`;
    const [, , w, h] = g.bounds;
    const pts = g.ids.flatMap((s) => strokes[s] ?? []);
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed = g.ids.length === 1 && first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.3 * Math.max(w, h);
    const enclosed = targets.filter((t) => centerIn(g.bounds, t.bounds) && t.bounds[2] <= w * 1.2 && t.bounds[3] <= h * 1.2);
    const flat = h < Math.max(30, 0.25 * w);
    const above = targets.find((t) => flat && overlaps([g.bounds[0], g.bounds[1] - 40, w, 40], t.bounds) && g.bounds[1] >= t.bounds[1] + t.bounds[3] * 0.75);
    const through = targets.find((t) => flat && overlaps(g.bounds, t.bounds) && centerIn(t.bounds, g.bounds));
    let mark: Record<string, any>;
    let shown: SceneElement[] = [];
    if (closed && enclosed.length) {
      mark = { id, kind: "circle", on: enclosed.map((t) => t.id) };
      shown = enclosed;
    } else if (through) {
      mark = { id, kind: "strike", on: [through.id] };
      shown = [through];
    } else if (above) {
      mark = { id, kind: "underline", on: [above.id] };
      shown = [above];
    } else {
      const near = [...targets].sort((a, b) => dist2(a.bounds, g.bounds) - dist2(b.bounds, g.bounds))[0];
      mark = { id, kind: "ink", ...(near ? { near: near.id } : {}) };
      if (near && dist2(near.bounds, g.bounds) < 400 ** 2) shown = [near];
    }
    mark.bounds = g.bounds;
    if (images.length < 4) {
      const n = images.length + 1;
      const crop = pad(union([g.bounds, ...shown.map((s) => s.bounds)]), 40);
      const { png } = opts.renderer.render({ elements, strokes, bounds: crop, width: 768 });
      images.push({ n, shows: `${id}${shown.length ? ` and ${shown.map((s) => s.id).join(", ")}` : ""}`, bounds: crop, png });
      mark.image = n;
    }
    if (mark.kind === "ink") mark.note = `Not recognized.${mark.image ? ` See image ${mark.image}.` : ""}`;
    marks.push(mark);
    refs.push({ id, strokes: g.ids, bounds: g.bounds });
  });

  const changes = (frozen.changes ?? [])
    .map((c) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(c)) if (CHANGE_FIELDS.has(k) && v !== null && v !== undefined) out[k] = k === "id" ? opts.displayId(String(v)) : v;
      if (typeof out.was === "string" && out.was.length > 400) out.was = out.was.slice(0, 399) + "…";
      return out;
    })
    .filter((c) => c.kind && c.id);

  // The nearby scene: what is near the Marks, or on screen when there are none.
  const viewport = frozen.viewport ?? opts.entry.viewport;
  const focus = refs.length ? refs.map((r) => pad(r.bounds, 300)) : [viewport];
  const near = outline.filter((e) => e.type !== "ink" && focus.some((f) => overlaps(f, e.bounds))).slice(0, 200);
  const nearIds = new Set(near.map((e) => e.id));
  const rest = outline.filter((e) => !nearIds.has(e.id));
  const onScreen = rest.filter((e) => overlaps(viewport, e.bounds)).length;

  const kind = frozen.kind ?? "send";
  const s = frozen.send;
  const bundle: Record<string, any> = {
    kind,
    send: s,
    space: frozen.space,
    from: { person: frozen.from.person, name: opts.personName },
    trigger: frozen.trigger,
    ...(frozen.said ? { said: frozen.said } : {}),
    marks,
    changes,
    scene: near,
    elsewhere: { on_screen: onScreen, off_screen: rest.length - onScreen },
    ...(frozen.viewport ? { viewport: frozen.viewport } : {}),
    ...(frozen.selection?.length ? { selection: frozen.selection.map(opts.displayId) } : {}),
    ...(frozen.region ? { region: frozen.region } : {}),
    ...(frozen.element ? { element: frozen.element } : {}),
    ...(frozen.payload ? { payload: frozen.payload } : {}),
    images: images.map(({ n, shows, bounds }) => ({ n, shows, bounds })),
    also_sent_to: opts.alsoSentTo,
    redelivered: opts.redelivered,
    pending_after: opts.pendingAfter,
    next:
      kind === "send"
        ? `Reply with apply(in_reply_to: '${s}'), then wait_for_user(after: '${s}').`
        : `${opts.personName}'s turn is not over. Answer if useful, then wait_for_user(after: '${s}').`,
  };
  return { bundle, images, marks: refs };
}
