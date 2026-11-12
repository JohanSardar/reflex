// The kernel profile: a Space engine (ARCHITECTURE §3). Every client embeds one;
// Reflex's is kernel/ (Rust, as WASM and UniFFI). It must converge, enforce
// ownership, and turn a person's strokes into the Marks the scenarios name.
//
// Traces: tests/traces/*.json (convergence, undo, Agent rules). Fixtures: the 13
// scenarios, each run over two replicas the way a Link and an iPad run it.
import { readdirSync, readFileSync } from "node:fs";
import type { Driver } from "../lib/driver.ts";
import { AGENT, compareMarks, intents, partial, PERSON, scenarios, stored, T0 } from "../lib/fixtures.ts";
import type { Report } from "../lib/report.ts";
import { invalid, invalidMessage } from "../lib/schemas.ts";

const TRACES = new URL("../../traces/", import.meta.url);
const DEVICE = "ipad-1";
/** What a person's own iPad may write (protocol/spec/membership.md §4). */
const IPAD = { people: [PERSON.id] };
const NOBODY = { people: [], agents: [] };

type R = Record<string, any>;

/** Syncs two replicas until both have nothing to send. `checked` gives b's writers check for what a sends. */
async function sync(k: Driver, a: string, b: string, checked?: { writers: unknown }): Promise<string[]> {
  for (let i = 0; i < 40; i++) {
    const m1 = (await k.call<{ msg: string | null }>("sync_message", { replica: a, peer: b })).msg;
    if (m1) {
      const r = await k.call<{ result?: R }>("receive", { replica: b, peer: a, msg: m1, ...(checked ? { writers: checked.writers } : {}) });
      if (r.result && r.result.ok === false) return [`${b} refused ${a}'s changes: ${JSON.stringify(r.result.errors ?? r.result)}`];
    }
    const m2 = (await k.call<{ msg: string | null }>("sync_message", { replica: b, peer: a })).msg;
    if (m2) await k.call("receive", { replica: a, peer: b, msg: m2 });
    if (!m1 && !m2) return [];
  }
  return [`sync between ${a} and ${b} did not settle in 40 rounds`];
}

async function converged(k: Driver, names: string[]): Promise<string[]> {
  const states = await Promise.all(names.map((n) => k.call<{ digest: string; heads: string[] }>("state", { replica: n })));
  return states.slice(1).flatMap((s, i) => (s.digest !== states[0].digest || JSON.stringify(s.heads) !== JSON.stringify(states[0].heads) ? [`${names[i + 1]} and ${names[0]} disagree`] : []));
}

const ids = async (k: Driver, r: string): Promise<string[]> => ((await k.call<{ result: R }>("scene", { replica: r })).result.elements as R[]).map((e) => e.id);

async function trace(k: Driver, file: string): Promise<string[]> {
  const t = JSON.parse(readFileSync(new URL(file, TRACES), "utf8"));
  const out: string[] = [];
  for (const r of t.replicas) await k.call("create", { replica: `${file}:${r}`, space: t.space });
  const rep = (r: string) => `${file}:${r}`;
  let now = 1_700_000_000_000;
  for (const [i, step] of (t.steps as R[]).entries()) {
    now += 1000;
    const at = `step ${i}`;
    if (step.sync) {
      for (let round = 0; round < 2; round++)
        for (let x = 0; x < step.sync.length; x++) for (let y = x + 1; y < step.sync.length; y++) out.push(...(await sync(k, rep(step.sync[x]), rep(step.sync[y]))));
    } else if (step.restart) await k.call("restart", { replica: rep(step.restart) });
    else if (step.converged) out.push(...(await converged(k, t.replicas.map(rep))).map((p) => `${at}: ${p}`));
    else if (step.agent) {
      const { result } = await k.call<{ result: R }>("agent", { replica: rep(step.on), agent: step.agent, request: step.request, batch: step.batch, now });
      out.push(...expectResult(result, step.expect).map((p) => `${at}: ${p}`));
    } else if (step.person) {
      const { result } = await k.call<{ result: R }>("intent", { replica: rep(step.on), person: step.person, device: step.device, intent: step.intent, now });
      out.push(...expectResult(result, step.expect).map((p) => `${at}: ${p}`));
    } else if (step.expect_present || step.expect_absent || step.expect_count !== undefined) {
      const have = await ids(k, rep(step.on));
      for (const w of step.expect_present ?? []) if (!have.includes(w)) out.push(`${at}: ${w} missing from ${have.join(", ")}`);
      for (const w of step.expect_absent ?? []) if (have.includes(w)) out.push(`${at}: ${w} still there`);
      if (step.expect_count !== undefined && have.length !== step.expect_count) out.push(`${at}: expected ${step.expect_count} Elements, got ${have.length}`);
    } else if (step.expect_text) {
      const els = (await k.call<{ result: R }>("scene", { replica: rep(step.on) })).result.elements as R[];
      for (const [id, text] of Object.entries(step.expect_text)) if (els.find((e) => e.id === id)?.text !== text) out.push(`${at}: ${id} should read ${JSON.stringify(text)}`);
    } else out.push(`${at}: unknown step ${JSON.stringify(step)}`);
  }
  return out;
}

function expectResult(r: R, want: R): string[] {
  const out: string[] = [];
  if (r.ok !== want.ok) out.push(`expected ok ${want.ok}, got ${JSON.stringify(r).slice(0, 300)}`);
  if (want.code && !(r.errors ?? []).some((e: R) => e.code === want.code)) out.push(`expected error ${want.code}, got ${JSON.stringify(r.errors ?? r).slice(0, 300)}`);
  if (want.duplicate !== undefined && r.duplicate !== want.duplicate) out.push(`expected duplicate ${want.duplicate}`);
  return out;
}

export async function run(k: Driver, report: Report): Promise<void> {
  for (const f of readdirSync(TRACES).filter((f) => f.endsWith(".json")).sort()) await report.run(`trace ${f}`, () => trace(k, f));

  for (const s of scenarios()) {
    const link = `${s.space}:link`;
    const ipad = `${s.space}:ipad`;
    await report.run(`scenario ${s.file}`, async () => {
      const out: string[] = [];
      await k.call("create", { replica: link, space: s.space });
      await k.call("create", { replica: ipad, space: s.space });
      // The Agent builds the Space on the Link.
      for (const [i, batch] of s.setup.entries()) {
        out.push(...invalid("apply.input", { space: s.space, ops: batch.ops }));
        const { result } = await k.call<{ result: R }>("agent", { replica: link, agent: AGENT, request: `setup-${i}`, batch, now: T0 });
        if (!result.ok) return [...out, `setup batch ${i} was rejected: ${JSON.stringify(result.errors)}`];
      }
      out.push(...(await sync(k, link, ipad)));
      const scene = (await k.call<{ result: R }>("scene", { replica: ipad, query: { detail: "full" } })).result;
      for (const e of scene.elements as R[]) out.push(...invalid("element", e).map((p) => `${e.id}: ${p}`));
      const have = (scene.elements as R[]).map((e) => e.id);
      for (const id of s.elements) if (!have.includes(stored(id))) out.push(`the iPad's replica has no ${stored(id)}`);

      let clock = T0;
      for (const step of s.sends) {
        // The person draws on the iPad, and presses Send there.
        const { steps, end } = intents(step.draw, clock);
        for (const { at, intent } of steps) {
          out.push(...invalidMessage("intent", intent));
          const { result } = await k.call<{ result: R }>("intent", { replica: ipad, person: PERSON.id, device: DEVICE, intent, now: at });
          if (!result.ok) out.push(`${String(intent.intent)} ${String(intent.id ?? "")} was refused: ${JSON.stringify(result.errors)}`);
        }
        out.push(...invalid("raw-send", step.raw).map((p) => `raw ${step.raw.send}: ${p}`));
        const { result: frozen } = await k.call<{ result: R }>("freeze", { replica: ipad, person: PERSON.id, device: DEVICE, raw: step.raw, now: end });
        if (frozen.ok === false) return [...out, `freeze_send refused ${step.raw.send}: ${JSON.stringify(frozen.errors)}`];
        out.push(...partial(step.expect.frozen ?? {}, frozen, `/frozen ${step.raw.send}`));
        // It reaches the Link, which checks it may come from the person's iPad, and groups the Marks there.
        out.push(...(await sync(k, ipad, link, { writers: IPAD })));
        const marks = (await k.call<{ result: R | null }>("marks", { replica: link, send: step.raw.send, viewer: { agent: AGENT } })).result;
        if (!marks) {
          out.push(`the Link has no Send ${step.raw.send}`);
          continue;
        }
        out.push(...compareMarks(step.expect, marks.marks).map((p) => `${step.raw.send}: ${p}`));
        clock = end;
      }
      out.push(...(await converged(k, [link, ipad])));
      return out;
    });
  }

  // A replica that may take nobody's changes (a web viewer's host) refuses the person's strokes.
  await report.run("a receiver with no writers refuses a person's strokes", async () => {
    const s = scenarios()[0];
    await k.call("create", { replica: "nobody", space: s.space });
    const problems = await sync(k, `${s.space}:ipad`, "nobody", { writers: NOBODY });
    return problems.some((p) => p.includes("refused")) ? [] : problems.length ? problems : ["the person's strokes were accepted by a receiver that allows no writers"];
  });
}
