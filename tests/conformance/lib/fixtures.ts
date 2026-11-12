// The SPEC §16 scenarios as conformance fixtures (tests/conformance/scenarios/*.json),
// and the rules every profile uses to turn them into strokes and to compare Marks.
// The rules are written down in tests/conformance/README.md, "Fixtures"; an
// implementation in another language follows the README, not this file.
import { readdirSync, readFileSync } from "node:fs";

export const DIR = new URL("../scenarios/", import.meta.url);

/** The person every fixture draws as, and the Agent that set it up. */
export const PERSON = { id: "p_4c1e9a7b2d30", name: "Ana" };
export const AGENT = "a_claude";
/** The clock: setup happens at T0; the n-th stroke (from 1) ends at T0 + n s, its Send at T0 + (strokes + 1) s. */
export const T0 = 1_762_862_400_000;

export type Draw =
  | { id: string; ellipse: [number, number, number, number]; after_ms?: number }
  | { id: string; points: number[][]; after_ms?: number }
  | { ids: string[]; letters: [number, number]; after_ms?: number }
  | { move: string[]; by: [number, number]; after_ms?: number };

export interface SendStep {
  draw: Draw[];
  raw: Record<string, unknown> & { send: string };
  /**
   * marks: the Marks in order, each with at least these fields. Or, where how strokes group is the
   * implementation's choice: every Mark has `every`'s fields, and together they hold `strokes`, in order.
   */
  expect: { frozen?: Record<string, unknown>; marks?: Record<string, unknown>[]; every?: Record<string, unknown>; strokes?: string[] };
}

export interface Scenario {
  scenario: number;
  title: string;
  spec: string;
  space: string;
  setup: { ops: Record<string, unknown>[] }[];
  sends: SendStep[];
  /** Every Element the setup makes, by the Agent's own ID. */
  elements: string[];
  file: string;
}

export function scenarios(): Scenario[] {
  return readdirSync(DIR)
    .filter((f) => /^\d\d-.*\.json$/.test(f))
    .sort()
    .map((f) => ({ ...JSON.parse(readFileSync(new URL(f, DIR), "utf8")), file: f }));
}

/** One user intent the person's device writes, at a time. */
export interface Step {
  at: number;
  intent: Record<string, unknown>;
}

/** A polyline as a Pencil samples it: a point every 4 px or less along each segment, 4 ms apart, pressure 0.6. */
function timed(pts: number[][]): number[][] {
  const out: number[][] = [];
  pts.forEach((p, i) => {
    if (i === 0) return void out.push([p[0], p[1]]);
    const [x0, y0] = pts[i - 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - x0, p[1] - y0) / 4));
    for (let k = 1; k <= steps; k++) out.push([Math.round((x0 + ((p[0] - x0) * k) / steps) * 10) / 10, Math.round((y0 + ((p[1] - y0) * k) / steps) * 10) / 10]);
  });
  return out.map((p, i) => [p[0], p[1], i * 4, 0.6]);
}

/** A closed ellipse: 25 points, starting at angle 0. */
function ellipse([cx, cy, rx, ry]: [number, number, number, number]): number[][] {
  return Array.from({ length: 25 }, (_, i) => {
    const a = (2 * Math.PI * i) / 24;
    return [Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))];
  });
}

/** One handwritten letter, as a 12×24 single stroke whose top-left is at (x, y): down, then a small bowl. */
function letter(x: number, y: number): number[][] {
  return [
    [x + 2, y],
    [x + 2, y + 12],
    [x + 2, y + 24],
    [x + 8, y + 22],
    [x + 12, y + 16],
    [x + 8, y + 12],
    [x + 2, y + 14],
  ];
}

/**
 * The intents one Send's drawing becomes, with their times. Each entry starts 1 s after
 * the previous one ended (or `after_ms` after it, for a gesture drawn quickly), and
 * letters are 16 px apart, 300 ms apart.
 */
export function intents(draw: Draw[], start: number): { steps: Step[]; end: number } {
  const steps: Step[] = [];
  let t = start;
  for (const d of draw) {
    t += d.after_ms ?? 1000;
    if ("move" in d) steps.push({ at: t, intent: { intent: "move", ids: d.move.map(stored), by: d.by } });
    else if ("letters" in d)
      d.ids.forEach((id, i) => {
        if (i) t += 300;
        steps.push({ at: t, intent: { intent: "add_stroke", id, stroke: { points: timed(letter(d.letters[0] + 16 * i, d.letters[1])), width: 3 }, color: "red" } });
      });
    else steps.push({ at: t, intent: { intent: "add_stroke", id: d.id, stroke: { points: timed("ellipse" in d ? ellipse(d.ellipse) : d.points), width: 3 }, color: "red" } });
  }
  return { steps, end: t + 1000 };
}

/** An Agent's Element ID as everyone but that Agent sees it. */
export const stored = (id: string) => (id.includes(":") ? id : `${AGENT}:${id}`);

/** Whether `got` has every field `want` names, with equal values. `on` compares as a set; objects compare field by field. */
export function partial(want: unknown, got: unknown, path = ""): string[] {
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return [`${path || "/"}: expected a list, got ${JSON.stringify(got)}`];
    const set = path.endsWith("/on");
    const a = set ? [...want].map(String).sort() : want;
    const b = set ? [...got].map(String).sort() : got;
    if (a.length !== b.length) return [`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
    return a.flatMap((w, i) => partial(w, b[i], `${path}/${i}`));
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") return [`${path || "/"}: expected an object, got ${JSON.stringify(got)}`];
    return Object.entries(want).flatMap(([k, v]) => partial(v, (got as Record<string, unknown>)[k], `${path}/${k}`));
  }
  return want === got ? [] : [`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
}

/** Compares a Send's Marks with what the fixture expects. */
export function compareMarks(expect: SendStep["expect"], got: Record<string, unknown>[]): string[] {
  if (expect.every) {
    const out = got.flatMap((m, i) => partial(expect.every, m, `/marks/${i}`));
    const held = got.flatMap((m) => (m.strokes as string[]) ?? []);
    if (JSON.stringify(held) !== JSON.stringify(expect.strokes ?? held)) out.push(`the Marks hold strokes ${held.join(", ")}, expected ${expect.strokes!.join(", ")}`);
    if (!got.length) out.push("no Marks");
    return out;
  }
  const want = expect.marks ?? [];
  const out: string[] = [];
  if (want.length !== got.length) out.push(`expected ${want.length} Marks (${want.map((m) => m.kind).join(", ")}), got ${got.length} (${got.map((m) => m.kind).join(", ")})`);
  want.forEach((w, i) => {
    if (got[i]) out.push(...partial(w, got[i], `/marks/${i}`));
  });
  return out;
}
