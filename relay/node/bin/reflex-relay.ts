#!/usr/bin/env node
// reflex relay (also reflex-relay): run a Relay of your own.
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { startRelay } from "../server.ts";

const HELP = `Run a Reflex Relay of your own: it forwards end-to-end encrypted frames between your devices and keeps nothing.

Usage
  reflex relay [--port 8787] [--host 0.0.0.0] [--tunnel]

Options
  --port <n>       Port to listen on (default 8787, or $PORT)
  --host <addr>    Address to bind (default 0.0.0.0)
  --tunnel         Also open a Cloudflare quick tunnel (needs cloudflared; free, no account) and print the
                   wss:// address to give your Mac. It changes each time; for a fixed one, put the Relay
                   behind HTTPS on your own domain (e.g. caddy reverse-proxy --from relay.example.com --to :8787)
  --origin <url>   The public URL, when behind a TLS proxy
  -h, --help       Show this help

Then, on the Mac, set REFLEX_RELAY=wss://<this relay> (for example in your agent's MCP config, see the README).
`;

const { values: f } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    dir: { type: "string" }, // accepted for older scripts; nothing is stored
    origin: { type: "string" },
    tunnel: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (f.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const relay = await startRelay({ port: Number(f.port ?? process.env.PORT ?? 8787), host: f.host, origin: f.origin });
const say = (url: string) =>
  console.log(`relay: reachable from anywhere at ${url}\nrelay: on your Mac, set REFLEX_RELAY=${url} (see the README's "Run your own relay")`);

let tunnel: ReturnType<typeof spawn> | null = null;
if (f.tunnel) {
  tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${relay.port}`], { stdio: ["ignore", "pipe", "pipe"] });
  tunnel.on("error", () => {
    console.error("relay: --tunnel needs cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/, or `brew install cloudflared`).");
    process.exit(1);
  });
  let told = false;
  const read = (b: Buffer) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(b.toString());
    if (m && !told) {
      told = true;
      say(m[0].replace("https://", "wss://"));
    }
  };
  tunnel.stdout!.on("data", read);
  tunnel.stderr!.on("data", read);
  tunnel.on("exit", (code) => {
    console.error(`relay: the tunnel stopped (${code})`);
    process.exit(1);
  });
}

const stop = async (): Promise<void> => {
  tunnel?.kill();
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
