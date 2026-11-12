#!/usr/bin/env node
// Runs a Reflex Protocol v1 conformance profile against an implementation.
//
//   node tests/conformance/run.ts <profile> [--impl "<command>"] [--url <url>] [--role <role>]
//   node tests/conformance/run.ts --reflex [profile...]    Reflex's own implementations, every profile
//
// Profiles and what each needs are in tests/conformance/README.md.
import { parseArgs } from "node:util";
import { driver } from "./lib/driver.ts";
import { Report } from "./lib/report.ts";

const { values: f, positionals } = parseArgs({
  allowPositionals: true,
  options: { impl: { type: "string" }, url: { type: "string" }, role: { type: "string" }, reflex: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});

const HELP = `Usage: node tests/conformance/run.ts <profile> [--impl "<command>"] [--url <url>] [--role <role>]
       node tests/conformance/run.ts --reflex [profile...]

Profiles:
  kernel        a Space engine                         --impl: a driver (README "kernel")
  viewer        a client that shows Spaces             --impl: a driver (README "viewer")
  drawing       a client that writes Ink and Sends     --impl: a driver (README "drawing")
  send-adapter  --role receiver: a webhook receiver    --impl: a driver, or --url and REFLEX_WEBHOOK_SECRET
                --role sender: something that pushes   --impl: a driver (README "send-adapter")
  relay         a Relay                                --impl: a driver, or --url: its http(s) origin
`;

const here = (p: string) => new URL(p, import.meta.url).pathname;
const node = process.execPath;

/** Reflex's own implementation of each profile (tests/conformance/impl/). */
const REFLEX: Record<string, { impl?: string; url?: string; role?: string; what: string }[]> = {
  kernel: [{ impl: `${node} ${here("impl/kernel.ts")}`, what: "Reflex kernel (WASM)" }],
  viewer: [{ impl: `${node} ${here("impl/web-viewer.ts")}`, what: "Reflex web viewer (apps/web, headless Chrome)" }],
  drawing: [{ impl: `${node} ${here("impl/link-device.ts")}`, what: "Reflex Link (reflex link --dev), drawing as its person" }],
  "send-adapter": [
    { role: "sender", impl: `${node} ${here("impl/link-webhook.ts")}`, what: "Reflex Link's webhook adapter" },
    { role: "receiver", impl: `${node} ${here("impl/webhook-receiver.ts")}`, what: "agent/examples/webhook-claude.ts" },
  ],
  relay: [
    { impl: `${node} ${here("impl/relay-node.ts")}`, what: "Reflex Relay on Node (relay/node)" },
    { impl: `${node} ${here("impl/relay-worker.ts")}`, what: "Reflex Relay on Cloudflare Workers (relay/cloudflare, local wrangler dev)" },
  ],
};

async function one(profile: string, o: { impl?: string; url?: string; role?: string; what: string }): Promise<number> {
  process.stdout.write(`\n${profile}${o.role ? ` (${o.role})` : ""}: ${o.what}\n`);
  const report = new Report(profile, o.what);
  const mod = await import(`./profiles/${profile}.ts`);
  const d = o.impl ? driver(o.impl) : null;
  try {
    await mod.run(d, report, o);
  } catch (e) {
    report.check("the run finished", [(e as Error).stack ?? String(e)]);
  } finally {
    await d?.close();
  }
  if (report.failed && d?.log.length) process.stdout.write(`  implementation log (last 15 lines):\n${d.log.slice(-15).map((l) => `    ${l}`).join("\n")}\n`);
  process.stdout.write(`  ${report.checks.length - report.failed}/${report.checks.length} checks passed\n`);
  return report.failed;
}

async function main(): Promise<number> {
  if (f.help || (!f.reflex && !positionals.length)) return void process.stdout.write(HELP), 2;
  if (f.reflex) {
    let failed = 0;
    for (const p of positionals.length ? positionals : Object.keys(REFLEX))
      for (const o of REFLEX[p] ?? []) failed += await one(p, o);
    process.stdout.write(`\n${failed ? `${failed} check(s) failed` : "every profile passed"}\n`);
    return failed ? 1 : 0;
  }
  const [profile] = positionals;
  if (!REFLEX[profile]) return void process.stderr.write(`Unknown profile '${profile}'.\n${HELP}`), 2;
  return (await one(profile, { impl: f.impl, url: f.url, role: f.role, what: f.impl ?? f.url ?? "?" })) ? 1 : 0;
}

process.exitCode = await main();
