// A webhook receiver that starts a Claude turn for each Send (link/adapters/webhook.ts).
//
//   reflex adapters add webhook --url http://127.0.0.1:8790/ --agent "Webhook Claude"
//   REFLEX_WEBHOOK_SECRET=whsec_… REFLEX_AGENT_NAME="Webhook Claude" node agent/examples/webhook-claude.ts
//
// It checks each request's signature, answers 202 at once (the Link counts
// that as the Send delivered), drops a delivery it already took, and runs
// `claude -p` with the Bundle and Reflex's MCP server under the same Agent
// name, so Claude answers in the Space with apply(in_reply_to). Any harness
// works the same way: take the POST, start a turn, reply with Reflex tools.
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secret = process.env.REFLEX_WEBHOOK_SECRET ?? "";
const agent = process.env.REFLEX_AGENT_NAME ?? "";
const port = Number(process.env.PORT ?? 8790);
if (!secret.startsWith("whsec_") || !agent) {
  console.error("Set REFLEX_WEBHOOK_SECRET (from `reflex adapters add webhook`) and REFLEX_AGENT_NAME (the --agent you added it as).");
  process.exit(2);
}
const reflex = new URL("../bin/reflex.mjs", import.meta.url).pathname;
const seen = new Set<string>();

function signed(ts: string, sig: string, body: string): boolean {
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false;
  const want = Buffer.from(`v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`);
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

function turn(bundle: Record<string, any>) {
  const dir = join(tmpdir(), "reflex-webhook");
  mkdirSync(dir, { recursive: true });
  for (const img of bundle.images ?? []) {
    if (!img.data) continue;
    img.file = join(dir, `${bundle.send}-${img.n}.png`);
    writeFileSync(img.file, Buffer.from(img.data, "base64"));
    delete img.data;
  }
  const mcp = { mcpServers: { reflex: { command: process.execPath, args: [reflex, "mcp"], env: { REFLEX_AGENT_NAME: agent, ...(process.env.REFLEX_HOME ? { REFLEX_HOME: process.env.REFLEX_HOME } : {}) } } } };
  const prompt = `The person pressed Send in their Reflex Space. Here is the Send Bundle (its crops are PNG files at images[].file):\n\n${JSON.stringify(bundle)}\n\nFollow its next: answer in the Space with the reflex tools, then stop.`;
  const args = ["-p", prompt, "--mcp-config", JSON.stringify(mcp), "--allowedTools", "mcp__reflex__apply,mcp__reflex__read,mcp__reflex__look,mcp__reflex__wait_for_user,mcp__reflex__open_space,Read", "--output-format", "text"];
  console.log(`${new Date().toISOString()} ${bundle.space}/${bundle.send}: starting claude -p`);
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.on("data", (d) => process.stdout.write(`  claude: ${d}`));
  child.on("exit", (code) => console.log(`${new Date().toISOString()} ${bundle.space}/${bundle.send}: claude exited ${code}`));
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.method !== "POST" || !signed(String(req.headers["reflex-timestamp"] ?? ""), String(req.headers["reflex-signature"] ?? ""), body)) {
      console.log(`${new Date().toISOString()} rejected a request (bad or missing signature)`);
      return res.writeHead(401).end();
    }
    const delivery = String(req.headers["reflex-delivery"]);
    res.writeHead(202).end();
    console.log(`${new Date().toISOString()} ${delivery} attempt ${req.headers["reflex-attempt"]}: signature ok, acknowledged`);
    if (seen.has(delivery)) return; // a retry of one already taken
    seen.add(delivery);
    turn(JSON.parse(body).bundle);
  });
}).listen(port, "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${port}/ for ${agent}`));
