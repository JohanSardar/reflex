// @ts-check
// Generates the kernel's Rust serde types from schema/ (ARCHITECTURE §9).
//
//   node scripts/gen-rust.mjs           fail if generated/rust/protocol.rs is stale
//   node scripts/gen-rust.mjs --write   rewrite it
//
// The output covers the shape of every message: field names, types, required
// fields, string enums, closed objects (deny_unknown_fields) and the oneOf
// unions. Patterns, lengths and ranges are not expressed in Rust; the Agent
// layer checks them with Ajv against the same schemas before the kernel runs.
//
// A oneOf becomes an enum with a generated `parse` that picks the variant from
// its `const` fields (and `not: {enum}` for the extension fallback), so a
// mistake is reported against the one variant the caller meant, not all of them.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "schema");
const outFile = join(root, "generated", "rust", "protocol.rs");
const write = process.argv.includes("--write");

/** @type {Map<string, any>} */
const schemas = new Map();
for (const f of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort())
  schemas.set(f, JSON.parse(readFileSync(join(schemaDir, f), "utf8")));

const KEYWORDS = new Set(
  "as async await break const continue crate do dyn else enum extern false final fn for if impl in let loop macro match mod move mut override priv pub ref return self static struct super trait true try type typeof unsafe unsized use virtual where while yield abstract become box gen".split(" "),
);
const pascal = (/** @type {string} */ s) =>
  s.replace(/\.schema\.json$/, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const fieldName = (/** @type {string} */ s) => (KEYWORDS.has(s) ? `r#${s}` : s);
const variantName = (/** @type {string} */ s) => {
  const p = pascal(s);
  return /^[0-9]/.test(p) ? `V${p}` : p || "Empty";
};

/** Resolve a $ref from `file`. */
function deref(/** @type {string} */ file, /** @type {string} */ ref) {
  const [path, pointer = ""] = ref.split("#");
  const target = path || file;
  let node = schemas.get(target);
  for (const part of pointer.split("/").filter(Boolean)) node = node[part];
  if (node === undefined) throw new Error(`${file}: unresolved ${ref}`);
  return { file: target, node, key: `${target}#${pointer}` };
}

/** Follow refs that only rename another schema (a $ref plus annotations). */
function follow(/** @type {string} */ file, /** @type {any} */ node) {
  let key = null;
  while (node && typeof node.$ref === "string") {
    const t = deref(file, node.$ref);
    file = t.file;
    node = t.node;
    key = t.key;
  }
  return { file, node, key };
}

/** @type {Map<string, string>} schema key -> Rust type name */
const named = new Map();
/** @type {Set<string>} */
const usedNames = new Set();
/** @type {string[]} */
const items = [];

// Shorter names for a few deep paths.
const RENAME = [
  ["ApplyInputOpsItem", "Op"],
  ["ErrorError", "ErrorItem"],
];

function claim(/** @type {string} */ want, /** @type {string} */ file) {
  for (const [from, to] of RENAME) if (want.startsWith(from)) want = to + want.slice(from.length);
  let name = want;
  if (usedNames.has(name)) name = pascal(file) + want;
  let n = 2;
  while (usedNames.has(name)) name = `${want}${n++}`;
  usedNames.add(name);
  return name;
}

const doc = (/** @type {any} */ node, /** @type {string} */ indent = "") =>
  node && typeof node.description === "string"
    ? node.description.split("\n").map((/** @type {string} */ l) => `${indent}/// ${l}`.trimEnd()).join("\n") + "\n"
    : "";

/**
 * The Rust type for a schema node. Named types are emitted once.
 * @param {string} file
 * @param {any} node
 * @param {string} hint  name to use if the node needs its own type
 * @param {string | null} key  schema key when the node is a $defs entry or a file root
 * @returns {string}
 */
function rustType(file, node, hint, key = null) {
  if (typeof node.$ref === "string") {
    const t = follow(file, node);
    const pointer = /** @type {string} */ (t.key).split("#")[1];
    const hint = pointer ? pascal(/** @type {string} */ (pointer.split("/").pop())) : pascal(t.file);
    return rustType(t.file, t.node, hint, t.key);
  }
  if (key && named.has(key)) return /** @type {string} */ (named.get(key));
  if (node.oneOf) return emitUnion(file, node, hint, key);
  if (node.const !== undefined) return typeof node.const === "string" ? "String" : typeof node.const === "boolean" ? "bool" : "i64";
  if (node.enum && node.type === "string") return emitEnum(node, hint, key, file);
  switch (node.type) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "integer":
      return "i64";
    case "number":
      return "f64";
    case "array": {
      if (node.prefixItems) {
        const parts = node.prefixItems.map((/** @type {any} */ p, /** @type {number} */ i) => rustType(file, p, `${hint}${i}`));
        if (parts.every((/** @type {string} */ p) => p === parts[0])) return `[${parts[0]}; ${parts.length}]`;
        return `(${parts.join(", ")})`;
      }
      if (!node.items || Object.keys(node.items).length === 0) return "Vec<Value>";
      return `Vec<${rustType(file, node.items, `${hint}Item`)}>`;
    }
    case "object":
      if (node.properties) return emitStruct(file, node, hint, key);
      if (node.additionalProperties && typeof node.additionalProperties === "object")
        return `BTreeMap<String, ${rustType(file, node.additionalProperties, `${hint}Value`)}>`;
      return "Map<String, Value>";
    default:
      return "Value";
  }
}

function emitEnum(/** @type {any} */ node, /** @type {string} */ hint, /** @type {string|null} */ key, /** @type {string} */ file) {
  const name = claim(hint, file);
  if (key) named.set(key, name);
  const variants = node.enum.map((/** @type {string} */ v) => `    #[serde(rename = ${JSON.stringify(v)})]\n    ${variantName(v)},`);
  const strs = node.enum.map((/** @type {string} */ v) => `            ${name}::${variantName(v)} => ${JSON.stringify(v)},`);
  items.push(
    `${doc(node)}#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]\npub enum ${name} {\n${variants.join("\n")}\n}\n\n` +
      `impl ${name} {\n    pub const ALL: &'static [&'static str] = &[${node.enum.map((/** @type {string} */ v) => JSON.stringify(v)).join(", ")}];\n` +
      `    pub fn as_str(&self) -> &'static str {\n        match self {\n${strs.join("\n")}\n        }\n    }\n}\n`,
  );
  return name;
}

function emitStruct(/** @type {string} */ file, /** @type {any} */ node, /** @type {string} */ hint, /** @type {string|null} */ key) {
  const name = claim(hint, file);
  if (key) named.set(key, name);
  const required = new Set(node.required ?? []);
  const fields = [];
  for (const [prop, sub] of Object.entries(node.properties)) {
    let t = rustType(file, /** @type {any} */ (sub), name + pascal(prop));
    const attrs = [];
    if (!/^r#/.test(fieldName(prop)) && fieldName(prop) !== prop) attrs.push(`rename = ${JSON.stringify(prop)}`);
    if (!required.has(prop)) {
      t = `Option<${t}>`;
      attrs.push(`default`, `skip_serializing_if = "Option::is_none"`);
    }
    const shown = follow(file, sub).node;
    const d = doc(/** @type {any} */ (sub).description ? sub : shown, "    ");
    fields.push(`${d}${attrs.length ? `    #[serde(${attrs.join(", ")})]\n` : ""}    pub ${fieldName(prop)}: ${t},`);
  }
  const deny = node.additionalProperties === false ? "\n#[serde(deny_unknown_fields)]" : "";
  items.push(`${doc(node)}#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]${deny}\npub struct ${name} {\n${fields.join("\n")}\n}\n`);
  return name;
}

/** The discriminating constants of a oneOf variant. */
function discriminators(/** @type {string} */ file, /** @type {any} */ v) {
  const node = follow(file, v).node;
  /** @type {{prop: string, is?: any, notIn?: any[]}[]} */
  const out = [];
  for (const [prop, sub] of Object.entries(node.properties ?? {})) {
    const s = /** @type {any} */ (sub);
    if (s.const !== undefined) out.push({ prop, is: s.const });
    else if (s.not?.enum) out.push({ prop, notIn: s.not.enum });
  }
  return out;
}

function emitUnion(/** @type {string} */ file, /** @type {any} */ node, /** @type {string} */ hint, /** @type {string|null} */ key) {
  const name = claim(hint, file);
  if (key) named.set(key, name);
  /** @type {Variant[]} */
  const variants = node.oneOf.map((/** @type {any} */ v, /** @type {number} */ i) => {
    const target = follow(file, v);
    const title = v.title ?? target.node.title ?? `variant ${i}`;
    const vname = variantName(title);
    const t = rustType(file, v, `${name}${vname}`);
    return { vname, t, title, disc: discriminators(file, v), props: Object.keys(target.node.properties ?? {}) };
  });
  // Variants with more discriminators are tried first; one without any is the fallback.
  const order = [...variants].sort((a, b) => b.disc.length - a.disc.length);
  /** @typedef {{ vname: string, t: string, title: string, disc: {prop: string, is?: any, notIn?: any[]}[], props: string[] }} Variant */
  const conds = (/** @type {Variant} */ v) =>
    v.disc
      .map((/** @type {Variant["disc"][number]} */ d) =>
        d.is !== undefined
          ? `o.get(${JSON.stringify(d.prop)}) == Some(&json!(${JSON.stringify(d.is)}))`
          : `o.get(${JSON.stringify(d.prop)}).and_then(Value::as_str).is_some_and(|s| ![${(d.notIn ?? []).map((/** @type {any} */ x) => JSON.stringify(x)).join(", ")}].contains(&s))`,
      )
      .join(" && ") || "true";
  const arms = order
    .map((v) => `        if ${conds(v)} {\n            return serde_json::from_value(value.clone()).map(${name}::${v.vname}).map_err(|e| UnionError::Invalid { variant: ${JSON.stringify(v.title)}, error: e.to_string() });\n        }`)
    .join("\n");
  // What the caller can be told when nothing matches: each discriminating field's options.
  /** @type {Map<string, string[]>} */
  const options = new Map();
  for (const v of variants) for (const d of v.disc) if (d.is !== undefined) options.set(d.prop, [...new Set([...(options.get(d.prop) ?? []), String(d.is)])]);
  const optionList = [...options].map(([p, vs]) => `${p}: ${vs.join(", ")}`).join("; ");
  items.push(
    `${doc(node)}#[derive(Clone, Debug, PartialEq, Serialize)]\n#[serde(untagged)]\npub enum ${name} {\n${variants.map((v) => `    /// ${v.title}\n    ${v.vname}(${v.t}),`).join("\n")}\n}\n\n` +
      `impl ${name} {\n    /// Picks the variant from its discriminating fields, then checks it.\n    pub fn parse(value: &Value) -> Result<Self, UnionError> {\n        let Some(o) = value.as_object() else {\n            return Err(UnionError::NotAnObject);\n        };\n${arms}\n        Err(UnionError::NoVariant { options: ${JSON.stringify(optionList)} })\n    }\n}\n\n` +
      `/// Each variant's title and the fields it accepts.\npub const ${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_FIELDS: &[(&str, &[&str])] = &[\n${variants.map((v) => `    (${JSON.stringify(v.title)}, &[${v.props.map((p) => JSON.stringify(p)).join(", ")}]),`).join("\n")}\n];\n\n` +
      `impl<'de> Deserialize<'de> for ${name} {\n    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {\n        let v = Value::deserialize(d)?;\n        ${name}::parse(&v).map_err(serde::de::Error::custom)\n    }\n}\n`,
  );
  return name;
}

// Every file root and every $defs entry gets a type.
for (const [file, schema] of schemas) {
  for (const [def, node] of Object.entries(schema.$defs ?? {})) {
    if (/** @type {any} */ (node).$ref) continue; // an alias: its target is emitted where it is defined
    rustType(file, node, pascal(def), `${file}#/$defs/${def}`);
  }
  if (schema.type || schema.oneOf) rustType(file, schema, pascal(file), `${file}#`);
}

const header = `// GENERATED by protocol/scripts/gen-rust.mjs from protocol/schema/. Do not edit.
// Run \`npm run gen:rust -w @reflex/protocol -- --write\` after a schema change.
//
// Shapes only: fields, types, required fields, enums, closed objects and oneOf
// unions. Patterns, lengths and ranges are checked by the Agent layer with Ajv.
// The kernel includes this file with include!, inside a module that allows
// dead_code, so it carries no inner attributes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// Why a value did not match a oneOf union.
#[derive(Clone, Debug, PartialEq)]
pub enum UnionError {
    NotAnObject,
    /// No variant's discriminating fields match. \`options\` lists the accepted values.
    NoVariant { options: &'static str },
    /// The discriminating fields picked \`variant\`, and the value does not fit it.
    Invalid { variant: &'static str, error: String },
}

impl std::fmt::Display for UnionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnionError::NotAnObject => write!(f, "expected an object"),
            UnionError::NoVariant { options } => write!(f, "matches no variant ({options})"),
            UnionError::Invalid { variant, error } => write!(f, "{variant}: {error}"),
        }
    }
}
`;
const out = header + "\n" + items.join("\n");

if (write) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, out);
  console.log(`wrote ${outFile} (${items.length} types)`);
} else if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== out) {
  console.error("generated/rust/protocol.rs is stale: run `npm run gen:rust -w @reflex/protocol -- --write`");
  process.exit(1);
} else {
  console.log(`generated/rust/protocol.rs is current (${items.length} types)`);
}
