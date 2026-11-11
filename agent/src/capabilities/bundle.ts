// Send Bundle projection (ARCHITECTURE §4.3): what one frozen Send reads like
// to one Agent. The kernel groups the Send's strokes into Marks and resolves
// their Anchors at the Send's frontier (`Space.marks`); this module turns
// them into review comments: the transcript with each Mark's ID placed where
// it was drawn, a crop per Mark, the person's changes (with an image for
// each photo or PDF page they added), and the nearby scene.
//
// Images are what the device rendered when the person pressed Send (the
// Send's `crops`), so the Agent sees what the person saw. Where no crop covers
// a Mark, Reflex renders one.
import { readFileSync } from "node:fs";
import type { Renderer, SceneElement } from "../render.ts";
import type { Bounds, FrozenSend, SpaceEntry } from "../store.ts";

const sendSchema = JSON.parse(readFileSync(new URL("../../../protocol/schema/send-bundle.schema.json", import.meta.url), "utf8"));
const CHANGE_FIELDS = new Set(Object.keys(sendSchema.$defs.change.properties));
const MARK_FIELDS = new Set(Object.keys(sendSchema.$defs.mark.properties));
/** Images per Bundle by default (ARCHITECTURE §4.3). */
const MAX_IMAGES = 4;

export type MarkRef = { id: string; strokes: string[]; bounds: Bounds };
export type Image = { n: number; shows: string; bounds: Bounds; png: Buffer; asset?: string };
/** A Mark as the kernel returns it: the Bundle's fields plus its strokes and when they were drawn. */
export type KernelMark = Record<string, any> & { id: string; kind: string; strokes: string[]; bounds: Bounds; at: number; end: number };

const union = (bs: Bounds[]): Bounds => {
  const x0 = Math.min(...bs.map((b) => b[0]));
  const y0 = Math.min(...bs.map((b) => b[1]));
  const x1 = Math.max(...bs.map((b) => b[0] + b[2]));
  const y1 = Math.max(...bs.map((b) => b[1] + b[3]));
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
};
const pad = (b: Bounds, p: number): Bounds => [b[0] - p, b[1] - p, b[2] + 2 * p, b[3] + 2 * p];
const overlaps = (a: Bounds, b: Bounds) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const contains = (outer: Bounds, b: Bounds) => b[0] >= outer[0] && b[1] >= outer[1] && b[0] + b[2] <= outer[0] + outer[2] && b[1] + b[3] <= outer[1] + outer[3];

/**
 * The transcript with Mark IDs placed where each Mark was drawn: after the last word that began
 * before the Mark did. Marks drawn before the person spoke come first; after, last.
 */
export function interleave(words: { text: string; start_ms: number }[], marks: { id: string; at: number }[]): string {
  const timed = marks.filter((m) => m.at > 0).sort((a, b) => a.at - b.at);
  const ws = [...words].sort((a, b) => a.start_ms - b.start_ms);
  const out: string[] = [];
  let k = 0;
  for (const w of ws) {
    while (k < timed.length && timed[k].at < w.start_ms) out.push(`[${timed[k++].id}]`);
    out.push(w.text);
  }
  while (k < timed.length) out.push(`[${timed[k++].id}]`);
  return out.join(" ");
}

export type Projection = {
  bundle: Record<string, any>;
  images: Image[];
  marks: MarkRef[];
};

export function project(opts: {
  frozen: FrozenSend;
  entry: SpaceEntry;
  /** Fields the person's Behaviors (a tap, say) set since their last Send, by kernel key. */
  behaviors?: { key: string; on?: string; set: Record<string, unknown> }[];
  /** The full scene for the reading Agent (its own IDs, its coordinates). */
  elements: SceneElement[];
  /** The outline scene for the reading Agent. */
  outline: Record<string, any>[];
  strokes: Record<string, number[][]>;
  /** The Send's Marks from the kernel, in the reading Agent's IDs. */
  marks: KernelMark[];
  personName: string;
  alsoSentTo: string[];
  redelivered: boolean;
  /** Pushed by a Send Adapter while the Agent wasn't waiting: it acknowledges, then ends its turn. */
  pushed?: boolean;
  pendingAfter: number;
  renderer: Renderer;
  /** The bytes of an asset the device stored, if this Link has it. */
  asset: (hash: string) => Buffer | undefined;
  displayId: (key: string) => string;
}): Projection {
  const { frozen, elements, outline, strokes } = opts;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const images: Image[] = [];
  const render = (b: Bounds) => opts.renderer.render({ elements, strokes, bounds: b, width: 768, asset: opts.asset }).png;

  const marks: Record<string, any>[] = [];
  const refs: MarkRef[] = [];
  // A Send from a Region (its button, or watch) is about that Region's work: its first image
  // is the whole Region, so every line and the Agent's earlier notes beside them show at once.
  const region = frozen.region && (frozen.trigger === "region" || frozen.kind === "watch") ? byId.get(opts.displayId(frozen.region)) : undefined;
  if (region) {
    const device = (frozen.crops ?? []).find((c) => contains(c.bounds, region.bounds));
    const png = device ? opts.asset(device.asset) : undefined;
    const crop = pad(region.bounds, 20);
    images.push(device && png ? { n: 1, shows: `Region ${region.id}`, bounds: device.bounds, png, asset: device.asset } : { n: 1, shows: `Region ${region.id}`, bounds: crop, png: render(crop) });
  }
  for (const km of opts.marks) {
    const mark: Record<string, any> = {};
    for (const [k, v] of Object.entries(km)) if (MARK_FIELDS.has(k) && v !== null && v !== undefined) mark[k] = v;
    const shownIds = [...(km.on ?? []), km.from, km.to].filter((x): x is string => typeof x === "string" && byId.has(x));
    if (km.near && byId.has(km.near)) shownIds.push(km.near);
    const shown = shownIds.map((id) => byId.get(id)!);
    {
      const want = union([km.bounds, ...shown.map((s) => s.bounds)]);
      const shows = `${km.id}${shownIds.length ? ` and ${[...new Set(shownIds)].join(", ")}` : ""}`;
      // The device's own crop when one covers this Mark and its targets; one image can show several Marks.
      const device = (frozen.crops ?? []).find((c) => contains(c.bounds, want));
      const same = images.find((i) => (device && !region ? i.asset === device.asset : contains(i.bounds, want)));
      if (same) {
        // The Region image says which lines it shows once, after the loop.
        if (!(region && same.n === 1 && km.line) && same.shows.length + shows.length < 190) same.shows = `${same.shows}; ${shows}`;
        mark.image = same.n;
      } else if (images.length < MAX_IMAGES) {
        const n = images.length + 1;
        const png = device ? opts.asset(device.asset) : undefined;
        if (device && png) images.push({ n, shows, bounds: device.bounds, png, asset: device.asset });
        else {
          const crop = pad(want, 40);
          images.push({ n, shows, bounds: crop, png: render(crop) });
        }
        mark.image = n;
      }
    }
    if (mark.kind === "ink" && !mark.note) mark.note = `Not recognized.${mark.image ? ` See image ${mark.image}.` : ""}`;
    if (mark.kind === "writing" && (mark.confidence ?? 1) < 0.6 && mark.image) mark.note = `Low confidence: read it from image ${mark.image}.`;
    marks.push(mark);
    refs.push({ id: km.id, strokes: km.strokes, bounds: km.bounds });
  }

  if (region) {
    const ls = marks.filter((m) => m.line && m.image === 1);
    if (ls.length) images[0].shows = `Region ${region.id}, ${plural(ls.length, "line")} (${ls.length === 1 ? ls[0].id : `${ls[0].id}–${ls.at(-1)!.id}`})${images[0].shows.slice(`Region ${region.id}`.length)}`.slice(0, 200);
  }

  const changes = (frozen.changes ?? [])
    .map((c) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(c)) if (CHANGE_FIELDS.has(k) && v !== null && v !== undefined) out[k] = k === "id" ? opts.displayId(String(v)) : v;
      if (typeof out.was === "string" && out.was.length > 400) out.was = out.was.slice(0, 399) + "…";
      return out;
    })
    .filter((c) => c.kind && c.id);
  // Values entered in a Panel are saved on its Element (the kernel's set_state), so the next Send
  // claims them as a panel change. A panel_change Behavior's Send also carries the values it fired
  // with; they are added only when no claimed change already says the same.
  if (frozen.values && frozen.element) {
    const id = opts.displayId(frozen.element);
    if (!changes.some((c) => c.kind === "panel" && c.id === id && (!frozen.panel || c.panel === frozen.panel))) changes.push({ kind: "panel", id, ...(frozen.panel ? { panel: frozen.panel } : {}), values: frozen.values });
  }
  // What the person's taps (and other Behaviors) set since their last Send, on Elements this Agent
  // can see, and for a Region's Send only inside that Region.
  const tapped = new Set<string>();
  for (const b of opts.behaviors ?? []) {
    const id = opts.displayId(b.key);
    const el = byId.get(id);
    if (!el || (region && !overlaps(region.bounds, el.bounds))) continue;
    changes.push({ kind: "behavior", id, ...(b.on ? { on: b.on } : {}), set: b.set });
    tapped.add(id);
  }
  // A photo or PDF page the person added comes as an image: the image Element with anything drawn on it.
  for (const c of changes.filter((c) => c.kind === "added_file")) {
    const el = byId.get(c.id);
    if (!el || el.type !== "image" || images.length >= MAX_IMAGES) continue;
    const n = images.length + 1;
    images.push({ n, shows: `${c.id}, ${c.pages ? `page 1 of ${c.file}` : c.file ?? "the picture"} ${opts.personName} added`.slice(0, 200), bounds: el.bounds, png: render(el.bounds) });
    c.image = n;
  }

  // The nearby scene: what is near the Marks, or on screen when there are none.
  const viewport = frozen.viewport ?? opts.entry.viewport;
  const focus = refs.length ? refs.map((r) => pad(r.bounds, 300)) : [viewport];
  const near = outline.filter((e) => e.type !== "ink" && (tapped.has(e.id) || focus.some((f) => overlaps(f, e.bounds)))).slice(0, 200);
  const nearIds = new Set(near.map((e) => e.id));
  const rest = outline.filter((e) => e.type !== "ink" && !nearIds.has(e.id));
  const onScreen = rest.filter((e) => overlaps(viewport, e.bounds)).length;

  // The transcript, with each Mark's ID where the person drew it while speaking.
  const said = frozen.words?.length ? interleave(frozen.words, opts.marks) : frozen.said;

  const kind = frozen.kind === "tap" ? "tap" : (frozen.kind ?? "send");
  const s = frozen.send;
  const bundle: Record<string, any> = {
    kind,
    send: s,
    space: frozen.space,
    from: { person: frozen.from.person, name: opts.personName },
    trigger: frozen.trigger,
    ...(said ? { said: said.slice(0, 20000) } : {}),
    marks,
    changes,
    scene: near,
    elsewhere: { on_screen: onScreen, off_screen: rest.length - onScreen },
    ...(frozen.viewport ? { viewport: frozen.viewport } : {}),
    ...(frozen.selection?.length ? { selection: frozen.selection.map(opts.displayId) } : {}),
    ...(frozen.region ? { region: opts.displayId(frozen.region) } : {}),
    ...(frozen.element ? { element: opts.displayId(frozen.element) } : {}),
    ...(frozen.payload ? { payload: frozen.payload } : {}),
    ...(kind === "watch" ? { user_still_writing: frozen.user_still_writing === true } : {}),
    images: images.map(({ n, shows, bounds }) => ({ n, shows, bounds })),
    also_sent_to: opts.alsoSentTo,
    redelivered: opts.redelivered,
    pending_after: opts.pendingAfter,
    next:
      kind === "watch"
        ? `A snapshot of ${opts.personName === "You" ? "the person's" : `${opts.personName}'s`} work in progress${frozen.user_still_writing ? "; they are still writing" : ""}. Step in only when a line is wrong and they have moved past it, with a short hint beside it; never answer in full. ${opts.pushed ? `Then end your turn: the next snapshot or Send is pushed to you the same way.` : `Then wait_for_user(after: '${s}').`}`
        : opts.pushed
        ? `${kind === "send" ? `Reply with apply(in_reply_to: '${s}')${refs.length ? `; what you add without at goes next to ${refs[0].id}` : ""}` : `${opts.personName}'s turn is not over. Answer with apply(in_reply_to: '${s}') if useful`}. With nothing to add, acknowledge it with wait_for_user(after: '${s}', timeout_s: 0). Then end your turn: the next Send is pushed to you the same way.`
        : kind === "send"
        ? `Reply with apply(in_reply_to: '${s}')${refs.length ? `; what you add without at goes next to ${refs[0].id}` : ""}, then wait_for_user(after: '${s}').`
        : `${opts.personName}'s turn is not over. Answer if useful, then wait_for_user(after: '${s}').`,
  };
  return { bundle, images, marks: refs };
}
