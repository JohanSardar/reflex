// Extensions as files on disk (ARCHITECTURE §5):
//   Guide           one Markdown file with front matter (kind: guide)
//   Recipe          one Markdown file: front matter, a ```json params block, a ```json template block
//                   (and optionally a ```json example block with parameter values)
//   Embed Template  a folder: reflex.json, one HTML file, a parameter schema, a guide
//   Send Adapter    a folder: reflex.json and one TypeScript module
// Conformance examples saved from `reflex dev` sit next to them in examples/.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { EmbedExt, GuideExt, Kind, RecipeExt } from "./checks.ts";

export interface AdapterExt {
  kind: "adapter";
  name: string;
  summary: string;
  /** The module's absolute path. */
  entry: string;
  config: Record<string, unknown>;
}
export type Extension = GuideExt | RecipeExt | EmbedExt | AdapterExt;
export type Loaded = { ext: Extension; path: string; dir: string; files: string[]; examples: string };

export class ExtensionFileError extends Error {
  fix: string;
  constructor(msg: string, fix: string) {
    super(msg);
    this.fix = fix;
  }
}

/** Splits `---\nkey: value\n---\nbody`. Values are plain strings; JSON values (quoted, lists, objects) are parsed. */
export function frontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    try {
      meta[kv[1]] = /^["[{]/.test(v) ? JSON.parse(v) : v;
    } catch {
      meta[kv[1]] = v;
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Takes out the ```json <label> blocks and returns them parsed, with the rest of the Markdown as the guide. */
function jsonBlocks(body: string, file: string): { blocks: Record<string, unknown>; rest: string } {
  const blocks: Record<string, unknown> = {};
  const rest = body.replace(/```json[ \t]+(params|template|example)[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?\n?/g, (_, label: string, src: string) => {
    try {
      blocks[label] = JSON.parse(src);
    } catch (e) {
      throw new ExtensionFileError(`The \`\`\`json ${label} block in ${file} is not valid JSON: ${(e as Error).message}`, `Fix the JSON in the ${label} block.`);
    }
    return "";
  });
  return { blocks, rest: rest.replace(/\n{3,}/g, "\n\n").trim() };
}

const readJson = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ExtensionFileError(`${file} is not valid JSON: ${(e as Error).message}`, `Fix ${basename(file)}.`);
  }
};

/** Finds the extension at a path: a Markdown file, or a folder with reflex.json (or one Markdown extension). */
export function locate(path: string): string {
  const p = resolve(path);
  if (!existsSync(p)) throw new ExtensionFileError(`Nothing at ${p}.`, "Pass the path of an extension, such as one `reflex create` wrote.");
  if (statSync(p).isFile()) return p;
  if (existsSync(join(p, "reflex.json"))) return join(p, "reflex.json");
  const md = readdirSync(p).filter((f) => f.endsWith(".md") && ["guide", "recipe"].includes(String(frontMatter(readFileSync(join(p, f), "utf8")).meta.kind)));
  if (md.length === 1) return join(p, md[0]);
  throw new ExtensionFileError(
    md.length ? `${p} holds several extensions: ${md.join(", ")}.` : `${p} has no reflex.json and no guide or recipe Markdown file.`,
    md.length ? "Pass one of them." : "Pass the path of an extension, or make one with `reflex create guide|recipe|embed|adapter <name>`.",
  );
}

export function load(path: string): Loaded {
  const file = locate(path);
  const dir = dirname(file);
  if (basename(file) === "reflex.json") {
    const m = readJson(file);
    const rel = (f: unknown, what: string) => {
      if (typeof f !== "string") throw new ExtensionFileError(`reflex.json has no ${what}.`, `Set "${what}" to a file in ${dir}.`);
      const abs = resolve(dir, f);
      if (!existsSync(abs)) throw new ExtensionFileError(`reflex.json names ${what} ${f}, which doesn't exist.`, `Create ${f}, or fix "${what}".`);
      return abs;
    };
    if (m.kind === "embed") {
      const html = rel(m.entry ?? "index.html", "entry");
      const params = m.params === undefined ? undefined : typeof m.params === "string" ? readJson(rel(m.params, "params")) : m.params;
      const guide = m.guide ? readFileSync(rel(m.guide, "guide"), "utf8") : undefined;
      const ext: EmbedExt = { kind: "embed", name: m.name, summary: m.summary, params: params ?? {}, template: readFileSync(html, "utf8"), ...(guide ? { guide } : {}), ...(m.allow ? { allow: m.allow } : {}), ...(m.example ? { example: m.example } : {}) };
      return { ext, path: file, dir, files: [file, html, ...(typeof m.params === "string" ? [rel(m.params, "params")] : []), ...(m.guide ? [rel(m.guide, "guide")] : [])], examples: join(dir, "examples") };
    }
    if (m.kind === "adapter") {
      const entry = rel(m.entry ?? "adapter.ts", "entry");
      return { ext: { kind: "adapter", name: m.name, summary: m.summary, entry, config: m.config ?? {} }, path: file, dir, files: [file, entry], examples: join(dir, "examples") };
    }
    throw new ExtensionFileError(`reflex.json has kind ${JSON.stringify(m.kind)}.`, 'Set "kind" to "embed" or "adapter"; guides and recipes are single Markdown files.');
  }
  const text = readFileSync(file, "utf8");
  const { meta, body } = frontMatter(text);
  const name = (meta.name as string) ?? basename(file, ".md");
  const examples = join(dir, "examples");
  if (meta.kind === "recipe") {
    const { blocks, rest } = jsonBlocks(body, file);
    if (!("template" in blocks)) throw new ExtensionFileError(`${file} has no \`\`\`json template block.`, "Add the op template as a fenced ```json template block.");
    const ext: RecipeExt = {
      kind: "recipe",
      name,
      summary: meta.summary as string,
      params: (blocks.params as Record<string, unknown>) ?? { type: "object", properties: {}, additionalProperties: false },
      template: blocks.template as unknown[],
      guide: rest,
      ...(blocks.example ? { example: blocks.example as Record<string, unknown> } : {}),
    };
    return { ext, path: file, dir, files: [file], examples };
  }
  if (meta.kind === "guide" || meta.kind === undefined) return { ext: { kind: "guide", name, summary: meta.summary as string, text: body.trim() }, path: file, dir, files: [file], examples };
  throw new ExtensionFileError(`${file} has kind ${JSON.stringify(meta.kind)}.`, "Set kind to guide or recipe in the front matter.");
}

/** The conformance examples saved for an extension, oldest first. */
export function examples(l: Loaded): { file: string; example: Record<string, any> }[] {
  if (!existsSync(l.examples)) return [];
  const prefix = l.ext.kind === "guide" || l.ext.kind === "recipe" ? `${l.ext.name}-` : "";
  return readdirSync(l.examples)
    .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => ({ file: join(l.examples, f), example: readJson(join(l.examples, f)) }));
}

export const KINDS: Kind[] = ["guide", "recipe", "embed", "adapter"];
