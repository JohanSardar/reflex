// S2: an extension Element type may be named with an underscore
// (element.schema.json extension.type: ^[a-z][a-z0-9_-]{0,39}$), and the server
// instructions tell the Agent to call read_me with a type's name before using it.
// read_me's topic pattern forbids the underscore, so that guide can never be read.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
for (const file of readdirSync(join(root, "schema")).filter((f) => f.endsWith(".schema.json")))
  ajv.addSchema(JSON.parse(readFileSync(join(root, "schema", file), "utf8")));

const element = /** @type {any} */ (ajv.getSchema("https://reflex.eilmer.si/protocol/v1/element.schema.json"));
const readMe = /** @type {any} */ (ajv.getSchema("https://reflex.eilmer.si/protocol/v1/read_me.input.schema.json"));

const type = "plate_map";
const el = { id: "pm", type, type_version: 1, owner: { agent: "a_cc7", name: "Claude Code" }, bounds: [0, 0, 10, 10], props: { wells: 96 } };

if (!element(el)) {
  console.log(`not a bug: '${type}' is not a valid Element type: ${ajv.errorsText(element.errors)}`);
  process.exit(0);
}
if (!readMe({ topic: type })) {
  console.log(`FAIL read_me({topic: '${type}'}): ${ajv.errorsText(readMe.errors)}`);
  console.log(`'${type}' is a valid Element type, so its guide cannot be read.`);
  process.exit(1);
}
console.log(`read_me accepts the valid Element type name '${type}'`);
