#!/usr/bin/env node
// reflex link (also reflex-link): start the Link with the Agent layer inside
// it, pair devices, see and revoke Agents, look inside.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { homeDir } from "../home.ts";
import { Link, LinkError } from "../link.ts";
import { LinkClient, RpcError } from "../rpc/client.ts";
import { DEFAULT_RELAY } from "../transports/relay.ts";

const HELP = `Reflex Link — receive iPad Sends for local agents
Usage: reflex link [status|stop|pair|forget <device>|agents|deny <agent>|revoke <agent>]
  --home <path>    Profile folder
  --name <name>    Mac name on first start
  --port <n>       LAN port (default 7420)
  --relay <url>    Use this Relay (remembered; off turns it off). Also: REFLEX_RELAY=<url>|off
  --no-lan        Use the Relay only
  --no-p2p        Disable peer-to-peer Wi-Fi
  --no-prompt     Run without terminal pairing/approval prompts
  --json          Print JSON
`;

const { values: flags, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    name: { type: "string" },
    port: { type: "string" },
    json: { type: "boolean", default: false },
    "no-prompt": { type: "boolean", default: false },
    relay: { type: "string" },
    "no-lan": { type: "boolean", default: false },
    "no-p2p": { type: "boolean", default: false },
    fault: { type: "string" },
    "every-path": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const dir = homeDir(flags.home);
const out = (human: string, data: unknown): void => console.log(flags.json ? JSON.stringify(data, null, 2) : human);

async function admin<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const c = await LinkClient.connect(dir, "admin");
  try {
    return await c.call<T>(method, params);
  } finally {
    c.close();
  }
}

/**
 * The Relay this profile uses: --relay sets it and it is remembered, --relay off turns it off (also remembered);
 * REFLEX_RELAY (a URL, or off) wins over what was remembered, so one setting in the agent's MCP config is enough;
 * a profile that never chose one uses the default, public Relay.
 */
function relayUrl(): string | undefined {
  const file = join(dir, "relay.json");
  const check = (url: string, from: string): string => {
    if (!/^wss?:\/\/[^/]+/.test(url))
      throw new LinkError(
        "usage",
        `${from} '${url}' is not a ws:// or wss:// URL.`,
        `For example: wss://relay.example.com (the default is ${DEFAULT_RELAY})`,
      );
    return url.replace(/\/+$/, "");
  };
  if (flags.relay === "off") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, "{}\n");
    return undefined;
  }
  if (flags.relay) {
    const url = check(flags.relay, "--relay");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ url })}\n`);
    return url;
  }
  const env = process.env.REFLEX_RELAY?.trim();
  if (env) return env === "off" ? undefined : check(env, "REFLEX_RELAY");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).url ?? undefined) : DEFAULT_RELAY;
}

async function start(): Promise<void> {
  const link = new Link({
    dir,
    name: flags.name,
    port: flags.port ? Number(flags.port) : undefined,
    prompt: !flags["no-prompt"],
    relay: relayUrl(),
    lan: !flags["no-lan"],
    p2p: !flags["no-p2p"],
    fault: flags.fault,
    everyPath: flags["every-path"],
    onShutdown: () => void stop("`reflex link stop`"),
  });
  const stop = async (sig: string): Promise<void> => {
    console.log(`link: ${sig}, stopping`);
    await link.stop();
    process.exit(0);
  };
  await link.start();
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

interface Status {
  device: string;
  name: string;
  person: { id: string; name: string };
  lan_port: number;
  p2p_port: number | null;
  pages: string[];
  assets: number;
  inbox: { space: string; send: string; via: string; receipts: { recipient: string; state: string }[] }[];
  paired: { device: string; name: string; connected: boolean }[];
  peers: {
    device: string;
    name: string;
    paths: {
      transport: string;
      remote: string;
      rttMs: number | null;
      active: boolean;
      sentBytes: number;
      receivedBytes: number;
    }[];
  }[];
  agents: { id: string; name: string; status: string }[];
  push?: {
    targets: { id: string; agent: string; adapter: string; config: Record<string, unknown>; live: boolean }[];
    attempts: {
      space: string;
      send: string;
      recipient: string;
      target: string;
      started_at: number;
      outcome: string;
      reason: string | null;
    }[];
  };
}

function showStatus(s: Status): string {
  const lines = [
    `${s.name} (${s.device}) · ${s.person.name} · ${s.lan_port === undefined ? "no LAN" : `LAN :${s.lan_port}`}${s.p2p_port ? ` · peer-to-peer :${s.p2p_port}` : ""}`,
    "",
  ];
  lines.push(`Pages with Sends (${s.pages.length}), ${s.assets} assets`);
  for (const page of s.pages) lines.push(`  ${page}`);
  lines.push(`Paired devices (${s.paired.length})`);
  for (const d of s.paired) {
    const p = s.peers.find((x) => x.device === d.device);
    lines.push(
      `  ${d.name.padEnd(20)} ${d.device}  ${p ? `connected over ${p.paths.length} path${p.paths.length === 1 ? "" : "s"}` : "not connected"}`,
    );
    for (const x of p?.paths ?? [])
      lines.push(
        `    ${x.active ? "→" : " "} ${x.transport.padEnd(4)} ${x.remote}${x.rttMs !== null ? `, ${x.rttMs} ms` : ""}, ` +
          `sent ${x.sentBytes} B, received ${x.receivedBytes} B${x.active ? " (sending here)" : ""}`,
      );
  }
  lines.push(`Agents (${s.agents.length})`);
  for (const a of s.agents) lines.push(`  ${a.id.padEnd(28)} ${a.status.padEnd(9)} ${a.name}`);
  lines.push(`Inbox (${s.inbox.length})`);
  for (const i of s.inbox)
    lines.push(
      `  ${i.space}/${i.send}  via ${i.via}  ${i.receipts.map((r) => `${r.recipient}: ${r.state}`).join(", ") || "not delivered yet"}`,
    );
  const push = s.push ?? { targets: [], attempts: [] };
  lines.push(`Push targets (${push.targets.length})`);
  for (const t of push.targets)
    lines.push(
      `  ${t.id}  ${t.adapter.padEnd(15)} ${t.live ? "live   " : "offline"}  agent ${t.agent}  ${JSON.stringify(t.config)}`,
    );
  if (push.attempts.length) lines.push(`Recent pushes`);
  for (const a of push.attempts)
    lines.push(
      `  ${new Date(a.started_at).toISOString()}  ${a.space}/${a.send} → ${a.recipient} via ${a.target}: ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`,
    );
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (flags.help) return void process.stdout.write(HELP);
  const cmd = args[0] ?? "start";
  switch (cmd) {
    case "start":
      return start();
    case "status": {
      const s = await admin<Status>("status");
      return out(showStatus(s), s);
    }
    case "pair": {
      if (!args[1])
        throw new LinkError(
          "usage",
          "To pair an iPad, run `reflex pair`: it shows a fresh code to scan.",
          "To pair this Link with another Link, run: reflex link pair '<its code>'",
        );
      const d = await admin<{ device: string; name: string }>("pair.join", { uri: args[1] });
      return out(`Paired with ${d.name} (${d.device}).`, d);
    }
    case "stop": {
      // The Link answering on this profile's socket, in the background or in another terminal: asked to stop
      // over its admin socket, so a pid that now belongs to another program is never signalled.
      let c: LinkClient;
      try {
        c = await LinkClient.connect(dir, "admin");
      } catch {
        return out(`No Link is running from ${dir}.`, { stopped: false });
      }
      let pid: number;
      try {
        pid = (await c.call<{ pid: number }>("shutdown")).pid;
      } finally {
        c.close();
      }
      for (let i = 0; i < 100 && existsSync(join(dir, "link.json")); i++) await new Promise((r) => setTimeout(r, 100));
      return out(`Stopped the Link (pid ${pid}). \`reflex mcp\` and the CLI start it again when they need it.`, {
        stopped: true,
        pid,
      });
    }
    case "forget": {
      if (!args[1])
        throw new LinkError(
          "usage",
          "Which device? reflex link forget <device>",
          "Run reflex link status to see them.",
        );
      const d = await admin<{ device: string; name: string; window_until?: number }>("forget", { device: args[1] });
      return out(
        `Forgot ${d.name} (${d.device}).` +
          (d.window_until
            ? ` No iPad approves Agents now: until ${new Date(d.window_until).toLocaleTimeString()}, \`reflex pair\` pairs one that does. Run it and scan the code on your iPad.`
            : ""),
        d,
      );
    }
    case "agents": {
      const list = await admin<{ id: string; name: string; status: string; color: string }[]>("agents.list");
      return out(
        list.map((a) => `${a.id.padEnd(28)} ${a.status.padEnd(9)} ${a.name}`).join("\n") ||
          "No Agents have connected yet.",
        list,
      );
    }
    case "approve":
    case "deny":
    case "revoke": {
      if (!args[1])
        throw new LinkError("usage", `Which Agent? reflex link ${cmd} <agent>`, "Run reflex link agents to see them.");
      const status = { approve: "approved", deny: "denied", revoke: "revoked" }[cmd];
      const a = await admin<{ id: string; name: string; status: string }>("agents.decide", { id: args[1], status });
      return out(`${a.name} (${a.id}) ${a.status}.`, a);
    }
    case "fault": {
      if (args[1] === undefined)
        throw new LinkError("usage", 'Which faults? reflex link fault "lan:drop=1" (or "" to clear)');
      const f = await admin<Record<string, unknown>>("fault", { spec: args[1] });
      return out(
        Object.entries(f)
          .map(([t, v]) => `${t}: ${JSON.stringify(v)}`)
          .join("\n"),
        f,
      );
    }
    default:
      throw new LinkError("usage", `Unknown command '${cmd}'.`, "Run reflex link --help.");
  }
}

main().catch((e: Error) => {
  const fix = e instanceof RpcError || e instanceof LinkError ? e.fix : undefined;
  console.error(`Error: ${e.message}${fix ? `\n${fix}` : ""}`);
  process.exit(1);
});
