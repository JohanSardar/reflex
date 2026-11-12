// @ts-check
// Checks the Reflex Protocol schemas and examples, and writes generated/.
//
//   node scripts/check.mjs           check everything; fail if generated/ is stale
//   node scripts/check.mjs --write   check everything and rewrite generated/
//
// Checks:
//   1. every schema compiles under Ajv's strict mode (JSON Schema 2020-12)
//   2. the restricted subset from ARCHITECTURE §9 holds (see RULES below)
//   3. every example validates against the schema its file name points at,
//      and every message schema has at least one example
//   4. generated/ matches what the schemas produce
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "schema");
const exampleDir = join(root, "examples");
const generatedDir = join(root, "generated");
const write = process.argv.includes("--write");
const BASE = "https://reflex.eilmer.si/protocol/v1/";
const SAFE = 9007199254740991;

/** @type {string[]} */
const failures = [];
const fail = (/** @type {string} */ msg) => failures.push(msg);

// ---------- load ----------
/** @type {Map<string, any>} file name -> schema */
const schemas = new Map();
for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort()) {
  const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8"));
  if (schema.$id !== BASE + file) fail(`${file}: $id must be ${BASE + file}`);
  schemas.set(file, schema);
}

// ---------- 1. strict compile ----------
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
for (const schema of schemas.values()) ajv.addSchema(schema);
for (const [file, schema] of schemas) {
  try {
    ajv.getSchema(schema.$id) ?? fail(`${file}: did not compile`);
  } catch (e) {
    fail(`${file}: ${/** @type {Error} */ (e).message}`);
  }
}

// ---------- 2. restricted subset ----------
// RULES
//  - no anyOf, allOf, not (except `not: {enum}` to keep extension type names apart
//    from built-ins), if/then/else, patternProperties, $dynamicRef
//  - at most one level of oneOf on any path, following $refs
//  - no $ref cycles (no recursive schemas)
//  - every integer has a minimum and a maximum inside the shared safe range
//  - every object that declares properties closes itself with additionalProperties: false
const BANNED = ["anyOf", "allOf", "if", "then", "else", "patternProperties", "$dynamicRef", "$dynamicAnchor", "dependentSchemas"];

/** Resolve a $ref relative to the file it appears in. */
function resolve(/** @type {string} */ file, /** @type {string} */ ref) {
  const [path, pointer = ""] = ref.split("#");
  const target = path ? path : file;
  const schema = schemas.get(target);
  if (!schema) throw new Error(`${file}: unresolved $ref ${ref}`);
  let node = schema;
  for (const part of pointer.split("/").filter(Boolean)) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (node === undefined) throw new Error(`${file}: unresolved $ref ${ref}`);
  return { file: target, node, key: `${target}#${pointer}` };
}

/**
 * @param {string} file
 * @param {any} node
 * @param {string} where
 * @param {number} oneOfDepth
 * @param {string[]} refStack
 */
function walk(file, node, where, oneOfDepth, refStack) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(file, n, `${where}/${i}`, oneOfDepth, refStack));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const k of BANNED) if (k in node) fail(`${where}: '${k}' is outside the restricted subset`);
  if ("not" in node && !(Object.keys(node.not).length === 1 && Array.isArray(node.not.enum)))
    fail(`${where}: 'not' is only allowed as not: {enum: [...]}`);
  let depth = oneOfDepth;
  if ("oneOf" in node) {
    depth += 1;
    if (depth > 1) fail(`${where}: oneOf nested inside another oneOf (depth ${depth})`);
  }
  const types = [node.type].flat();
  if (types.includes("integer")) {
    const okMin = typeof node.minimum === "number" && node.minimum >= -SAFE;
    const okMax = typeof node.maximum === "number" && node.maximum <= SAFE;
    if (!okMin || !okMax) fail(`${where}: integer needs minimum and maximum inside ±${SAFE}`);
  }
  if (node.properties && node.additionalProperties !== false)
    fail(`${where}: an object with properties must set additionalProperties: false`);
  if (typeof node.$ref === "string") {
    const target = resolve(file, node.$ref);
    if (refStack.includes(target.key)) fail(`${where}: recursive $ref ${node.$ref}`);
    else walk(target.file, target.node, `${where} -> ${target.key}`, depth, [...refStack, target.key]);
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" || k === "$defs" || k === "enum" || k === "const") continue;
    walk(file, v, `${where}/${k}`, depth, refStack);
  }
}
for (const [file, schema] of schemas) {
  if (file === "common.schema.json") continue; // its $defs are walked through the files that use them
  walk(file, schema, file, 0, [`${file}#`]);
}
// $defs nobody references are still checked on their own.
for (const [file, schema] of schemas)
  for (const [name, def] of Object.entries(schema.$defs ?? {})) walk(file, def, `${file}#/$defs/${name}`, 0, [`${file}#/$defs/${name}`]);

// ---------- 3. examples ----------
const messageSchemas = [...schemas.keys()].filter((f) => f !== "common.schema.json").map((f) => f.replace(/\.schema\.json$/, ""));
/** @type {Set<string>} */
const covered = new Set();
for (const file of readdirSync(exampleDir).filter((f) => f.endsWith(".json")).sort()) {
  const base = file.replace(/\.json$/, "");
  // examples/<schema>.json or examples/<schema>.<variant>.json; the longest matching schema name wins
  const name = messageSchemas.filter((s) => base === s || base.startsWith(s + ".")).sort((a, b) => b.length - a.length)[0];
  if (!name) {
    fail(`examples/${file}: no schema named by its file name`);
    continue;
  }
  covered.add(name);
  const validate = ajv.getSchema(BASE + name + ".schema.json");
  const data = JSON.parse(readFileSync(join(exampleDir, file), "utf8"));
  if (validate && !validate(data))
    for (const e of validate.errors ?? []) fail(`examples/${file}: ${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`);
  const tag = data?.t ?? data?.intent;
  if (typeof tag === "string") covered.add(`${name}#${tag}`);
  // A webhook delivery carries a Send Bundle whose images also hold their bytes.
  if (name === "webhook") {
    const bundle = { ...data.bundle, images: (data.bundle?.images ?? []).map((/** @type {any} */ { mime, data, ...img }) => img) };
    const v = ajv.getSchema(BASE + "send-bundle.schema.json");
    if (v && !v(bundle)) fail(`examples/${file}: bundle is not a Send Bundle: ${ajv.errorsText(v.errors)}`);
  }
}
for (const name of messageSchemas) if (!covered.has(name)) fail(`schema/${name}.schema.json has no example in examples/`);
// Wire schemas are a oneOf of messages told apart by `t` (user intents by `intent`): one example per message type.
for (const [file, schema] of schemas)
  for (const v of schema.oneOf ?? []) {
    const t = v.properties?.t?.const ?? v.properties?.intent?.const;
    const name = file.replace(/\.schema\.json$/, "");
    if (typeof t === "string" && !covered.has(`${name}#${t}`)) fail(`schema/${file}: message '${t}' has no example (examples/${name}.${t}.json)`);
  }

// ---------- 4. generated/ ----------
// Self-contained copies for surfaces that need one document per schema, such as an
// MCP tool's inputSchema: every $ref is rewritten to a local #/$defs entry.
function bundle(/** @type {string} */ file) {
  /** @type {Record<string, any>} */
  const defs = {};
  /** @type {Map<string, string>} */
  const names = new Map();
  const nameFor = (/** @type {string} */ key) => {
    if (names.has(key)) return /** @type {string} */ (names.get(key));
    const [f, p] = key.split("#");
    const stem = f.replace(/\.schema\.json$/, "").replace(/[^A-Za-z0-9]/g, "_");
    const tail = p ? p.split("/").filter((s) => s && s !== "$defs" && s !== "properties").join("_") : stem;
    const taken = new Set(names.values());
    let name = tail.replace(/[^A-Za-z0-9_]/g, "_");
    if (taken.has(name)) name = `${stem}_${name}`;
    while (taken.has(name)) name += "_";
    names.set(key, name);
    return name;
  };
  /** @returns {any} */
  const copy = (/** @type {string} */ from, /** @type {any} */ node) => {
    if (Array.isArray(node)) return node.map((n) => copy(from, n));
    if (node === null || typeof node !== "object") return node;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$defs" || k === "$id" || k === "$schema") continue;
      if (k === "$ref") {
        const target = resolve(from, v);
        const name = nameFor(target.key);
        if (!(name in defs)) {
          defs[name] = {};
          defs[name] = copy(target.file, target.node);
        }
        out.$ref = `#/$defs/${name}`;
      } else out[k] = k === "enum" || k === "const" ? v : copy(from, v);
    }
    return out;
  };
  const schema = schemas.get(file);
  const body = copy(file, schema);
  return {
    $schema: schema.$schema,
    ...body,
    ...(Object.keys(defs).length ? { $defs: Object.fromEntries(Object.entries(defs).sort()) } : {}),
  };
}

const tools = ["list_spaces", "open_space", "read", "look", "apply", "exec", "wait_for_user", "read_me", "recipe", "request_attention", "revert"];
/** @type {Map<string, string>} */
const generated = new Map();
for (const tool of tools)
  for (const dir of ["input", "output"]) {
    const file = `${tool}.${dir}.schema.json`;
    if (!schemas.has(file)) {
      fail(`schema/${file} is missing`);
      continue;
    }
    generated.set(`tools/${tool}.${dir}.json`, JSON.stringify(bundle(file), null, 2) + "\n");
  }
for (const file of ["error.schema.json", "send-bundle.schema.json", "element.schema.json"])
  generated.set(file.replace(".schema", ""), JSON.stringify(bundle(file), null, 2) + "\n");

// Each bundled schema must still compile and accept its examples.
for (const [path, text] of generated) {
  const lone = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  try {
    const validate = lone.compile(JSON.parse(text));
    const name = path.replace(/^tools\//, "").replace(/\.json$/, "");
    for (const ex of readdirSync(exampleDir).filter((f) => f === `${name}.json` || f.startsWith(`${name}.`))) {
      const data = JSON.parse(readFileSync(join(exampleDir, ex), "utf8"));
      if (!validate(data)) fail(`generated/${path}: rejects examples/${ex}: ${lone.errorsText(validate.errors)}`);
    }
  } catch (e) {
    fail(`generated/${path}: ${/** @type {Error} */ (e).message}`);
  }
}

for (const [path, text] of generated) {
  const full = join(generatedDir, path);
  if (write) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  } else if (!existsSync(full) || readFileSync(full, "utf8") !== text) {
    fail(`generated/${path} is stale; run: npm run build -w @reflex/protocol`);
  }
}

// ---------- tool text ----------
for (const tool of tools) if (!existsSync(join(root, "tool-text", `${tool}.md`))) fail(`tool-text/${tool}.md is missing`);
if (!existsSync(join(root, "tool-text", "instructions.md"))) fail("tool-text/instructions.md is missing");

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join("\n"));
  console.error(`\n${failures.length} problem(s).`);
  process.exit(1);
}
const exampleCount = readdirSync(exampleDir).filter((f) => f.endsWith(".json")).length;
console.log(`✓ ${schemas.size} schemas compile in strict mode and keep to the restricted subset`);
console.log(`✓ ${exampleCount} examples validate; every message schema has one`);
console.log(`✓ generated/ ${write ? "written" : "is up to date"} (${generated.size} files)`);
