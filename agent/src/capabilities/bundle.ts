// Send Bundle projection (ARCHITECTURE §4.3): what one frozen Send reads like
// to one Agent. Mark grouping here is a basic stand-in (strokes that touch are
// one Mark; circles, underlines and strikes are told apart by shape, and a
// circle is on what its path encloses). The real Mark grouping and Anchor
// resolution are T8 (H18).
//
// Images are what the device rendered when the person pressed Send (the
// Send's `crops`), so the Agent sees what the person saw. Where no crop covers
// a Mark, Reflex renders one.
import { readFileSync } from "node:fs";
import type { Renderer, SceneElement } from "../render.ts";
import type { Bounds, FrozenSend, SpaceEntry } from "../store.ts";

const sendSchema = JSON.parse(readFileSync(new URL("../../../protocol/schema/send-bundle.schema.json", import.meta.url), "utf8"));
const CHANGE_FIELDS = new Set(Object.keys(sendSchema.$defs.change.properties));

export type MarkRef = { id: string; strokes: string[]; bounds: Bounds };
export type Image = { n: number; shows: string; bounds: Bounds; png: Buffer; asset?: string };

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
/** Whether a point is inside the polygon a stroke's points trace (even-odd rule). */
const inside = (pts: number[][], x: number, y: number) => {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
/** A path that comes back near where it started, or crosses close to its start later on. */
const closes = (pts: number[][], size: number) => {
  if (pts.length < 8) return false;
  const [x0, y0] = pts[0];
  const near = 0.3 * size;
  return pts.slice(Math.floor(pts.length / 2)).some(([x, y]) => Math.hypot(x - x0, y - y0) < near);
};
const contains = (outer: Bounds, b: Bounds) => b[0] >= outer[0] && b[1] >= outer[1] && b[0] + b[2] <= outer[0] + outer[2] && b[1] + b[3] <= outer[1] + outer[3];
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
  /** The bytes of an asset the device stored, if this Link has it. */
  asset: (hash: string) => Buffer | undefined;
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
    const closed = g.ids.length === 1 && closes(pts, Math.max(w, h));
    const enclosed = targets.filter(
      (t) => t.type !== "connector" && inside(pts, t.bounds[0] + t.bounds[2] / 2, t.bounds[1] + t.bounds[3] / 2) && t.bounds[2] <= w * 1.2 && t.bounds[3] <= h * 1.2,
    );
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
      const want = union([g.bounds, ...shown.map((s) => s.bounds)]);
      const shows = `${id}${shown.length ? ` and ${shown.map((s) => s.id).join(", ")}` : ""}`;
      // The device's own crop when one covers this Mark and its target; one image can show several Marks.
      const device = (frozen.crops ?? []).find((c) => contains(c.bounds, want));
      const same = device && images.find((i) => i.asset === device.asset);
      const png = device && !same ? opts.asset(device.asset) : undefined;
      if (same) {
        same.shows = `${same.shows}; ${shows}`;
        mark.image = same.n;
      } else {
        const n = images.length + 1;
        if (device && png) images.push({ n, shows, bounds: device.bounds, png, asset: device.asset });
        else {
          const crop = pad(want, 40);
          images.push({ n, shows, bounds: crop, png: opts.renderer.render({ elements, strokes, bounds: crop, width: 768 }).png });
        }
        mark.image = n;
      }
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
        ? `Reply with apply(in_reply_to: '${s}')${refs.length ? `; what you add without at goes next to ${refs[0].id}` : ""}, then wait_for_user(after: '${s}').`
        : `${opts.personName}'s turn is not over. Answer if useful, then wait_for_user(after: '${s}').`,
  };
  return { bundle, images, marks: refs };
}
