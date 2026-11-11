// What `recipe` applies and the Element type Guides `read_me` serves
// (ADR-0006, rungs 0 and 1). Built-in Recipes are Markdown files in
// extensions/recipes; the person's Library (library.ts) adds the ones Agents
// saved with define. Element types get a Guide made from the protocol schema,
// so it can never disagree with what apply accepts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RecipeExt } from "./extensions/checks.ts";
import { load } from "./extensions/files.ts";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

const root = new URL("../../extensions/", import.meta.url);
const protocol = new URL("../../protocol/", import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, protocol), "utf8"));

export type Source = "builtin" | "extension" | "library";
export type Recipe = {
  name: string;
  summary: string;
  params: Record<string, any>;
  template: Record<string, any>[];
  guide: string;
  source: Source;
  by?: string;
};
/** A Library entry as the kernel stores it (apply's define op, plus `by`). */
export type LibraryEntry = { kind: "recipe" | "embed"; name: string; summary?: string; params?: any; template?: any; guide?: string; by?: { agent?: string; person?: string } };

/** The built-in Recipes in extensions/recipes, read with the same loader `reflex test` uses. */
export const RECIPES: Recipe[] = (() => {
  const dir = new URL("recipes/", root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => load(fileURLToPath(new URL(f, dir))).ext)
    .filter((e): e is RecipeExt => e.kind === "recipe")
    .map((e) => ({ name: e.name, summary: e.summary, params: e.params, template: e.template as Record<string, any>[], guide: e.guide ?? "", source: "builtin" as const }));
})();

// ---------- Element types, from the protocol ----------

const applySchema = json("schema/apply.input.schema.json");
const elementSchema = json("schema/element.schema.json");
const EXAMPLES: Record<string, Record<string, unknown>> = {
  text: { op: "add", id: "title", type: "text", text: "# Auth plan", markdown: true, size: "l" },
  note: { op: "add", type: "note", text: "Rate limits?", color: "yellow", at: { near: "m1" } },
  math: { op: "add", id: "eq", type: "math", latex: "h = \\frac{v^2}{2g}", size: "l" },
  shape: { op: "add", id: "n-auth", type: "shape", shape: "rounded", text: "Auth service", fill: "tint", color: "blue" },
  connector: { op: "add", type: "connector", from: "n-gateway", to: "n-auth", text: "JWT" },
  image: { op: "add", id: "diagram", type: "image", src: "https://example.com/diagram.png", alt: "Current architecture", w: 480 },
  frame: { op: "add", id: "phase-1", type: "frame", title: "Phase 1", w: 900, h: 500 },
  region: { op: "add", id: "work", type: "region", title: "Your answer", send_button: "Check my work", w: 800, h: 400 },
  embed: { op: "add", id: "chart", type: "embed", html: "<canvas id=c></canvas><script>/* draw */</script>", w: 600, h: 400 },
};
const PEOPLE_ONLY: Record<string, string> = {
  ink: "One stroke of the person's handwriting or drawing. Only people draw Ink; Agents never change or cover it. Read its points with read(ids: [id], detail: \"strokes\").",
  file: "A file the person added that is not a picture. Read its contents with read(ids: [id], detail: \"full\"). Only people add files; to show a picture, add an image.",
};

function describe(ref: any): string {
  const name = typeof ref?.$ref === "string" ? ref.$ref.split("/").pop() : undefined;
  const d = (name && elementSchema.$defs[name]) || ref || {};
  const parts = [d.description ?? ref?.description];
  if (d.enum) parts.push(`One of: ${d.enum.join(", ")}.`);
  return parts.filter(Boolean).join(" ");
}

export const TYPES: string[] = applySchema.properties.ops.items.oneOf
  .filter((v: any) => v.properties.op.const === "add" && v.properties.type?.const)
  .map((v: any) => v.properties.type.const);

export function typeGuide(type: string): string | undefined {
  if (PEOPLE_ONLY[type]) return `# ${type}\n\n${PEOPLE_ONLY[type]}\n`;
  const v = applySchema.properties.ops.items.oneOf.find((v: any) => v.properties.op.const === "add" && v.properties.type?.const === type);
  if (!v) return undefined;
  const common = new Set(["op", "type", "data", "behaviors", "draggable", "locked", "snap"]);
  const req = new Set<string>(v.required ?? []);
  const rows = Object.entries<any>(v.properties)
    .filter(([k]) => !common.has(k))
    .map(([k, p]) => `- \`${k}\`${req.has(k) ? " (required)" : ""}: ${describe(p) || (k === "at" ? "Where it goes: {right_of|left_of|above|below|near|inside: <id or Mark>, gap} or {x, y}." : k === "id" ? "Your ID for it, unique among your Elements." : "")}`);
  return [
    `# ${type}`,
    "",
    v.description ?? "",
    "",
    "Fields:",
    ...rows,
    "- Every type also takes `data` (your own JSON, returned in read and Sends), `behaviors` (read_me(\"behaviors\")), `draggable`, `locked` and `snap`.",
    "",
    "Example:",
    "",
    "```json",
    JSON.stringify(EXAMPLES[type] ?? { op: "add", type }),
    "```",
    "",
    "Change it later with patch (set, unset, text_insert, …) by its id.",
  ].join("\n");
}

// ---------- Recipes: params and expansion ----------

const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true });
const compiled = new Map<string, ValidateFunction>();
export function checkParams(r: Recipe, params: Record<string, unknown>): { ok: true; params: Record<string, unknown> } | { ok: false; errors: string[] } {
  const key = `${r.source}:${r.name}:${JSON.stringify(r.params)}`;
  let v = compiled.get(key);
  if (!v) compiled.set(key, (v = ajv.compile(r.params ?? {})));
  const copy = structuredClone(params ?? {});
  if (v(copy)) return { ok: true, params: copy };
  return { ok: false, errors: (v.errors ?? []).map((e) => `params${e.instancePath} ${e.message}${e.params && "additionalProperty" in e.params ? ` ('${(e.params as any).additionalProperty}')` : ""}`) };
}

/** Fills a template: "{{name}}" becomes the value with its type; {{name}} in a longer string becomes its text. */
export function expand(template: unknown, params: Record<string, unknown>): any {
  if (typeof template === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(template);
    if (whole) return params[whole[1]];
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] === undefined ? "" : String(params[k])));
  }
  if (Array.isArray(template)) return template.map((t) => expand(t, params)).filter((t) => t !== undefined);
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      const e = expand(v, params);
      if (e !== undefined) out[k] = e;
    }
    return out;
  }
  return template;
}

export function fromLibrary(e: LibraryEntry, byName: (id?: string) => string | undefined): Recipe | undefined {
  if (e.kind !== "recipe" || !Array.isArray(e.template)) return undefined;
  return { name: e.name, summary: e.summary ?? "", params: e.params ?? { type: "object" }, template: e.template, guide: e.guide ?? "", source: "library", by: byName(e.by?.agent ?? e.by?.person) };
}
