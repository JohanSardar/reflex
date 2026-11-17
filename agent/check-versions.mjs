// Fails when the version isn't the same everywhere it is written: the root package.json, each package's,
// and the CLI's `reflex --version`. Run by `npm run check` and on every PR.
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const want = JSON.parse(read("package.json")).version;
const found = {
  ...Object.fromEntries(
    ["agent", "link", "relay"].map((p) => [`${p}/package.json`, JSON.parse(read(`${p}/package.json`)).version]),
  ),
  "agent/src/surfaces/cli.ts": /const VERSION = "([^"]+)"/.exec(read("agent/src/surfaces/cli.ts"))?.[1],
};
const wrong = Object.entries(found).filter(([, v]) => v !== want);
for (const [file, v] of wrong) console.error(`${file} says ${v ?? "nothing"}, package.json says ${want}`);
if (wrong.length) process.exit(1);
console.log(`version ${want} everywhere`);
