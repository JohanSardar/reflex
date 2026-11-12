// The Reflex Link as a Send Adapter sender: a real `reflex link --dev` in a fresh
// home with one approved Agent, which adds a webhook target (`reflex adapters add
// webhook`), builds each Space with `reflex elements apply`, and has the Link's
// person draw and press Send through the Link's admin RPC. The Link then pushes
// each Send to the runner's URL (link/adapters/webhook.ts).
//
//   node tests/conformance/run.ts send-adapter --role sender --impl "node tests/conformance/impl/link-webhook.ts"
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credential } from "../../../agent/src/host/rpc.ts";
import { home as homePaths, identity, localKey } from "../../../link/home.ts";
import { Catalog } from "../../../link/pairing/catalog.ts";
import { LinkClient } from "../../../link/rpc/client.ts";
import { openDb } from "../../../link/storage/db.ts";
import { serve } from "../lib/driver.ts";
import { sleep } from "../lib/host.ts";

const AGENT = "Conformance Agent";
const repo = new URL("../../../", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "reflex-conf-webhook-"));
const env = { ...process.env, REFLEX_HOME: home, REFLEX_AGENT_NAME: AGENT };
// The Agent is approved up front, the way the Link's terminal answers "y".
process.env.REFLEX_HOME = home;
identity(home);
localKey(home, "rpc.key");
localKey(home, "admin.key");
{
  const db = openDb(homePaths(home).db);
  const catalog = new Catalog(db, identity(home).key);
  catalog.decide(catalog.request(AGENT, credential(AGENT)).id, "approved", "terminal");
  db.close();
}
const link = spawn(process.execPath, [join(repo, "link/bin/reflex-link.ts"), "--home", home, "--dev", "--no-prompt", "--no-web", "--no-p2p", "--relay", "off", "--port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
link.stderr!.on("data", (d) => process.stderr.write(`link: ${d}`));

/** One `reflex` command as the Agent, which must succeed; its --json answer. */
function reflex(args: string[]): Record<string, any> {
  const r = spawnSync(process.execPath, [join(repo, "agent/bin/reflex.mjs"), ...args, "--json"], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`reflex ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

async function admin<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const c = await LinkClient.connect(home, "admin");
  try {
    return await c.call<T>(method, params);
  } finally {
    c.close();
  }
}

async function up(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await admin("status").then(() => true, () => false)) return;
    await sleep(250);
  }
  throw new Error("the Link never came up");
}
const ready = up();

serve({
  async target({ url }) {
    await ready;
    const j = reflex(["adapters", "add", "webhook", "--url", url]);
    return { secret: j.secret, target: j.target };
  },
  async space({ space, setup }) {
    await ready;
    reflex(["spaces", "create", space]);
    for (const [i, batch] of (setup as { ops: unknown[] }[]).entries()) {
      const r = reflex(["elements", "apply", space, "--input", JSON.stringify({ ops: batch.ops }), "--request", `${space}-setup-${i}`]);
      if (r.ok === false) throw new Error(`setup batch ${i}: ${JSON.stringify(r.errors ?? r)}`);
    }
    // How the person's side names the Agent's Elements: "<agent id>:<id>".
    const scene = await admin<{ elements: { id: string; by?: string }[] }>("space.read", { space });
    const agent = scene.elements.find((e) => e.id.includes(":"))?.id.split(":")[0] ?? "";
    return { agent };
  },
  async intent({ space, intent }) {
    const r = await admin<{ ok: boolean; errors?: unknown }>("dev.intent", { space, intent });
    if (!r.ok) throw new Error(`the Link refused the intent: ${JSON.stringify(r.errors)}`);
  },
  async send({ space, raw }) {
    const r = await admin<{ ok?: boolean; errors?: unknown }>("dev.send", { space, raw });
    if (r.ok === false) throw new Error(`the Link refused the Send: ${JSON.stringify(r.errors)}`);
  },
  close() {
    link.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  },
});
