// The contract checks for extensions (ARCHITECTURE §5, ADR-0006). One set of
// checks serves both ways an extension arrives: a file an author wrote, run by
// `reflex test`, and a Recipe or Embed Template an Agent saves with `apply`'s
// `define` op. So an Agent's invention is checked exactly like anyone else's.
//
// A check returns problems, each with a stable code, what is wrong and how to
// fix it. Errors fail the extension; warnings are lints the author should see.
import { randomBytes } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Space } from "@reflex/kernel/node";
import { normalizeOps } from "../capabilities/normalize.ts";

export type Problem = { level: "error" | "warning"; code: string; msg: string; fix: string; where?: string };
export type Kind = "guide" | "recipe" | "embed" | "adapter";

export const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Hosts every Embed may load from without asking (SPEC §5: approved CDNs are allowed by default). */
export const DEFAULT_ALLOW = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh"];

export interface RecipeExt {
  kind: "recipe";
  name: string;
  summary: string;
  params: Record<string, unknown>;
  template: unknown[];
  guide?: string;
  /** Parameter values to check the template with. Made up from the schema when absent. */
  example?: Record<string, unknown>;
}
export interface EmbedExt {
  kind: "embed";
  name: string;
  summary: string;
  params: Record<string, unknown>;
  template: string;
  guide?: string;
  allow?: string[];
  /** An MCP App view: the 'ui://' resource its HTML came from. */
  source?: string;
  example?: Record<string, unknown>;
}
export interface GuideExt {
  kind: "guide";
  name: string;
  summary: string;
  text: string;
}

const err = (code: string, msg: string, fix: string, where?: string): Problem => ({ level: "error", code, msg, fix, ...(where ? { where } : {}) });
const warn = (code: string, msg: string, fix: string, where?: string): Problem => ({ level: "warning", code, msg, fix, ...(where ? { where } : {}) });

function checkName(name: unknown, summary: unknown, out: Problem[]) {
  if (typeof name !== "string" || !NAME.test(name))
    out.push(err("invalid_name", `The name ${JSON.stringify(name)} is not a valid extension name.`, "Use lowercase letters, digits and dashes, starting with a letter or digit (at most 63).", "/name"));
  if (typeof summary !== "string" || !summary.trim())
    out.push(err("missing_summary", "There is no summary.", "Add a one-line summary; it is what read_me('index') shows.", "/summary"));
  else if (summary.length > 200) out.push(err("too_large", `The summary is ${summary.length} characters.`, "Keep the summary to one line of at most 200 characters.", "/summary"));
}

// ---------- parameter schemas: the protocol's restricted JSON Schema subset ----------

const BANNED = ["anyOf", "allOf", "not", "if", "then", "else", "patternProperties", "$dynamicRef", "$dynamicAnchor", "dependentSchemas", "$ref", "$id"];
const SAFE = 9007199254740991;
const ajv = new Ajv2020({ strict: false, allErrors: true });

/** Checks a parameter schema against the restricted subset (protocol/README "Schema rules") and compiles it. */
export function checkParams(schema: unknown, out: Problem[], where = "/params") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    out.push(err("invalid_params", "params is not a JSON Schema object.", 'Write params as a JSON Schema, such as {"type": "object", "properties": {"title": {"type": "string"}}}.', where));
    return undefined;
  }
  const s = schema as Record<string, any>;
  if (s.type !== "object") out.push(err("invalid_params", `params has type ${JSON.stringify(s.type)}; the parameters are always an object.`, 'Set "type": "object" at the top of params.', where));
  let oneOfs = 0;
  const walk = (node: any, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}/${i}`));
    if (!node || typeof node !== "object") return;
    for (const k of BANNED) if (k in node) out.push(err("invalid_params", `params uses '${k}' at ${path || "/"}, which is outside the protocol's schema subset.`, k === "$ref" ? "Inline the schema instead of referring to it." : "Use type, properties, required, enum, const, items, oneOf (one level), minimum and maximum.", `${where}${path}`));
    if ("oneOf" in node && ++oneOfs > 1 && path.includes("oneOf")) out.push(err("invalid_params", `params nests oneOf inside oneOf at ${path}.`, "Use at most one level of oneOf.", `${where}${path}`));
    if ([node.type].flat().includes("integer") && !(typeof node.minimum === "number" && node.minimum >= -SAFE && typeof node.maximum === "number" && node.maximum <= SAFE))
      out.push(err("invalid_params", `The integer at ${path || "/"} has no minimum and maximum.`, `Bound every integer inside ±${SAFE}, the range every runtime represents exactly.`, `${where}${path}`));
    if (node.properties && node.additionalProperties !== false)
      out.push(warn("open_params", `The object at ${path || "/"} accepts fields it doesn't list.`, 'Set "additionalProperties": false so a typo in a parameter is an error the Agent can fix.', `${where}${path}`));
    for (const [k, v] of Object.entries(node)) if (k !== "enum" && k !== "const" && k !== "default" && k !== "examples") walk(v, `${path}/${k}`);
  };
  walk(s, "");
  try {
    return ajv.compile(s);
  } catch (e) {
    out.push(err("invalid_params", `params does not compile: ${(e as Error).message}`.slice(0, 400), "Fix the JSON Schema in params.", where));
    return undefined;
  }
}

/** Parameter values made up from a schema: defaults and examples first, then a plain value of each type. */
export function exampleParams(schema: Record<string, any>): Record<string, unknown> {
  const value = (s: any, name: string): unknown => {
    if (!s || typeof s !== "object") return name;
    if ("default" in s) return s.default;
    if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    if ("const" in s) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if (Array.isArray(s.oneOf) && s.oneOf.length) return value(s.oneOf[0], name);
    switch ([s.type].flat()[0]) {
      case "integer":
      case "number":
        return typeof s.minimum === "number" ? Math.max(s.minimum, Math.min(1, s.maximum ?? 1)) : 1;
      case "boolean":
        return false;
      case "array":
        return Array.from({ length: s.minItems ?? 1 }, (_, i) => value(s.items, `${name}-${i + 1}`));
      case "object":
        return Object.fromEntries(Object.entries<any>(s.properties ?? {}).map(([k, v]) => [k, value(v, k)]));
      default: {
        // A string parameter is often used as an Element ID, so make one that passes as an ID.
        const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
        return typeof s.minLength === "number" && id.length < s.minLength ? id.padEnd(s.minLength, "x") : id;
      }
    }
  };
  return value(schema, "params") as Record<string, unknown>;
}

// ---------- Recipe templates ----------

const WHOLE = /^\{\{([a-zA-Z0-9_-]+)\}\}$/;
const PART = /\{\{([a-zA-Z0-9_-]+)\}\}/g;

/**
 * Fills a Recipe template (protocol/README): a string that is exactly "{{name}}" becomes that
 * parameter's value with its type; {{name}} inside a longer string is replaced by its text.
 */
export function instantiate(template: unknown, params: Record<string, unknown>, missing: Set<string> = new Set()): unknown {
  const fill = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = WHOLE.exec(v);
      if (whole) {
        if (!(whole[1] in params)) missing.add(whole[1]);
        return params[whole[1]];
      }
      return v.replace(PART, (_, k: string) => {
        if (!(k in params)) missing.add(k);
        const p = params[k];
        return p === undefined ? "" : typeof p === "string" ? p : JSON.stringify(p);
      });
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(template);
}

/** The parameter names a template uses. */
export function placeholders(template: unknown): Set<string> {
  const names = new Set<string>();
  JSON.stringify(template).replace(PART, (_, k: string) => (names.add(k), ""));
  return names;
}

/**
 * Applies ops to a fresh, empty kernel Space as a stand-in Agent: the strongest check there is,
 * because it is the same code that will run them for real. Returns the kernel's result.
 */
export function tryOps(ops: unknown[]): { ok: boolean; errors: { op?: number; code: string; msg: string; fix: string }[]; lints: any[]; repaired: string[] } {
  const norm = normalizeOps(ops);
  if (norm.errors.length) return { ok: false, errors: norm.errors, lints: [], repaired: norm.repaired };
  const space = Space.create("extension-check", "space", randomBytes(16).toString("hex"));
  const r = JSON.parse(space.applyAgentBatch("a_check", "r_check", JSON.stringify({ ops: norm.ops }), Date.now()));
  return { ok: Boolean(r.ok), errors: r.errors ?? [], lints: r.lints ?? [], repaired: [...norm.repaired, ...(r.repaired ?? [])] };
}

export function checkRecipe(r: RecipeExt): Problem[] {
  const out: Problem[] = [];
  checkName(r.name, r.summary, out);
  const validate = checkParams(r.params, out);
  if (!Array.isArray(r.template) || !r.template.length) {
    out.push(err("invalid_template", "The template is not a list of apply ops.", 'Write the template as a JSON list of ops, such as [{"op": "add", "type": "note", "text": "{{text}}"}].', "/template"));
    return out;
  }
  if (r.template.length > 500) out.push(err("too_large", `The template has ${r.template.length} ops.`, "Keep a Recipe to at most 500 ops.", "/template"));
  if (r.template.some((op: any) => op?.op === "define"))
    out.push(err("invalid_template", "The template contains a define op.", "A Recipe adds Elements; save other Recipes with their own define.", "/template"));
  const declared = new Set(Object.keys((r.params as any)?.properties ?? {}));
  for (const p of placeholders(r.template))
    if (!declared.has(p)) out.push(err("unknown_param", `The template uses {{${p}}}, which params doesn't declare.`, `Add "${p}" to params.properties, or fix the placeholder's spelling.`, "/template"));
  for (const p of declared)
    if (!placeholders(r.template).has(p)) out.push(warn("unused_param", `params declares '${p}', which the template never uses.`, `Use {{${p}}} in the template, or remove it from params.`, "/params"));
  if (!r.guide?.trim()) out.push(warn("missing_guide", "There is no guide.", "Add a short guide: when to use it and what each parameter does. read_me(name) shows it.", "/guide"));
  if (!validate || out.some((p) => p.level === "error")) return out;

  const params = r.example ?? exampleParams(r.params as Record<string, any>);
  if (!validate(params))
    out.push(err("invalid_example", `The example parameters don't match params: ${ajv.errorsText(validate.errors)}.`, "Fix the example, or the params schema.", "/example"));
  const ops = instantiate(r.template, params) as unknown[];
  const tried = tryOps(ops);
  for (const e of tried.errors) out.push(err(e.code, `With ${r.example ? "the example" : "made-up"} parameters, template op ${e.op ?? "?"}: ${e.msg}`, e.fix, `/template/${e.op ?? ""}`));
  for (const l of tried.lints) out.push(warn(`lint_${l.code}`, `With ${r.example ? "the example" : "made-up"} parameters: ${l.msg}`, l.fix ?? "", l.id ? `id ${l.id}` : undefined));
  return out;
}

// ---------- Embed Templates ----------

/** Every host an HTML file loads from: script, link, img and iframe sources, CSS url(), fetch, imports and sockets. */
export function hostsIn(html: string): { host: string; url: string; insecure: boolean }[] {
  const found = new Map<string, { host: string; url: string; insecure: boolean }>();
  const re = /(?:src|href|action)\s*=\s*["']?((?:https?|wss?):)?\/\/([^/"'\s>]+)[^"'\s>]*|url\(\s*["']?((?:https?:)?\/\/([^/"')\s]+)[^"')\s]*)|(?:fetch|import|new\s+WebSocket|new\s+EventSource|importScripts)\s*\(\s*["'`]((?:https?|wss?):\/\/([^/"'`\s]+)[^"'`\s]*)|from\s+["']((?:https?):\/\/([^/"'\s]+)[^"'\s]*)/gi;
  for (const m of html.matchAll(re)) {
    const host = (m[2] ?? m[4] ?? m[6] ?? m[8] ?? "").toLowerCase().replace(/:\d+$/, "");
    const url = m[0];
    if (!host) continue;
    const insecure = /^(?:src|href|action)/i.test(url) ? (m[1] ?? "").startsWith("http:") || (m[1] ?? "").startsWith("ws:") : /(?:^|["'`(])(?:http|ws):\/\//i.test(url);
    if (!found.has(host) || insecure) found.set(host, { host, url: url.slice(0, 120), insecure });
  }
  return [...found.values()];
}

export function checkEmbed(e: EmbedExt): Problem[] {
  const out: Problem[] = [];
  checkName(e.name, e.summary, out);
  const validate = checkParams(e.params, out);
  const html = e.template;
  if (typeof html !== "string" || !html.trim()) {
    out.push(err("invalid_template", "The template is not an HTML file.", "Put the Embed's whole HTML (with its scripts) in template.", "/template"));
    return out;
  }
  if (html.length > 200_000) out.push(err("too_large", `The template is ${html.length} characters.`, "Keep an Embed Template under 200,000 characters; load libraries from an allowed CDN.", "/template"));
  if (!/<(html|body|div|canvas|svg|script|main|section)\b/i.test(html))
    out.push(err("invalid_template", "The template doesn't look like HTML.", "Write an HTML document or fragment, with the markup and scripts the Embed needs.", "/template"));
  const allow = new Set([...(e.allow ?? []), ...DEFAULT_ALLOW].map((h) => h.toLowerCase()));
  for (const h of e.allow ?? []) if (!/^[a-z0-9.-]{1,253}$/.test(h)) out.push(err("invalid_allow", `'${h}' in allow is not a host name.`, "List bare host names, such as 'api.example.com'.", "/allow"));
  for (const { host, url, insecure } of hostsIn(html)) {
    if (insecure) out.push(err("insecure_url", `The template loads ${url} over plain HTTP.`, "Use https:// (or wss://); Embeds never load anything unencrypted.", "/template"));
    else if (!allow.has(host) && ![...allow].some((a) => host.endsWith(`.${a}`)))
      out.push(err("blocked_host", `The template loads from ${host}, which isn't allowed: ${url}`, `Add "${host}" to allow, or load it from an approved CDN (${DEFAULT_ALLOW.join(", ")}).`, "/allow"));
  }
  // An MCP App view talks to window.parent by design; the bridge is that parent.
  if (!e.source && /\b(window\.parent|window\.top|top\.location|parent\.postMessage)\b/.test(html))
    out.push(err("outside_bridge", "The template reaches for the page around it (window.parent or window.top).", "Talk to Reflex only through the reflex bridge: reflex.element, reflex.notify, reflex.emit, reflex.panel and reflex.anchors.", "/template"));
  if (/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(html))
    out.push(warn("storage", "The template uses browser storage, which an Embed doesn't keep (its data store is nonpersistent).", "Save state with reflex.element.setState(patch); it syncs to every device and survives reloads.", "/template"));
  if (e.source && !/^ui:\/\/[^/\s]+/.test(e.source)) out.push(err("invalid_source", `source ${JSON.stringify(e.source)} is not a 'ui://' resource URI.`, "Set source to the MCP App resource the template came from, such as ui://weather/forecast.", "/source"));
  if (!e.source && !/reflex\.anchors\.register\s*\(/.test(html))
    out.push(warn("no_anchors", "The template registers no Anchors, so a Mark on it comes back as pixel coordinates only.", "Call reflex.anchors.register({ resolve(region) { return { kind: 'data', rows: [...] } } }) so Marks say what they point at.", "/template"));
  // An MCP App view gets its parameters as ui/notifications/tool-input, not props().
  if (!e.source && !/reflex\.element\.props\s*\(/.test(html) && Object.keys((e.params as any)?.properties ?? {}).length)
    out.push(warn("unused_params", "The template never reads its parameters.", "Read them with reflex.element.props().", "/template"));
  if (!e.guide?.trim()) out.push(warn("missing_guide", "There is no guide.", "Add a short guide: what the Embed shows, its parameters, and what its Anchors report. read_me(name) shows it.", "/guide"));
  if (validate) {
    const params = e.example ?? exampleParams(e.params as Record<string, any>);
    if (!validate(params)) out.push(err("invalid_example", `The example parameters don't match params: ${ajv.errorsText(validate.errors)}.`, "Fix the example, or the params schema.", "/example"));
  }
  return out;
}

// ---------- Guides ----------

export function checkGuide(g: GuideExt): Problem[] {
  const out: Problem[] = [];
  checkName(g.name, g.summary, out);
  if (!g.text?.trim()) out.push(err("empty_guide", "The guide has no text.", "Write the guide in Markdown below the front matter.", "/text"));
  else {
    if (g.text.length > 100_000) out.push(err("too_large", `The guide is ${g.text.length} characters.`, "Keep a guide under 100,000 characters; split it into several.", "/text"));
    if (!/^#\s/m.test(g.text)) out.push(warn("no_heading", "The guide has no top-level heading.", "Start it with '# <title>'.", "/text"));
    if (!/```/.test(g.text)) out.push(warn("no_example", "The guide has no example.", "Show one apply batch in a fenced ```json block; Agents copy examples.", "/text"));
  }
  return out;
}
