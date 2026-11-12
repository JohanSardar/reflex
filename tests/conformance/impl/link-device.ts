// The Reflex Link as a drawing client: a real `reflex link --dev` in a fresh home,
// paired with the runner by its code (`reflex link pair`), drawing and sending as its
// person through the Link's own admin RPC (what `reflex link dev draw|send` call).
//
//   node tests/conformance/run.ts drawing --impl "node tests/conformance/impl/link-device.ts"
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkClient } from "../../../link/rpc/client.ts";
import { serve } from "../lib/driver.ts";
import { sleep } from "../lib/host.ts";

const repo = new URL("../../../", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "reflex-conf-link-"));
const cli = (...args: string[]) => spawnSync(process.execPath, [join(repo, "link/bin/reflex-link.ts"), "--home", home, ...args], { encoding: "utf8" });
const link = spawn(process.execPath, [join(repo, "link/bin/reflex-link.ts"), "--home", home, "--dev", "--no-prompt", "--no-web", "--no-p2p", "--relay", "off", "--port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
link.stderr!.on("data", (d) => process.stderr.write(`link: ${d}`));

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
  async pair({ code }) {
    await ready;
    const r = cli("pair", code);
    if (r.status !== 0) throw new Error(`reflex link pair failed: ${r.stderr || r.stdout}`);
  },
  async ids({ space }) {
    const scene = await admin<{ elements: { id: string }[] }>("space.read", { space });
    return { ids: scene.elements.map((e) => e.id) };
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
