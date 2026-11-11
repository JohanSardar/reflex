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
import { authorCommands } from "../author/commands.ts";

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

const list = (v: string | boolean | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
function bounds(v: string | boolean | undefined) {
  if (typeof v !== "string") return undefined;
  const n = v.split(",").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isInteger(x))) throw new Usage(`--bounds takes x,y,width,height as integers, not '${v}'.`);
  return n;
}
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
  if (f.json) out(JSON.stringify(r.json));
  else for (const line of human(r, files)) out(line);
  return 0;
}

const outlineLines = (items: any[]) =>
  items.map((e) => `${e.id.padEnd(14)} ${e.type.padEnd(10)} by ${String(e.by).padEnd(12)} [${e.bounds.join(", ")}]${e.text ? `  ${JSON.stringify(e.text)}` : ""}${e.from ? `  ${e.from} → ${e.to}` : ""}`);
const tail = (j: any) => (j.pending_sends ? [`📥 ${j.pending_sends} pending Send${j.pending_sends === 1 ? "" : "s"}: reflex wait --timeout 0`] : []);

function readInput(f: Flags): any {
  let text: string | undefined;
  if (typeof f.input === "string") text = f.input;
  else if (typeof f.file === "string") text = readFileSync(resolve(f.file), "utf8");
  else if (typeof f.ops === "string") text = `{"ops": ${f.ops}}`;
  else if (!process.stdin.isTTY) text = readFileSync(0, "utf8");
  if (!text?.trim()) throw new Usage("No batch given. Pass --ops '<JSON list>', --input '<apply JSON>', --file <path>, or pipe the apply JSON on stdin.");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Usage(`The batch is not valid JSON: ${(e as Error).message}`);
  }
}

const COMMANDS: Record<string, Cmd> = {
  "spaces list": {
    usage: "reflex spaces list",
    summary: "List Spaces with pending Sends (list_spaces)",
    run: (_p, f) =>
      call("list_spaces", {}, f, (r) => [
        ...(r.json.spaces.length ? r.json.spaces.map((s: any) => `${s.space.padEnd(20)} ${s.pending_sends} pending  agents: ${(s.agents ?? []).join(", ") || "none"}`) : ["No Spaces yet. Create one: reflex spaces create <space>"]),
      ]),
  },
  "spaces open": {
    usage: "reflex spaces open <space> [--create] [--title <text>] [--size infinite|pages|width] [--width <n>]",
    summary: "Open a Space and see its outline and pending Sends (open_space)",
    flags: ["create", "title", "size", "width"],
    run: (p, f) => openSpace(p, f, Boolean(f.create), "reflex spaces open <space>"),
  },
  "spaces create": {
    usage: "reflex spaces create <space> [--title <text>] [--size infinite|pages|width] [--width <n>]",
    summary: "Create a Space, or open it if it exists (open_space create: true)",
    flags: ["title", "size", "width"],
    run: (p, f) => openSpace(p, f, true, "reflex spaces create <space>"),
  },
  "elements apply": {
    usage: "reflex elements apply <space> (--ops '<JSON list>' | --input '<apply JSON>' | --file <path> | stdin) [--in-reply-to <send>] [--look] [--request <id>] [--out <file.png>]",
    summary: "Apply one atomic batch of ops (apply)",
    flags: ["ops", "input", "file", "in-reply-to", "look", "request", "out"],
    run: (p, f) => {
      const input = readInput(f);
      const args = Array.isArray(input) ? { ops: input } : { ...input };
      args.space = p[0] ?? args.space;
      if (!args.space) throw new Usage("Missing <space>. Usage: reflex elements apply <space> --ops '[...]'");
      if (typeof f["in-reply-to"] === "string") args.in_reply_to = f["in-reply-to"];
      if (f.look) args.look = true;
      if (typeof f.request === "string") args.request = f.request;
      return call("apply", args, f, (r, files) => [
        `Applied ${r.json.batch}.`,
        ...Object.entries(r.json.ids ?? {}).map(([k, v]) => `  ${k} → ${v}`),
        ...(r.json.repaired ?? []).map((x: string) => `  repaired: ${x}`),
        ...(r.json.lints ?? []).map((l: any) => `  lint ${l.code} on ${l.id}: ${l.msg} Fix: ${l.fix}`),
        ...(files.length ? [`  look: ${files[0]} covers [${r.json.look.bounds.join(", ")}]`] : []),
        ...tail(r.json),
      ], { files: typeof f.out === "string" ? () => [resolve(f.out as string)] : undefined });
    },
  },
  "elements read": {
    usage: "reflex elements read <space> [--detail outline|full|strokes] [--ids <a,b>] [--near <id>] [--bounds x,y,w,h]",
    summary: "Read the scene as text (read)",
    flags: ["detail", "ids", "near", "bounds"],
    run: (p, f) => {
      const space = need(p, 0, "space", "reflex elements read <space>");
      const args: Record<string, unknown> = { space };
      if (typeof f.detail === "string") args.detail = f.detail;
      if (f.ids) args.ids = list(f.ids);
      if (typeof f.near === "string") args.near = f.near;
      if (f.bounds) args.bounds = bounds(f.bounds);
      return call("read", args, f, (r) => [
        ...(r.json.outline ? outlineLines(r.json.outline) : []),
        ...(r.json.elements ?? []).map((e: any) => JSON.stringify(e)),
        ...(r.json.strokes ?? []).map((s: any) => `${s.id}${s.mark ? ` (${s.mark})` : ""}: ${s.points.length} points`),
        ...(r.json.elsewhere && (r.json.elsewhere.on_screen || r.json.elsewhere.off_screen) ? [`elsewhere: ${r.json.elsewhere.on_screen} on screen, ${r.json.elsewhere.off_screen} off screen`] : []),
        ...tail(r.json),
      ]);
    },
  },
  look: {
    usage: "reflex look <space> [--ids <a,b>] [--bounds x,y,w,h] [--width <px>] [--out <file.png>]",
    summary: "Render part of a Space to a PNG (look)",
    flags: ["ids", "bounds", "width", "out"],
    run: (p, f) => {
      const space = need(p, 0, "space", "reflex look <space>");
      const args: Record<string, unknown> = { space };
      if (f.ids) args.ids = list(f.ids);
      if (f.bounds) args.bounds = bounds(f.bounds);
      if (f.width !== undefined) args.width = int(f.width, "width");
      const file = typeof f.out === "string" ? resolve(f.out) : join(imageDir(), `look-${space}-${Date.now()}.png`);
      return call("look", args, f, (r) => [file, `covers [${r.json.bounds.join(", ")}] at ${r.json.px.join("x")} px`, ...tail(r.json)], {
        files: (r) => {
          r.json.file = file; // look.output's CLI-only field
          return [file];
        },
      });
    },
  },
  wait: {
    usage: "reflex wait [--timeout <seconds>] [--after <send>] [--space <space>] [--region <id>] [--element <id>]",
    summary: "Wait for the person's next Send (wait_for_user). --timeout 0 reads the Inbox",
    flags: ["timeout", "after", "space", "region", "element"],
    run: async (_p, f) => {
      const args: Record<string, unknown> = { timeout_s: int(f.timeout, "timeout") ?? 300 };
      for (const k of ["after", "space", "region", "element"]) if (typeof f[k] === "string") args[k] = f[k];
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
            ...j.marks.map((m: any) => `  ${m.id} ${m.kind}${m.on ? ` on ${m.on.join(", ")}` : ""}${m.near ? ` near ${m.near}` : ""}${m.image ? ` (image ${m.image})` : ""}`),
            ...j.changes.map((c: any) => `  ${c.kind} ${c.id}`),
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
  mcp: {
    usage: "reflex mcp",
    summary: "Run the MCP server on stdio, for a harness's MCP config",
    run: async () => {
      const { runMcp } = await import("./mcp.ts");
      await runMcp();
      return -1; // keep running
    },
  },
  "dev person": {
    usage: "reflex dev person circle|underline <space> <element> | reflex dev person send <space> [--said <text>]",
    summary: "Act as the person without an iPad (a Link started with --dev): mark an Element, press Send",
    flags: ["said", "trigger"],
    run: async (p, f) => {
      const [action, space, target] = p;
      if (!["circle", "underline", "send"].includes(action ?? "")) throw new Usage("Usage: reflex dev person circle|underline <space> <element> | send <space> [--said <text>]");
      if (!space) throw new Usage("Missing <space>.");
      if (action !== "send" && !target) throw new Usage("Missing <element>.");
      const r = await (await host()).person(action, { space, target, said: f.said, trigger: f.trigger });
      if (r.isError) {
        process.stderr.write(JSON.stringify(r.json) + "\n");
        return 1;
      }
      out(f.json ? JSON.stringify(r.json) : action === "send" ? `Sent ${r.json.send} to ${r.json.recipients.join(", ") || "nobody (no Agent has opened this Space)"}` : `Drew ${r.json.id}`);
      return 0;
    },
  },
};

// The author kit, its own group: offline, no Link needed.
const AUTHOR = authorCommands(Usage);
Object.assign(COMMANDS, AUTHOR);

async function openSpace(p: string[], f: Flags, create: boolean, usage: string) {
  const space = need(p, 0, "space", usage);
  const args: Record<string, unknown> = { space };
  if (create) args.create = true;
  if (typeof f.title === "string") args.title = f.title;
  if (typeof f.size === "string") args.size = f.size;
  if (f.width !== undefined) args.width = int(f.width, "width");
  return call("open_space", args, f, (r) => [
    `${r.json.created ? "Created" : "Opened"} ${r.json.space} as ${r.json.you.name} (${r.json.you.agent}).`,
    ...outlineLines(r.json.scene),
    r.json.next,
  ]);
}

function help(): string {
  const rows = Object.entries(COMMANDS).filter(([k]) => !(k in AUTHOR)).map(([k, c]) => `  reflex ${k.padEnd(16)} ${c.summary}`);
  const author = Object.entries(AUTHOR).map(([k, c]) => `  reflex ${k.padEnd(16)} ${c.summary}`);
  return [
    `reflex ${VERSION}: the Reflex canvas from a shell`,
    "",
    "Usage: reflex <group> <action> [<resource>] [flags]",
    "",
    "  reflex link             Start the Reflex Link and show a pairing code (reflex link --help)",
    ...rows,
    "",
    "Author kit (offline, no Link needed):",
    ...author,
    "",
    "Global flags:",
    "  --json            Print exactly one JSON document",
    "  --agent <name>    Who you are (default: from REFLEX_AGENT_NAME or the harness)",
    "  -h, --help        Help for any command (works offline)",
    "",
    "Loop: reflex spaces create <space> → reflex elements apply <space> --ops '[...]' → reflex wait --after <send>",
  ].join("\n");
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
      else if (["json", "help", "create", "look", "version", "no-open"].includes(k)) f[k] = true;
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
    if (e instanceof NoLink) errLine("unavailable", e.message, "Start the Link with `reflex link`, then run this again.", ["reflex link"]);
    else errLine("unavailable", (e as Error).message, "Check the Link's terminal for errors.");
    return 1;
  } finally {
    if (key !== "mcp") client?.close();
  }
}
