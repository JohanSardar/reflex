// Protocol v1's schemas, for checking what an implementation says against them.
import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const dir = new URL("../../../protocol/schema/", import.meta.url);
const BASE = "https://reflex.eilmer.si/protocol/v1/";
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
for (const f of readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) ajv.addSchema(JSON.parse(readFileSync(new URL(f, dir), "utf8")));

/** Problems with `value` as a `<name>.schema.json` message, or none. */
export function invalid(name: string, value: unknown): string[] {
  const v = ajv.getSchema(`${BASE}${name}.schema.json`);
  if (!v) throw new Error(`no schema ${name}`);
  if (v(value)) return [];
  return (v.errors ?? []).slice(0, 5).map((e) => `${name}: ${e.instancePath || "/"} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""}`);
}

/** The variant of a oneOf message that names `t` (or `intent`), checked on its own so errors are about that one. */
export function invalidMessage(name: string, value: Record<string, unknown>): string[] {
  const schema = JSON.parse(readFileSync(new URL(`${name}.schema.json`, dir), "utf8"));
  const tag = value.t ?? value.intent;
  const i = (schema.oneOf as { properties?: Record<string, { const?: unknown }> }[]).findIndex((v) => v.properties?.t?.const === tag || v.properties?.intent?.const === tag);
  if (i < 0) return [`${name}: no message '${String(tag)}' in Protocol v1`];
  const id = `${BASE}${name}.schema.json#/oneOf/${i}`;
  const v = ajv.getSchema(id) ?? ajv.compile({ $ref: id });
  if (v(value)) return [];
  return (v.errors ?? []).slice(0, 5).map((e) => `${name} ${String(tag)}: ${e.instancePath || "/"} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""}`);
}
