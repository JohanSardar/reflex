// The protocol as the Agent layer uses it: the eleven tools with their
// hand-written text and generated input schemas, and Ajv validators for
// inputs, outputs and each apply op (ARCHITECTURE §9).
import { readFileSync, readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

const root = new URL("../../protocol/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const json = (path: string) => JSON.parse(read(path));

/** The eleven tools, in SPEC §11 order. The list is fixed (ADR-0006). */
export const TOOLS = [
  "list_spaces",
  "open_space",
  "read",
  "look",
  "apply",
  "exec",
  "wait_for_user",
  "read_me",
  "recipe",
  "request_attention",
  "revert",
] as const;
export type Tool = (typeof TOOLS)[number];

/** The tools this build implements: all eleven. */
export const IMPLEMENTED: ReadonlySet<Tool> = new Set(TOOLS);

export const instructions = read("tool-text/instructions.md").trim();
export const description = (tool: Tool) => read(`tool-text/${tool}.md`).trim();
export const inputSchema = (tool: Tool) => json(`generated/tools/${tool}.input.json`);

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
for (const f of readdirSync(new URL("schema/", root)).filter((f) => f.endsWith(".schema.json"))) ajv.addSchema(json(`schema/${f}`));
const BASE = "https://reflex.eilmer.si/protocol/v1/";
const schema = (name: string): ValidateFunction => {
  const v = ajv.getSchema(BASE + name + ".schema.json");
  if (!v) throw new Error(`no schema ${name}`);
  return v;
};

export const validateInput = (tool: Tool) => schema(`${tool}.input`);
export const validateOutput = (tool: Tool) => schema(`${tool}.output`);
export const validateError = schema("error");

// ---------- apply ops: one validator per oneOf variant ----------

type Variant = { title: string; consts: Record<string, unknown>; notIn: Record<string, unknown[]>; fields: string[]; validate: ValidateFunction };
const applySchema = json("schema/apply.input.schema.json");
const variants: Variant[] = applySchema.properties.ops.items.oneOf.map((v: any) => {
  const consts: Record<string, unknown> = {};
  const notIn: Record<string, unknown[]> = {};
  for (const [k, p] of Object.entries<any>(v.properties)) {
    if ("const" in p) consts[k] = p.const;
    if (p.not?.enum) notIn[k] = p.not.enum;
  }
  // Each variant compiled on its own, inside the apply schema so its relative $refs resolve.
  const validate = ajv.compile({ $ref: `${BASE}apply.input.schema.json#/properties/ops/items/oneOf/${applySchema.properties.ops.items.oneOf.indexOf(v)}` });
  return { title: v.title, consts, notIn, fields: Object.keys(v.properties), validate };
});

/** The built-in types an Agent can add. */
export const ADD_TYPES = variants.filter((v) => v.consts.op === "add" && typeof v.consts.type === "string").map((v) => v.consts.type as string);

/** The variant an op means, picked by its const fields, as the kernel does. */
export function variantOf(op: Record<string, unknown>): Variant | undefined {
  const ordered = [...variants].sort((a, b) => Object.keys(b.consts).length + Object.keys(b.notIn).length - (Object.keys(a.consts).length + Object.keys(a.notIn).length));
  return ordered.find(
    (v) =>
      Object.entries(v.consts).every(([k, c]) => op[k] === c) &&
      Object.entries(v.notIn).every(([k, list]) => typeof op[k] === "string" && !list.includes(op[k])),
  );
}

export type ProtocolError = { op?: number; field?: string; code: string; msg: string; fix: string };

/** Ajv errors as protocol errors, one per problem, each with a fix. */
export function explain(errors: ErrorObject[], where: string, fields: string[], op?: number): ProtocolError[] {
  const out: ProtocolError[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    const path = e.instancePath || "";
    const at = `${where}${path.replace(/\//g, ".")}`;
    let msg: string;
    let fix: string;
    let field = path || undefined;
    const p = e.params as any;
    switch (e.keyword) {
      case "additionalProperties":
        field = `${path}/${p.additionalProperty}`;
        msg = `${at} has no field '${p.additionalProperty}'.`;
        fix = path === "" && fields.length ? `Remove '${p.additionalProperty}'. Allowed: ${fields.join(", ")}.` : `Remove '${p.additionalProperty}'.`;
        break;
      case "required":
        field = `${path}/${p.missingProperty}`;
        msg = `${at} needs '${p.missingProperty}'.`;
        fix = `Add '${p.missingProperty}'.`;
        break;
      case "enum":
        msg = `${at} must be one of: ${p.allowedValues.join(", ")}.`;
        fix = `Use one of: ${p.allowedValues.join(", ")}.`;
        break;
      case "const":
        msg = `${at} must be ${JSON.stringify(p.allowedValue)}.`;
        fix = `Set it to ${JSON.stringify(p.allowedValue)}.`;
        break;
      case "pattern":
        msg = `${at} doesn't match ${p.pattern}.`;
        fix = /A-Za-z0-9\]\[A-Za-z0-9_\.:-\]/.test(p.pattern) ? "Use a short ID of letters, digits, '-', '_', '.' or ':', such as \"n-auth\"." : `Match the pattern ${p.pattern}.`;
        break;
      case "oneOf":
      case "not":
        continue; // reported through the branch errors
      default:
        msg = `${at} ${e.message}.`;
        fix = `Fix ${at}: it ${e.message}.`;
    }
    const key = `${field}|${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...(op === undefined ? {} : { op }), ...(field ? { field } : {}), code: "invalid_input", msg, fix });
  }
  return out;
}
