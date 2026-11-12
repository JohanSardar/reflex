// The Reflex Relay on Node (relay/node, the `reflex-relay` command) behind the relay
// profile's one driver request: a fresh one on a free port with an empty data folder.
//
//   node tests/conformance/run.ts relay --impl "node tests/conformance/impl/relay-node.ts"
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { serve } from "../lib/driver.ts";

const bin = new URL("../../../relay/node/bin/reflex-relay.ts", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "reflex-conf-relay-"));
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
    child = spawn(process.execPath, [bin, "--port", String(port), "--host", "127.0.0.1", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (d) => process.stderr.write(`relay: ${d}`));
    await new Promise<void>((resolve, reject) => {
      child!.once("exit", (c) => reject(new Error(`it exited (${c})`)));
      createInterface({ input: child!.stdout! }).on("line", (l) => {
        process.stderr.write(`${l}\n`);
        if (/listening on/.test(l)) resolve();
      });
    });
    return { url: `http://127.0.0.1:${port}` };
  },
  close() {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  },
});
