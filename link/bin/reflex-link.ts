#!/usr/bin/env node
// reflex link (also reflex-link): start the Link with the Agent layer inside
// it, pair devices, see and revoke Agents, look inside.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { homeDir } from "../home.ts";
import { Link, LinkError } from "../link.ts";
import { LinkClient, RpcError } from "../rpc/client.ts";

const HELP = `Reflex Link keeps every Space durable on this computer, in sync with your iPad, and open to your Agents.

Usage
  reflex link                         Start the Link in this terminal and show a pairing code
                                      (Enter shows a new code; y/n answers an Agent asking to connect)
  reflex link status                  Show Spaces, peers, Agents and the Inbox
  reflex link pair <code>             Pair with another Link showing <code> (reflex://pair?...)
  reflex link agents                  List Agents and their approval
  reflex link deny <agent>            Deny an Agent waiting to connect
  reflex link revoke <agent>          Take an approved Agent's access away
  reflex link relay                   The Relay: connection and the grants you gave cloud Agents
  reflex link relay revoke <grant>    End a cloud Agent's grant now
  reflex link fault <spec>            Change fault injection on a Link started with --fault
                                      (e.g. "lan:drop=1" takes LAN down, "" clears it)

Through a Relay (--relay), your devices sync when they aren't on the same network, and each
Space is kept there as an encrypted log the Relay can't read. A cloud Agent signs in on the
Relay's page, which shows a code: type it into this Link's terminal to pick one Space and how
long it may use it. Nothing else can grant one.

Agents are approved by you: tap Allow on your iPad, or answer y in the Link's terminal.

Acting as the person without an iPad (a Link started with --dev)
  reflex link dev space <space>                     Create a Space
  reflex link dev draw <space> <stroke> [x,y ...]   Draw a stroke as this person
  reflex link dev undo <space>                      Undo this person's last action
  reflex link dev send <space> <send> [said]        Send, as this person
  reflex link dev asset <file>                      Store a file as an asset
  reflex link dev agent <name> apply <space> <json> Act as an Agent over the low-level RPC
  reflex link dev agent <name> inbox                That Agent's pending Sends
  reflex link dev agent <name> ack <space> <send>   Acknowledge a Send

Options
  --home <dir>    Link profile folder (default $REFLEX_HOME or ~/.reflex/link)
  --name <name>   This device's name, on first start
  --port <n>      LAN port (default 7420; any free port if taken)
  --dev           Allow acting as the person without an iPad
  --web-port <n>  The web viewer's port on 127.0.0.1 (default 7421; any free one if taken)
  --no-web        Don't serve the web viewer
  --relay <url>   Sync through this Reflex Relay (default wss://reflex.eilmer.si, or $REFLEX_RELAY);
                  remembered. --relay off stops using one
  --no-lan        Don't listen or look for devices on the local network (Relay only)
  --no-p2p        Don't use Apple peer-to-peer Wi-Fi (on by default on macOS; needs npm run build:p2p)
  --fault <spec>  Drop, delay or duplicate frames per transport, e.g. "lan:delay=80,jitter=40;p2p:drop=0.01"
  --every-path    Send every change over every live path, not just the fastest
  --json          Machine-readable output
  --no-prompt     Don't use this terminal for pairing codes or questions
  -h, --help      Show this help
`;

const { values: flags, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    name: { type: "string" },
    port: { type: "string" },
    json: { type: "boolean", default: false },
    "no-prompt": { type: "boolean", default: false },
    dev: { type: "boolean", default: false },
    "web-port": { type: "string" },
    "no-web": { type: "boolean", default: false },
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

/** The official Relay; a profile that never chose one uses it. */
const DEFAULT_RELAY = "wss://reflex.eilmer.si";

/** The Relay this profile uses: --relay sets it and it is remembered, --relay off turns it off (also remembered). */
function relayUrl(): string | undefined {
  const file = join(dir, "relay.json");
  if (flags.relay === "off") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, "{}\n");
    return undefined;
  }
  if (flags.relay) {
    if (!/^wss?:\/\/[^/]+/.test(flags.relay)) throw new LinkError("usage", `'${flags.relay}' is not a ws:// or wss:// URL.`, "For example: --relay wss://reflex.eilmer.si");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ url: flags.relay }) + "\n");
    return flags.relay;
  }
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).url ?? undefined) : (process.env.REFLEX_RELAY || DEFAULT_RELAY);
}

async function start(): Promise<void> {
  const link = new Link({
    dir,
    name: flags.name,
    port: flags.port ? Number(flags.port) : undefined,
    prompt: !flags["no-prompt"],
    dev: flags.dev,
    webPort: flags["no-web"] ? null : flags["web-port"] ? Number(flags["web-port"]) : undefined,
    relay: relayUrl(),
    lan: !flags["no-lan"],
    p2p: !flags["no-p2p"],
    fault: flags.fault,
    everyPath: flags["every-path"],
  });
  await link.start();
  const stop = async (sig: string): Promise<void> => {
    console.log(`link: ${sig}, stopping`);
    await link.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

interface Status {
  device: string;
  name: string;
  person: { id: string; name: string };
  lan_port: number;
  p2p_port: number | null;
  spaces: { id: string; kind: string; digest: string; elements: number; sends: string[] }[];
  journal: { entries: number; checkpoints: number };
  assets: number;
  inbox: { space: string; send: string; via: string; receipts: { recipient: string; state: string }[] }[];
  paired: { device: string; name: string; connected: boolean }[];
  peers: { device: string; name: string; paths: { transport: string; remote: string; rttMs: number | null; active: boolean; sentBytes: number; receivedBytes: number }[] }[];
  agents: { id: string; name: string; status: string }[];
  push?: {
    targets: { id: string; agent: string; adapter: string; config: Record<string, unknown>; live: boolean }[];
    attempts: { space: string; send: string; recipient: string; target: string; started_at: number; outcome: string; reason: string | null }[];
  };
}

function showStatus(s: Status): string {
  const lines = [`${s.name} (${s.device}) · ${s.person.name} · ${s.lan_port === undefined ? "no LAN" : `LAN :${s.lan_port}`}${s.p2p_port ? ` · peer-to-peer :${s.p2p_port}` : ""}`, ""];
  lines.push(`Spaces (${s.spaces.length}), journal ${s.journal.entries} entries, ${s.assets} assets`);
  for (const x of s.spaces) lines.push(`  ${x.id.padEnd(20)} ${x.kind.padEnd(8)} ${String(x.elements).padStart(3)} elements  ${x.sends.length} sends  digest ${x.digest.slice(0, 12)}`);
  lines.push(`Paired devices (${s.paired.length})`);
  for (const d of s.paired) {
    const p = s.peers.find((x) => x.device === d.device);
    lines.push(`  ${d.name.padEnd(20)} ${d.device}  ${p ? `connected over ${p.paths.length} path${p.paths.length === 1 ? "" : "s"}` : "not connected"}`);
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
    lines.push(`  ${i.space}/${i.send}  via ${i.via}  ${i.receipts.map((r) => `${r.recipient}: ${r.state}`).join(", ") || "not delivered yet"}`);
  const push = s.push ?? { targets: [], attempts: [] };
  lines.push(`Push targets (${push.targets.length})`);
  for (const t of push.targets) lines.push(`  ${t.id}  ${t.adapter.padEnd(15)} ${t.live ? "live   " : "offline"}  agent ${t.agent}  ${JSON.stringify(t.config)}`);
  if (push.attempts.length) lines.push(`Recent pushes`);
  for (const a of push.attempts)
    lines.push(`  ${new Date(a.started_at).toISOString()}  ${a.space}/${a.send} → ${a.recipient} via ${a.target}: ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`);
  return lines.join("\n");
}

/** A stand-in Agent client: keeps its own credential, like the Agent layer will. */
async function agentClient(name: string): Promise<LinkClient> {
  const credDir = join(dir, "dev-agents");
  mkdirSync(credDir, { recursive: true, mode: 0o700 });
  const file = join(credDir, name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".cred");
  if (!existsSync(file)) writeFileSync(file, "rxa_" + randomBytes(32).toString("base64url"), { mode: 0o600 });
  const credential = readFileSync(file, "utf8").trim();
  const c = await LinkClient.connect(dir, "agent");
  console.error(`connecting as Agent "${name}"...`);
  const me = await c.call<{ agent: string; color: string }>("agent.hello", { name, credential });
  console.error(`approved as ${me.agent}`);
  return c;
}

async function dev(): Promise<void> {
  const [what, ...rest] = args.slice(1);
  switch (what) {
    case "space":
      return out(`made Space ${rest[0]}`, await admin("space.open", { space: rest[0] }));
    case "draw": {
      const [space, id, ...pts] = rest;
      const points = (pts.length ? pts : ["0,0", "40,40", "80,0"]).map((p) => p.split(",").map(Number));
      const r = await admin("dev.intent", { space, intent: { intent: "add_stroke", id, stroke: { points } } });
      return out(JSON.stringify(r), r);
    }
    case "undo": {
      const r = await admin("dev.undo", { space: rest[0] });
      return out(JSON.stringify(r), r);
    }
    case "send": {
      const [space, send, ...said] = rest;
      const r = await admin("dev.send", { space, raw: { send, trigger: "button", ...(said.length ? { said: said.join(" ") } : {}) } });
      return out(JSON.stringify(r), r);
    }
    case "asset": {
      const r = await admin<{ hash: string }>("assets.put", { base64: readFileSync(rest[0]).toString("base64") });
      return out(r.hash, r);
    }
    case "agent": {
      const [name, action, space, arg] = rest;
      const c = await agentClient(name);
      try {
        if (action === "apply") {
          const r = await c.call("space.apply", { space, batch: JSON.parse(arg) });
          return out(JSON.stringify(r), r);
        }
        if (action === "inbox") {
          const r = await c.call("inbox.pending", space ? { space } : {});
          return out(JSON.stringify(r, null, 2), r);
        }
        if (action === "ack") {
          const r = await c.call("inbox.ack", { space, send: arg });
          return out(JSON.stringify(r), r);
        }
        throw new LinkError("usage", `Unknown agent action '${action}'.`, "Use apply, inbox or ack.");
      } finally {
        c.close();
      }
    }
    default:
      throw new LinkError("usage", `Unknown dev command '${what}'.`, "Run reflex link --help.");
  }
}

async function main(): Promise<void> {
  if (flags.help) return void process.stdout.write(HELP);
  const cmd = args[0] ?? "start";
  switch (cmd) {
    case "start":
      return start();
    case "status":
    {
      const s = await admin<Status>("status");
      return out(showStatus(s), s);
    }
    case "pair": {
      if (!args[1]) throw new LinkError("usage", "A new pairing code is shown only in the Link's own terminal.", "Press Enter there. To pair with another Link, run: reflex link pair '<its code>'");
      const d = await admin<{ device: string; name: string }>("pair.join", { uri: args[1] });
      return out(`Paired with ${d.name} (${d.device}).`, d);
    }
    case "agents": {
      const list = await admin<{ id: string; name: string; status: string; color: string }[]>("agents.list");
      return out(list.map((a) => `${a.id.padEnd(28)} ${a.status.padEnd(9)} ${a.name}`).join("\n") || "No Agents have connected yet.", list);
    }
    case "approve":
    case "deny":
    case "revoke": {
      if (!args[1]) throw new LinkError("usage", `Which Agent? reflex link ${cmd} <agent>`, "Run reflex link agents to see them.");
      const status = { approve: "approved", deny: "denied", revoke: "revoked" }[cmd];
      const a = await admin<{ id: string; name: string; status: string }>("agents.decide", { id: args[1], status });
      return out(`${a.name} (${a.id}) ${a.status}.`, a);
    }
    case "relay": {
      if (args[1] === "revoke") {
        if (!args[2]) throw new LinkError("usage", "Which grant? reflex link relay revoke <grant>", "Run reflex link relay to see them.");
        const g = await admin<{ gid: string; name: string; space: string; status: string }>("relay.revoke", { grant: args[2] });
        return out(`${g.name}'s grant on '${g.space}' (${g.gid}) is ${g.status}.`, g);
      }
      const s = await admin<{ relay: null | { url: string; connected: boolean; logs: number; grants: { gid: string; space: string; name: string; agent: string; expires: number; status: string }[] } }>("status");
      if (!s.relay) return out("This Link isn't using a Relay. Start it with --relay <url>.", s.relay);
      const r = s.relay;
      const lines = [`${r.url} · ${r.connected ? "connected" : "not connected"} · ${r.logs} Spaces in its encrypted log`, `Grants (${r.grants.length})`];
      for (const g of r.grants) lines.push(`  ${g.gid}  ${g.status.padEnd(8)} ${g.space.padEnd(16)} ${g.name} (${g.agent}) until ${new Date(g.expires).toLocaleString()}`);
      return out(lines.join("\n"), r);
    }
    case "fault": {
      if (args[1] === undefined) throw new LinkError("usage", 'Which faults? reflex link fault "lan:drop=1" (or "" to clear)');
      const f = await admin<Record<string, unknown>>("fault", { spec: args[1] });
      return out(Object.entries(f).map(([t, v]) => `${t}: ${JSON.stringify(v)}`).join("\n"), f);
    }
    case "dev":
      return dev();
    default:
      throw new LinkError("usage", `Unknown command '${cmd}'.`, "Run reflex link --help.");
  }
}

main().catch((e: Error) => {
  const fix = e instanceof RpcError || e instanceof LinkError ? e.fix : undefined;
  console.error(`Error: ${e.message}${fix ? `\n${fix}` : ""}`);
  process.exit(1);
});
