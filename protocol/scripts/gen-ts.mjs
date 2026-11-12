// @ts-check
// Generates TypeScript types for every schema in schema/ (ARCHITECTURE §9).
//
//   node scripts/gen-ts.mjs           fail if generated/ts/protocol.d.ts is stale
//   node scripts/gen-ts.mjs --write   rewrite it
//
// One declaration file for clients, Send Adapters and Relays written in
// TypeScript. Names:
//   - each schema file's root:          SendBundle, ApplyInput, Session, Relay, …
//   - each $defs entry in common:       ElementId, Bounds, Anchor, …
//   - each $defs entry elsewhere:       <File><Def>, such as SessionPerson
//   - each oneOf variant of a root:     <File><Variant> (wire messages by their `t`: SessionSync,
//                                       RelayHello; others by their title)
// Shapes only, like the Rust types: patterns, lengths and ranges stay in the
// schemas, which validators check.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "schema");
const outFile = join(root, "generated", "ts", "protocol.d.ts");
const write = process.argv.includes("--write");

/** @type {Map<string, any>} */
const schemas = new Map();
for (const f of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort()) schemas.set(f, JSON.parse(readFileSync(join(schemaDir, f), "utf8")));

const pascal = (/** @type {string} */ s) =>
  s
    .replace(/\.schema\.json$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
const stem = (/** @type {string} */ file) => (file === "common.schema.json" ? "" : pascal(file));

/** Declared names by `<file>#<pointer>`. */
/** @type {Map<string, string>} */
const names = new Map();
const taken = new Set();
const claim = (/** @type {string} */ key, /** @type {string} */ want) => {
  let n = /^[0-9]/.test(want) ? `T${want}` : want;
  while (taken.has(n)) n += "_";
  taken.add(n);
  names.set(key, n);
  return n;
};
for (const [file, schema] of schemas) {
  if (file !== "common.schema.json") claim(`${file}#`, pascal(file));
  for (const def of Object.keys(schema.$defs ?? {})) claim(`${file}#/$defs/${def}`, stem(file) + pascal(def));
}
for (const [file, schema] of schemas)
  (schema.oneOf ?? []).forEach((/** @type {any} */ v, /** @type {number} */ i) => {
    const t = v.properties?.t?.const ?? v.properties?.intent?.const;
    claim(`${file}#/oneOf/${i}`, pascal(file) + pascal(typeof t === "string" ? t : (v.title ?? String(i))));
  });

const lit = (/** @type {unknown} */ v) => JSON.stringify(v);
const key = (/** @type {string} */ k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const doc = (/** @type {any} */ node, /** @type {string} */ pad) =>
  typeof node?.description === "string" ? `${pad}/** ${node.description.replace(/\*\//g, "*\\/").replace(/\n/g, `\n${pad} * `)} */\n` : "";

/**
 * The TypeScript type for one schema node.
 * @returns {string}
 */
function ts(/** @type {string} */ file, /** @type {any} */ node, /** @type {string} */ pad = "") {
  if (node === true || node === undefined) return "unknown";
  if (node === false) return "never";
  if (typeof node.$ref === "string") {
    const [path, pointer = ""] = node.$ref.split("#");
    const target = `${path || file}#${pointer}`;
    const n = names.get(target);
    if (n) return n;
    // A pointer into another schema's body: inline it.
    let t = schemas.get(path || file);
    for (const part of pointer.split("/").filter(Boolean)) t = t[part];
    return ts(path || file, t, pad);
  }
  if ("const" in node) return lit(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(lit).join(" | ");
  if (Array.isArray(node.oneOf)) return node.oneOf.map((/** @type {any} */ v) => ts(file, v, pad)).join(" | ");
  const types = node.type === undefined ? (node.properties ? ["object"] : []) : [node.type].flat();
  if (!types.length) return "unknown";
  return types
    .map((/** @type {string} */ t) => /** @type {string} */ (typeOf(t)))
    .join(" | ");

  /** @returns {string} */
  function typeOf(/** @type {string} */ t) {
      switch (t) {
        case "string":
          return "string";
        case "integer":
        case "number":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array": {
          if (Array.isArray(node.prefixItems)) {
            const head = node.prefixItems.map((/** @type {any} */ p) => ts(file, p, pad));
            const min = node.minItems ?? head.length;
            const parts = head.map((/** @type {string} */ h, /** @type {number} */ i) => (i < min ? h : `${h}?`));
            if (node.items !== false && node.items !== undefined) parts.push(`...${wrap(ts(file, node.items, pad))}[]`);
            return `[${parts.join(", ")}]`;
          }
          return `${wrap(ts(file, node.items, pad))}[]`;
        }
        case "object": {
          if (!node.properties) {
            const extra = node.additionalProperties;
            return extra && typeof extra === "object" ? `Record<string, ${ts(file, extra, pad)}>` : "Record<string, unknown>";
          }
          const req = new Set(node.required ?? []);
          const inner = pad + "  ";
          /** @type {string[]} */
          const fields = Object.entries(node.properties).map(([k, v]) => `${doc(v, inner)}${inner}${key(k)}${req.has(k) ? "" : "?"}: ${ts(file, v, inner)};`);
          return `{\n${fields.join("\n")}\n${pad}}`;
        }
        default:
          return "unknown";
      }
  }
}
const wrap = (/** @type {string} */ t) => (t.includes("|") ? `(${t})` : t);

const out = [
  "// GENERATED by protocol/scripts/gen-ts.mjs from protocol/schema/. Do not edit.",
  "// Run `npm run build -w @reflex/protocol` after a schema change.",
  "//",
  "// Reflex Protocol v1 as TypeScript types: shapes only. Patterns, lengths and ranges are in the",
  "// schemas; validate with them (Ajv, JSON Schema 2020-12).",
  "",
];
for (const [file, schema] of schemas) {
  out.push(`// ---------- ${file} ----------`, "");
  for (const [def, node] of Object.entries(schema.$defs ?? {})) out.push(`${doc(node, "")}export type ${names.get(`${file}#/$defs/${def}`)} = ${ts(file, node)};`, "");
  if (Array.isArray(schema.oneOf)) {
    const variants = schema.oneOf.map((/** @type {any} */ v, /** @type {number} */ i) => {
      const n = /** @type {string} */ (names.get(`${file}#/oneOf/${i}`));
      out.push(`${doc(v, "")}export type ${n} = ${ts(file, v)};`, "");
      return n;
    });
    out.push(`${doc(schema, "")}export type ${names.get(`${file}#`)} = ${variants.join(" | ")};`, "");
  } else if (file !== "common.schema.json") out.push(`${doc(schema, "")}export type ${names.get(`${file}#`)} = ${ts(file, schema)};`, "");
}
const text = out.join("\n");

if (write) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  console.log(`wrote ${outFile} (${taken.size} types)`);
} else if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== text) {
  console.error("generated/ts/protocol.d.ts is stale: run `npm run build -w @reflex/protocol`");
  process.exit(1);
} else console.log(`generated/ts/protocol.d.ts is current (${taken.size} types)`);
