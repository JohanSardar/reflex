#!/usr/bin/env node
// reflex-relay: run a self-hosted Relay.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startRelay } from "../server.ts";

const HELP = `A self-hosted Reflex Relay: syncs your devices across networks, stores each
Space as an encrypted log it can't read, and gives cloud Agents remote MCP over OAuth.

Usage
  reflex-relay [--port 8787] [--dir ~/.reflex/relay] [--origin https://relay.example.com]

Options
  --port <n>       Port to listen on (default 8787, or $PORT)
  --host <addr>    Address to bind (default 0.0.0.0)
  --dir <dir>      Where logs, grants and sealed assets are kept (default $REFLEX_RELAY_DIR or ~/.reflex/relay)
  --origin <url>   The public URL, when behind a TLS proxy (OAuth metadata uses it)
  -h, --help       Show this help
`;

const { values: f } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    dir: { type: "string" },
    origin: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (f.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const relay = await startRelay({
  port: Number(f.port ?? process.env.PORT ?? 8787),
  host: f.host,
  dir: f.dir ?? process.env.REFLEX_RELAY_DIR ?? join(homedir(), ".reflex", "relay"),
  origin: f.origin,
});
const stop = async (): Promise<void> => {
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
