// The Reflex Relay on Cloudflare (relay/cloudflare) behind the relay profile's one
// driver request, run locally by `wrangler dev --local` with its Durable Objects and
// R2 in a fresh folder. Nothing is deployed.
//
//   node tests/conformance/run.ts relay --impl "node tests/conformance/impl/relay-worker.ts"
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../lib/driver.ts";
import { sleep } from "../lib/host.ts";

const cwd = new URL("../../../relay/cloudflare/", import.meta.url).pathname;
const wrangler = new URL("../../../node_modules/.bin/wrangler", import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), "reflex-conf-worker-"));
let child: ChildProcess | null = null;

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

serve({
  async start() {
    const port = await freePort();
    child = spawn(wrangler, ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, "--show-interactive-dev-session=false"], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout!.on("data", (d) => process.stderr.write(`wrangler: ${d}`));
    child.stderr!.on("data", (d) => process.stderr.write(`wrangler: ${d}`));
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 240; i++) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited (${child.exitCode})`);
      if (await fetch(`${url}/protocol/v1/`).then((r) => r.ok, () => false)) return { url };
      await sleep(500);
    }
    throw new Error("wrangler dev never came up");
  },
  close() {
    // wrangler starts workerd under it: stop the whole group.
    if (child?.pid) process.kill(-child.pid, "SIGTERM");
    rmSync(state, { recursive: true, force: true });
  },
});
