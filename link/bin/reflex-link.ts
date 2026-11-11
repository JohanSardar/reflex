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

async function start(): Promise<void> {
  const link = new Link({ dir, name: flags.name, port: flags.port ? Number(flags.port) : undefined, prompt: !flags["no-prompt"], dev: flags.dev });
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
  spaces: { id: string; kind: string; digest: string; elements: number; sends: string[] }[];
  journal: { entries: number; checkpoints: number };
  assets: number;
  inbox: { space: string; send: string; via: string; receipts: { recipient: string; state: string }[] }[];
  paired: { device: string; name: string; connected: boolean }[];
  peers: { device: string; name: string; remote: string; rttMs: number | null }[];
  agents: { id: string; name: string; status: string }[];
}

function showStatus(s: Status): string {
  const lines = [`${s.name} (${s.device}) · ${s.person.name} · LAN :${s.lan_port}`, ""];
  lines.push(`Spaces (${s.spaces.length}), journal ${s.journal.entries} entries, ${s.assets} assets`);
  for (const x of s.spaces) lines.push(`  ${x.id.padEnd(20)} ${x.kind.padEnd(8)} ${String(x.elements).padStart(3)} elements  ${x.sends.length} sends  digest ${x.digest.slice(0, 12)}`);
  lines.push(`Paired devices (${s.paired.length})`);
  for (const d of s.paired) {
    const p = s.peers.find((x) => x.device === d.device);
    lines.push(`  ${d.name.padEnd(20)} ${d.device}  ${p ? `connected ${p.remote}${p.rttMs !== null ? `, ${p.rttMs} ms` : ""}` : "not connected"}`);
  }
  lines.push(`Agents (${s.agents.length})`);
  for (const a of s.agents) lines.push(`  ${a.id.padEnd(28)} ${a.status.padEnd(9)} ${a.name}`);
  lines.push(`Inbox (${s.inbox.length})`);
  for (const i of s.inbox)
    lines.push(`  ${i.space}/${i.send}  via ${i.via}  ${i.receipts.map((r) => `${r.recipient}: ${r.state}`).join(", ") || "not delivered yet"}`);
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
