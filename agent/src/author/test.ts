// `reflex test [<path>]`: the contract checks for one extension's kind, then
// every conformance example saved for it from `reflex dev`, replayed on a
// fresh in-memory Space: the same strokes must still give the same Marks on
// the same targets.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { examples, load, type Loaded } from "../extensions/files.ts";
import type { Problem } from "../extensions/checks.ts";
import { Sandbox } from "./sandbox.ts";

const common = JSON.parse(readFileSync(new URL("../../../protocol/schema/common.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(common);
const validateAnchor = ajv.compile({ $ref: `${common.$id}#/$defs/anchor` });

export type ExampleResult = { file: string; ok: boolean; problems: string[] };
export type TestReport = { ok: boolean; kind: string; name: string; path: string; problems: Problem[]; examples: ExampleResult[] };

const pick = (m: Record<string, unknown>) => JSON.stringify({ kind: m.kind, on: m.on, near: m.near, from: m.from, to: m.to });

async function replay(l: Loaded, file: string, ex: Record<string, any>): Promise<ExampleResult> {
  const problems: string[] = [];
  if (ex.extension !== l.ext.name) problems.push(`it is for '${ex.extension}', not '${l.ext.name}'`);
  if (!Array.isArray(ex.strokes) || !ex.strokes.length) problems.push("it has no strokes");
  if (problems.length) return { file, ok: false, problems };
  const box = await new Sandbox(l).start();
  for (const s of ex.strokes) box.stroke(s);
  const got = await box.send({ said: ex.said });
  const want: Record<string, unknown>[] = ex.expect?.marks ?? [];
  const marks: Record<string, unknown>[] = got.bundle.marks ?? [];
  if (marks.length !== want.length) problems.push(`expected ${want.length} Marks, got ${marks.length}: ${marks.map((m) => `${m.id} ${m.kind}`).join(", ") || "none"}`);
  want.forEach((w, i) => {
    const m = marks[i];
    if (m && pick(m) !== pick(w)) problems.push(`${w.id ?? `mark ${i + 1}`}: expected ${pick(w)}, got ${pick(m)}`);
  });
  // An Embed's Anchors are answered by its code in a browser; here each saved answer must still be a valid Anchor.
  for (const a of ex.expect?.anchors ?? []) if (!validateAnchor(a.anchor)) problems.push(`the Anchor saved for ${a.mark ?? a.element} is not a valid Anchor: ${ajv.errorsText(validateAnchor.errors)}`);
  return { file, ok: !problems.length, problems };
}

export async function test(path: string): Promise<TestReport> {
  const l = load(path);
  const box = await new Sandbox(l).start();
  const results: ExampleResult[] = [];
  for (const { file, example } of examples(l)) results.push(await replay(l, file, example));
  const problems = box.checks;
  return { ok: !problems.some((p) => p.level === "error") && results.every((r) => r.ok), kind: l.ext.kind, name: l.ext.name, path: l.path, problems, examples: results };
}

export function report(r: TestReport): string[] {
  const errors = r.problems.filter((p) => p.level === "error");
  const warnings = r.problems.filter((p) => p.level === "warning");
  const lines = [`${r.ok ? "✓" : "✗"} ${r.kind} ${r.name}: ${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}, ${r.examples.filter((e) => e.ok).length}/${r.examples.length} examples pass`];
  for (const p of r.problems) lines.push(`  ${p.level} ${p.code}${p.where ? ` (${p.where})` : ""}: ${p.msg}`, `    fix: ${p.fix}`);
  for (const e of r.examples) {
    lines.push(`  ${e.ok ? "✓" : "✗"} example ${e.file}`);
    for (const p of e.problems) lines.push(`    ${p}`);
  }
  return lines;
}
