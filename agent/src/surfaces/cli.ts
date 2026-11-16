// The reflex CLI (SPEC §12, ADR-0003, https://vercel.com/design/cli).
// Grammar: reflex <group> <action> [<resource>] [flags]. Each command maps 1:1
// onto a tool in the capability table.
//
//   stdout carries only the answer; --json prints exactly one document.
//   On failure stderr gets one line of JSON with a stable reason and next steps.
//   Exit codes: 0 success, 1 operational failure, 2 usage error, 130 cancelled.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Client, type CallResult } from "../host/client.ts";
import { credential, NoLink, type Who } from "../host/rpc.ts";
import { TOOLS, description } from "../protocol.ts";

type Flags = Record<string, string | boolean>;
type Cmd = { usage: string; summary: string; flags?: string[]; run: (pos: string[], f: Flags) => Promise<number> };

const VERSION = "0.1.0";
const out = (s: string) => process.stdout.write(s + "\n");
const errLine = (reason: string, msg: string, fix: string, next: string[] = []) =>
  process.stderr.write(JSON.stringify({ ok: false, reason, errors: [{ code: reason, msg, fix }], ...(next.length ? { next } : {}) }) + "\n");

class Usage extends Error {
  next: string[];
  constructor(msg: string, next: string[] = []) {
    super(msg);
    this.next = next;
  }
}

function agentName(f: Flags): string {
  if (typeof f.agent === "string") return f.agent;
  if (process.env.REFLEX_AGENT_NAME) return process.env.REFLEX_AGENT_NAME;
  const project = basename(process.cwd());
  // Codex first: a Codex launched from a Claude Code shell inherits CLAUDECODE, but CODEX_THREAD_ID is set per Codex session.
  if (process.env.CODEX_THREAD_ID) return `Codex CLI · ${project}`;
  if (process.env.CLAUDECODE) return `Claude Code CLI · ${project}`;
  return `CLI · ${project}`;
}
const who = (f: Flags): Who => {
  const name = agentName(f);
  return { name, credential: credential(name) };
};

function int(v: string | boolean | undefined, name: string) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Usage(`--${name} takes an integer, not '${v}'.`);
  return n;
}
const need = (pos: string[], i: number, what: string, usage: string) => {
  if (!pos[i]) throw new Usage(`Missing <${what}>. Usage: ${usage}`);
  return pos[i];
};

let client: Client | undefined;
const host = async () => (client ??= await Client.open(`cli:${process.pid}`));

function imageDir() {
  const dir = join(tmpdir(), "reflex");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Calls a tool and prints the result. Images go to files. */
async function call(tool: string, args: Record<string, unknown>, f: Flags, human: (r: CallResult, files: string[]) => string[], o: { signal?: AbortSignal; files?: (r: CallResult) => string[] } = {}) {
  const r = await (await host()).call(tool, args, who(f), { signal: o.signal });
  if (r.isError) {
    process.stderr.write(JSON.stringify(r.json) + "\n");
    return 1;
  }
  const files = (o.files?.(r) ?? r.images.map((_, i) => join(imageDir(), `${tool}-${Date.now()}-${i + 1}.png`))).slice(0, r.images.length);
  r.images.forEach((b64, i) => writeFileSync(files[i], Buffer.from(b64, "base64")));
  // A file Element's bytes (read detail full) go next to the images; the JSON says where.
  for (const fb of r.files ?? []) {
    const path = join(imageDir(), `${fb.id.replace(/[^A-Za-z0-9_.-]/g, "_")}-${basename(fb.name).replace(/[^A-Za-z0-9_. -]/g, "_")}`);
    writeFileSync(path, Buffer.from(fb.data, "base64"));
    const entry = (r.json.files ?? []).find((x: any) => x.id === fb.id);
    if (entry) entry.file = path;
  }
  if (f.json) out(JSON.stringify(r.json));
  else for (const line of human(r, files)) out(line);
  return 0;
}

/** Calls the Link's push-target management for this Agent and prints the answer. */
async function adapters(action: string, args: Record<string, unknown>, f: Flags, human: (j: any) => string[]) {
  const r = await (await host()).adapters(who(f), action, args);
  if (r.isError) {
    process.stderr.write(JSON.stringify(r.json) + "\n");
    return 1;
  }
  if (f.json) out(JSON.stringify(r.json));
  else for (const line of human(r.json)) out(line);
  return 0;
}

const COMMANDS: Record<string, Cmd> = {
  connect: {
    usage: "reflex connect",
    summary: "Get a 6-digit code to type in Reflex on your iPad (connect): it pairs the iPad and lets this Agent in",
    flags: [],
    run: (_p, f) =>
      call("connect", {}, f, (r) => {
        const j = r.json;
        if (j.connected) return [`Connected to ${j.ipads.join(", ")}.`, j.next];
        return [`Code: ${j.code}`, j.tell_the_person];
      }),
  },
  wait: {
    usage: "reflex wait [--timeout <seconds>] [--after <send>] [--space <space>]",
    summary: "Wait for the person's next Send (wait_for_user). --timeout 0 reads the Inbox",
    flags: ["timeout", "after", "space"],
    run: async (_p, f) => {
      const args: Record<string, unknown> = { timeout_s: int(f.timeout, "timeout") ?? 300 };
      for (const k of ["after", "space"]) if (typeof f[k] === "string") args[k] = f[k];
      const ac = new AbortController();
      process.once("SIGINT", () => ac.abort());
      const code = await call(
        "wait_for_user",
        args,
        f,
        (r, files) => {
          const j = r.json;
          if (j.status === "still_waiting") return ["still_waiting: nothing yet. Run the same command again."];
          return [
            `${j.kind} ${j.send} from ${j.from.name} in ${j.space}${j.redelivered ? " (redelivered)" : ""}${j.said ? `: "${j.said}"` : ""}`,
            ...j.marks.map(
              (m: any) =>
                `  ${m.id} ${m.kind}${m.on ? ` on ${m.on.join(", ")}` : ""}${m.from || m.to ? ` from ${m.from ?? "?"} to ${m.to ?? "?"}` : ""}${m.text_guess ? ` "${m.text_guess}" (${m.confidence})` : ""}${m.near ? ` near ${m.near}` : ""}${m.moved_since_marked ? " (moved since)" : ""}${m.image ? ` (image ${m.image})` : ""}`,
            ),
            ...j.changes.map((c: any) => `  ${c.kind} ${c.id}${c.file ? ` ${c.file} (${c.mime})` : ""}${c.values ? ` ${JSON.stringify(c.values)}` : ""}${c.image ? ` (image ${c.image})` : ""}`),
            ...(j.element ? [`  on ${j.element}${j.payload ? ` ${JSON.stringify(j.payload)}` : ""}`] : []),
            ...files.map((p, i) => `  image ${i + 1}: ${p}`),
            j.next,
          ];
        },
        {
          signal: ac.signal,
          files: (r) =>
            (r.json.images ?? []).map((img: any) => {
              img.file = join(imageDir(), `${r.json.send}-${img.n}.png`);
              return img.file;
            }),
        },
      );
      if (ac.signal.aborted) return 130;
      return code;
    },
  },
  "adapters add": {
    usage: "reflex adapters add webhook --url <url>",
    summary: "Have your Sends POSTed to a URL as they arrive (a webhook push target), signed with a secret shown once",
    flags: ["url"],
    run: async (p, f) => {
      const usage = "reflex adapters add webhook --url <url>";
      const adapter = need(p, 0, "adapter", usage);
      if (adapter !== "webhook") throw new Usage(`Only a webhook can be added by hand, not '${adapter}'. Usage: ${usage}`);
      if (typeof f.url !== "string") throw new Usage(`Missing --url. Usage: ${usage}`);
      return adapters("add", { adapter, config: { url: f.url } }, f, (j) => [
        `Added ${j.target}: Sends for you are POSTed to ${j.config.url}.`,
        `Secret: ${j.secret}`,
        j.next,
      ]);
    },
  },
  "adapters list": {
    usage: "reflex adapters list",
    summary: "List your push targets: webhooks, Claude Code channels and MCP App views",
    run: (_p, f) =>
      adapters("list", {}, f, (j) =>
        j.targets.length
          ? j.targets.map((t: any) => `${t.target}  ${t.adapter.padEnd(15)} ${t.live ? "live   " : "offline"}  ${t.config.url ?? t.config.harness ?? t.config.host ?? ""}`)
          : ["No push targets. Add a webhook: reflex adapters add webhook --url <url>"],
      ),
  },
  "adapters remove": {
    usage: "reflex adapters remove <target>",
    summary: "Remove one of your push targets and its secret",
    run: (p, f) => adapters("remove", { target: need(p, 0, "target", "reflex adapters remove <target>") }, f, (j) => [`Removed ${j.removed}.`]),
  },
  mcp: {
    usage: "reflex mcp [--channel]",
    summary:
      "Run the MCP server on stdio, for a harness's MCP config. --channel also pushes Sends into a Claude Code session as new turns (a Claude Code channel; start claude with --dangerously-load-development-channels server:<this server's name>)",
    flags: ["channel"],
    run: async (_p, f) => {
      const { runMcp } = await import("./mcp.ts");
      await runMcp({ channel: Boolean(f.channel) || process.env.REFLEX_CHANNEL === "1" });
      return -1; // keep running
    },
  },

};

function help() {
  return ["Reflex — receive Sends from your iPad", "reflex setup · reflex pair · reflex link", ...Object.values(COMMANDS).map(c => c.usage)].join("\n");
}

function parse(argv: string[]) {
  const pos: string[] = [];
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") f.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) f[k] = v;
      else if (["json", "help", "create", "look", "version", "no-open", "channel"].includes(k)) f[k] = true;
      else if (i + 1 < argv.length) f[k] = argv[++i];
      else f[k] = true;
    } else pos.push(a);
  }
  return { pos, f };
}

function closest(word: string, options: string[]) {
  const d = (a: string, b: string) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  return options.map((o) => [d(word, o), o] as const).sort((a, b) => a[0] - b[0])[0];
}

export async function main(argv: string[]): Promise<number> {
  const { pos, f } = parse(argv);
  if (f.version) return out(VERSION), 0;
  const two = pos.slice(0, 2).join(" ");
  const key = COMMANDS[two] ? two : COMMANDS[pos[0] ?? ""] ? pos[0] : undefined;
  if (!key) {
    if (!pos.length || f.help) return out(help()), pos.length ? 0 : f.help ? 0 : 2;
    const [dist, near] = closest(two || pos[0], Object.keys(COMMANDS));
    errLine("invalid_input", `Unknown command 'reflex ${pos.join(" ")}'.`, dist <= 4 ? `Did you mean 'reflex ${near}'?` : "Run reflex --help for the commands.", dist <= 4 ? [`reflex ${near} --help`] : ["reflex --help"]);
    return 2;
  }
  const cmd = COMMANDS[key];
  if (f.help) {
    // A command that wraps a tool also prints that tool's text, so a CLI Agent learns the op shapes an MCP Agent sees.
    const tool = /\((\w+)/.exec(cmd.summary)?.[1];
    const guide = tool && (TOOLS as readonly string[]).includes(tool) ? `\n\n${description(tool as (typeof TOOLS)[number])}` : "";
    out(`${cmd.summary}\n\nUsage: ${cmd.usage}\n\nAlso: --json, --agent <name>${guide}`);
    return 0;
  }
  const known = new Set([...(cmd.flags ?? []), "json", "agent", "help"]);
  const unknown = Object.keys(f).filter((k) => !known.has(k));
  try {
    if (unknown.length) throw new Usage(`Unknown flag --${unknown[0]} for 'reflex ${key}'. Usage: ${cmd.usage}`, [`reflex ${key} --help`]);
    return await cmd.run(pos.slice(key.split(" ").length), f);
  } catch (e) {
    if (e instanceof Usage) {
      errLine("invalid_input", e.message, `See: reflex ${key} --help`, e.next.length ? e.next : [`reflex ${key} --help`]);
      return 2;
    }
    if (e instanceof NoLink) errLine("unavailable", e.message, "Ask the person to run `reflex setup` (or `reflex link`), then run this again.", ["reflex setup"]);
    else errLine("unavailable", (e as Error).message, "Check the Link's log (~/.reflex/link/link.log) or its terminal for errors.");
    return 1;
  } finally {
    if (key !== "mcp") client?.close();
  }
}
