// agent/examples/webhook-claude.ts as a Send Adapter receiver, behind the profile's
// driver requests. CLAUDE_BIN is `true` unless set, so each delivery it takes starts
// a turn that ends at once; set CLAUDE_BIN=claude to have a real Claude answer.
//
//   node tests/conformance/run.ts send-adapter --role receiver --impl "node tests/conformance/impl/webhook-receiver.ts"
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { serve } from "../lib/driver.ts";

const example = new URL("../../../agent/examples/webhook-claude.ts", import.meta.url).pathname;
let child: ChildProcess | null = null;
const taken: string[] = [];

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

serve({
  async start({ secret }) {
    const port = await freePort();
    child = spawn(process.execPath, [example], {
      env: { ...process.env, REFLEX_WEBHOOK_SECRET: secret, REFLEX_AGENT_NAME: "Conformance Agent", PORT: String(port), CLAUDE_BIN: process.env.CLAUDE_BIN ?? "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (d) => process.stderr.write(`receiver: ${d}`));
    await new Promise<void>((resolve, reject) => {
      child!.once("exit", (c) => reject(new Error(`it exited (${c})`)));
      createInterface({ input: child!.stdout! }).on("line", (l) => {
        process.stderr.write(`receiver: ${l}\n`);
        // "<time> <space>/<send>: starting claude -p" is a delivery it acted on.
        const m = / (\S+\/\S+): starting claude -p$/.exec(l);
        if (m) taken.push(m[1]);
        if (l.startsWith("listening on")) resolve();
      });
    });
    return { url: `http://127.0.0.1:${port}/` };
  },
  taken: () => ({ deliveries: taken }),
  close() {
    child?.kill();
  },
});
