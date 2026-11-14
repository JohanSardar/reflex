// Project the immutable local PencilKit snapshot into the same review-comment
// bundle for wait_for_user and every push adapter. No live page reads are needed.
import type { Bounds, InkStroke, NativeSend } from "../../../link/storage/sends.ts";

type Point = number[];
type Target = { id: string; bounds: Bounds; text?: string };
type Group = { strokes: InkStroke[]; bounds: Bounds; text?: string; confidence?: number };
const union = (bs: Bounds[]): Bounds => {
  const x = Math.min(...bs.map((b) => b[0])), y = Math.min(...bs.map((b) => b[1]));
  return [x, y, Math.max(...bs.map((b) => b[0] + b[2])) - x, Math.max(...bs.map((b) => b[1] + b[3])) - y];
};
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const length = (s: InkStroke) => s.points.slice(1).reduce((n, p, i) => n + distance(p, s.points[i]), 0);
const straight = (s: InkStroke) => distance(s.points[0], s.points.at(-1)!) / Math.max(1, length(s));
const size = (s: InkStroke) => Math.max(s.bounds[2], s.bounds[3]);
const area = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
const pad = (b: Bounds, n: number): Bounds => [b[0] - n, b[1] - n, b[2] + 2 * n, b[3] + 2 * n];
const center = (b: Bounds) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
const boxDistance = (b: Bounds, p: Point) => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[1] - b[3]));
function inside(points: Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
function closed(s: InkStroke): boolean {
  if (s.points.length < 8 || !s.points.slice(Math.floor(s.points.length / 2)).some((p) => distance(p, s.points[0]) < 0.3 * size(s))) return false;
  const enclosed = Math.abs(s.points.reduce((v, p, i) => { const q = s.points[(i + 1) % s.points.length]; return v + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  return length(s) > 2.2 * size(s) || (length(s) > 1.4 * (s.bounds[2] + s.bounds[3]) && enclosed > 0.4 * s.bounds[2] * s.bounds[3]);
}
function groups(send: NativeSend): Group[] {
  const result: Group[] = [], used = new Set<string>();
  for (const h of send.hints ?? []) {
    const strokes = send.strokes.filter((s) => h.strokes.includes(s.id) && !used.has(s.id));
    if (!strokes.length) continue;
    strokes.forEach((s) => used.add(s.id));
    result.push({ strokes, bounds: union(strokes.map((s) => s.bounds)), text: h.text, confidence: h.confidence });
  }
  let open: Group | undefined;
  for (const s of [...send.strokes].sort((a, b) => a.at - b.at).filter((s) => !used.has(s.id))) {
    const last = open?.strokes.at(-1);
    const quick = last && s.at - (last.at + (last.points.at(-1)?.[2] ?? 0)) <= 1500;
    const near = open && size(s) <= 90 && area(pad(open.bounds, 50), s.bounds) > 0;
    const over = last && area(s.bounds, last.bounds) >= 0.5 * Math.min(s.bounds[2] * s.bounds[3], last.bounds[2] * last.bounds[3]);
    if (open && quick && (near || over)) { open.strokes.push(s); open.bounds = union([open.bounds, s.bounds]); }
    else { open = { strokes: [s], bounds: s.bounds }; result.push(open); }
  }
  return result.sort((a, b) => Math.min(...a.strokes.map((s) => s.at)) - Math.min(...b.strokes.map((s) => s.at)));
}
function classify(g: Group, targets: Target[]): Record<string, any> {
  const ss = g.strokes, main = [...ss].sort((a, b) => length(b) - length(a))[0];
  const own = new Set(ss.map((s) => s.id));
  const ts = targets.filter((t) => !own.has(t.id));
  const nearest = (p: Point, reach: number) => ts.filter((t) => boxDistance(t.bounds, p) <= reach).sort((a, b) => boxDistance(a.bounds, p) - boxDistance(b.bounds, p) || a.bounds[2] * a.bounds[3] - b.bounds[2] * b.bounds[3])[0];
  const under = () => ts.filter((t) => area(t.bounds, g.bounds) > 0).sort((a, b) => area(b.bounds, g.bounds) / Math.max(1, b.bounds[2] * b.bounds[3]) - area(a.bounds, g.bounds) / Math.max(1, a.bounds[2] * a.bounds[3]))[0] ?? nearest(center(g.bounds), 30);
  if (closed(main)) {
    const on = ts.filter((t) => t.bounds[2] <= 1.3 * main.bounds[2] && t.bounds[3] <= 1.3 * main.bounds[3] && inside(main.points, center(t.bounds))).map((t) => t.id);
    if (on.length) return { kind: "circle", on: on.slice(0, 20) };
  }
  if (g.text) return { kind: "writing", text: g.text, confidence: g.confidence };
  if (ss.length === 2 && ss.every((s) => straight(s) > 0.8 && size(s) > 20) && area(ss[0].bounds, ss[1].bounds) >= 0.5 * Math.min(ss[0].bounds[2] * ss[0].bounds[3], ss[1].bounds[2] * ss[1].bounds[3])) {
    const t = under(); return { kind: "cross", ...(t ? { on: [t.id] } : {}) };
  }
  const first = main.points[0], last = main.points.at(-1)!;
  const low = main.points.reduce((best, p, i) => p[1] > main.points[best][1] ? i : best, 0), p = main.points[low];
  if (ss.length === 1 && main.points.length >= 4 && size(main) <= 220 && low / (main.points.length - 1) >= 0.1 && low / (main.points.length - 1) <= 0.6
      && first[1] < p[1] - 0.2 * main.bounds[3] && last[1] < first[1] && last[0] > p[0] && p[0] > first[0] && Math.abs(last[1] - p[1]) > 1.3 * Math.abs(p[1] - first[1])) {
    const t = under(); return { kind: "check", ...(t ? { on: [t.id] } : {}) };
  }
  if (length(main) >= 50 && straight(main) > 0.55) {
    const tip = main.points.reduce((a, b) => distance(first, a) > distance(first, b) ? a : b);
    const from = nearest(first, 40), to = nearest(tip, 40);
    if (from && to && from.id !== to.id) return { kind: "arrow", from: from.id, to: to.id };
    if (ss.length === 1 && straight(main) > 0.85) {
      const middle = [(first[0] + tip[0]) / 2, (first[1] + tip[1]) / 2];
      const through = ts.filter((t) => boxDistance([t.bounds[0], t.bounds[1] + 0.2 * t.bounds[3], t.bounds[2], 0.6 * t.bounds[3]], middle) === 0 && distance(first, tip) >= 0.45 * t.bounds[2]).sort((a, b) => a.bounds[2] * a.bounds[3] - b.bounds[2] * b.bounds[3])[0];
      if (through) return { kind: "strikethrough", on: [through.id] };
      if (main.bounds[3] <= Math.max(30, 0.35 * main.bounds[2])) {
        const below = ts.filter((t) => main.bounds[1] >= t.bounds[1] + 0.65 * t.bounds[3] && main.bounds[1] <= t.bounds[1] + t.bounds[3] + 30 && area([main.bounds[0], t.bounds[1], main.bounds[2], t.bounds[3]], t.bounds) >= 0.4 * t.bounds[2] * t.bounds[3])[0];
        if (below) return { kind: "underline", on: [below.id] };
      }
    }
    if ((ss.length > 1 || straight(main) < 0.92) && (from || to) && from?.id !== to?.id && Math.max(g.bounds[2], g.bounds[3]) >= 60) return { kind: "arrow", ...(from ? { from: from.id } : {}), ...(to ? { to: to.id } : {}) };
  }
  const near = nearest(center(g.bounds), 100);
  return { kind: ss.length >= 2 && ss.every((s) => size(s) <= 120) ? "writing" : "ink", ...(near ? { near: near.id } : {}) };
}

export function nativeBundle(send: NativeSend, opts: {
  personName: string; others: string[]; redelivered: boolean; pendingAfter: number; pushed?: boolean;
  asset: (hash: string) => Buffer | undefined;
}): { json: Record<string, any>; images: Buffer[] } {
  const gs = groups(send);
  const targets: Target[] = (send.context ?? send.strokes).map((s) => ({ id: s.id, bounds: s.bounds }));
  const images: Buffer[] = [], imageInfo: { n: number; shows: string; bounds: Bounds }[] = [];
  for (const crop of send.crops ?? []) {
    const bytes = opts.asset(crop.asset);
    if (bytes) { images.push(bytes); imageInfo.push({ n: images.length, shows: "What the person saw when they pressed Send", bounds: crop.bounds }); }
  }
  const marks = gs.map((g, i) => {
    const mark = { id: `m${i + 1}`, ...classify(g, targets), strokes: g.strokes.map((s) => s.id), bounds: g.bounds,
      at: Math.min(...g.strokes.map((s) => s.at)), end: Math.max(...g.strokes.map((s) => s.at + (s.points.at(-1)?.[2] ?? 0))) };
    const image = imageInfo.find((im) => area(im.bounds, g.bounds) > 0);
    return { ...mark, ...(image ? { image: image.n } : {}) };
  });
  const words = [...(send.words ?? [])].sort((a, b) => a.start_ms - b.start_ms);
  const timed = [...marks].sort((a, b) => a.at - b.at), transcript: string[] = [];
  let k = 0;
  for (const w of words) { while (k < timed.length && timed[k].at < w.start_ms) transcript.push(`[${timed[k++].id}]`); transcript.push(w.text); }
  while (k < timed.length) transcript.push(`[${timed[k++].id}]`);
  return { json: {
    kind: "send", send: send.send, space: send.space, from: { person: send.by.person, name: opts.personName }, trigger: send.trigger,
    ...(send.said ? { said: words.length ? transcript.join(" ") : send.said } : {}), ...(words.length ? { words } : {}),
    marks, strokes: send.strokes, scene: targets, changes: [], viewport: send.viewport, images: imageInfo,
    also_sent_to: opts.others, redelivered: opts.redelivered, pending_after: opts.pendingAfter,
    next: `Acknowledge with wait_for_user(after: '${send.send}'${opts.pushed ? ", timeout_s: 0" : ""}).${opts.pushed ? " Then end your turn; the next Send is pushed to you." : ""}`,
  }, images };
}
