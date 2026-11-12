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
        ...(r.json.files ?? []).flatMap((x: any) => [
          `file ${x.id}: ${x.name} (${x.mime}, ${x.size} bytes)${x.file ? ` → ${x.file}` : ""}${x.missing ? " (not synced to this Link yet)" : ""}`,
          ...(x.text !== undefined ? [x.text + (x.truncated ? "\n[truncated]" : "")] : []),
        ]),
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
  "elements exec": {
    usage: "reflex elements exec <space> (--code '<js>' | --file <path.js> | stdin) [--in-reply-to <send>] [--look] [--request <id>] [--out <file.png>]",
    summary: "Run JavaScript that writes one batch (exec)",
    flags: ["code", "file", "in-reply-to", "look", "request", "out"],
    run: (p, f) => {
      const space = need(p, 0, "space", "reflex elements exec <space> --code '...'");
      let code: string | undefined;
      if (typeof f.code === "string") code = f.code;
      else if (typeof f.file === "string") code = readFileSync(resolve(f.file), "utf8");
      else if (!process.stdin.isTTY) code = readFileSync(0, "utf8");
      if (!code?.trim()) throw new Usage("No code given. Pass --code '<js>', --file <path.js>, or pipe it on stdin.");
      const args: Record<string, unknown> = { space, code };
      if (typeof f["in-reply-to"] === "string") args.in_reply_to = f["in-reply-to"];
      if (f.look) args.look = true;
      if (typeof f.request === "string") args.request = f.request;
      return call("exec", args, f, (r, files) => [
        r.json.batch ? `Applied ${r.json.batch}.` : "Wrote nothing.",
        ...Object.entries(r.json.ids ?? {}).map(([k, v]) => `  ${k} → ${v}`),
        ...(r.json.repaired ?? []).map((x: string) => `  repaired: ${x}`),
        ...(r.json.lints ?? []).map((l: any) => `  lint ${l.code} on ${l.id}: ${l.msg} Fix: ${l.fix}`),
        ...(r.json.logs ?? []).map((l: string) => `  log: ${l}`),
        ...(r.json.result !== null && r.json.result !== undefined ? [`result: ${JSON.stringify(r.json.result)}`] : []),
        ...(files.length ? [`  look: ${files[0]} covers [${r.json.look.bounds.join(", ")}]`] : []),
        ...tail(r.json),
      ], { files: typeof f.out === "string" ? () => [resolve(f.out as string)] : undefined });
    },
  },
  "elements revert": {
    usage: "reflex elements revert <space> [--batch <id> | --last <n>]",
    summary: "Undo your own batches: one by ID, or your last n (revert)",
    flags: ["batch", "last"],
    run: (p, f) => {
      const space = need(p, 0, "space", "reflex elements revert <space> --last 1");
      if (f.batch && f.last) throw new Usage("Pass --batch or --last, not both.");
      const args: Record<string, unknown> = { space };
      if (typeof f.batch === "string") args.batch = f.batch;
      else args.last = int(f.last, "last") ?? 1;
      return call("revert", args, f, (r) => [
        `Reverted ${r.json.reverted.join(", ")} as ${r.json.batch}.`,
        ...(r.json.kept ?? []).map((k: any) => `  kept ${k.id}: ${k.why}`),
        ...tail(r.json),
      ]);
    },
  },
  "docs read": {
    usage: "reflex docs read <topic>",
    summary: "Read a Guide; 'index' lists every type, Recipe and Guide (read_me)",
    run: (p, f) => call("read_me", { topic: need(p, 0, "topic", "reflex docs read index") }, f, (r) => [r.json.text, ...tail(r.json)]),
  },
  "recipes list": {
    usage: "reflex recipes list",
    summary: "List the Recipes, built in and in the person's Library (read_me index)",
    run: (_p, f) =>
      call("read_me", { topic: "index" }, f, (r) => {
        const lines = String(r.json.text).split("\n");
        const from = lines.findIndex((l) => l === "## Recipes");
        const to = lines.findIndex((l, i) => i > from && l.startsWith("## "));
        return [...lines.slice(from + 1, to < 0 ? undefined : to).filter((l) => l.trim()), ...tail(r.json)];
      }),
  },
  "recipes apply": {
    usage: "reflex recipes apply <space> <name> [--params '<JSON>'] [--at '<JSON placement>'] [--in-reply-to <send>] [--look] [--request <id>] [--out <file.png>]",
    summary: "Apply a ready-made pattern as one batch (recipe)",
    flags: ["params", "at", "in-reply-to", "look", "request", "out"],
    run: (p, f) => {
      const space = need(p, 0, "space", "reflex recipes apply <space> <name>");
      const name = need(p, 1, "name", "reflex recipes apply <space> <name>");
      const json = (k: string) => {
        if (typeof f[k] !== "string") return undefined;
        try {
          return JSON.parse(f[k] as string);
        } catch (e) {
          throw new Usage(`--${k} is not valid JSON: ${(e as Error).message}`);
        }
      };
      const args: Record<string, unknown> = { space, name };
      if (f.params) args.params = json("params");
      if (f.at) args.at = json("at");
      if (typeof f["in-reply-to"] === "string") args.in_reply_to = f["in-reply-to"];
      if (f.look) args.look = true;
      if (typeof f.request === "string") args.request = f.request;
      return call("recipe", args, f, (r, files) => [
        `Applied ${name} as ${r.json.batch}:`,
        ...r.json.ops.map((o: any) => `  ${o.op} ${o.type ?? ""} ${o.id ?? (o.ids ?? []).join(",")}`.trimEnd()),
        ...(r.json.repaired ?? []).map((x: string) => `  repaired: ${x}`),
        ...(r.json.lints ?? []).map((l: any) => `  lint ${l.code} on ${l.id}: ${l.msg} Fix: ${l.fix}`),
        ...(files.length ? [`  look: ${files[0]} covers [${r.json.look.bounds.join(", ")}]`] : []),
        ...tail(r.json),
      ], { files: typeof f.out === "string" ? () => [resolve(f.out as string)] : undefined });
    },
  },
  "spaces attention": {
    usage: "reflex spaces attention <space> --message <text> [--ids <a,b>]",
    summary: "Ask the person to come to a Space, with a banner they can tap (request_attention)",
    flags: ["message", "ids"],
    run: (p, f) => {
      const space = need(p, 0, "space", "reflex spaces attention <space> --message '...'");
      if (typeof f.message !== "string") throw new Usage("Missing --message <text>.");
      const args: Record<string, unknown> = { space, message: f.message };
      if (f.ids) args.ids = list(f.ids);
      return call("request_attention", args, f, (r) => [
        r.json.status === "shown" ? "Shown on the person's device." : r.json.status === "queued" ? "Queued: it shows when one of their devices connects." : "They are already looking at it.",
        ...tail(r.json),
      ]);
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
  "dev person": {
    usage:
      "reflex dev person circle|underline|strike <space> <element> | arrow <space> <from> <to> | write <space> <near> <text> [--confidence <0-1>] | write-line <space> <region> <text> [--confidence <0-1>] | say <space> <words> | move <space> <element> --by dx,dy | add-file <space> <path> [--near <element>] | tap <space> <element> [--on tap|long_press|…] [--values '<JSON>'] | revert <space> <agent> | history <space> | send <space> [--said <text>] [--region <region>]",
    summary: "Act as the person without an iPad (a Link started with --dev): mark, write, speak, add files, tap, revert, press Send",
    flags: ["said", "trigger", "confidence", "by", "near", "on", "values", "region"],
    run: async (p, f) => {
      const [action, space, target, extra] = p;
      const actions = ["circle", "underline", "strike", "arrow", "write", "write-line", "say", "move", "add-file", "tap", "revert", "history", "send"];
      const usage = COMMANDS["dev person"].usage;
      if (!actions.includes(action ?? "")) throw new Usage(`Usage: ${usage}`);
      if (!space) throw new Usage("Missing <space>.");
      if (!["send", "history"].includes(action) && !target) throw new Usage(`Missing <${action === "say" ? "words" : action === "add-file" ? "path" : action === "revert" ? "agent" : action === "write-line" ? "region" : "element"}>.`);
      const args: Record<string, unknown> = { space, target, said: f.said, trigger: f.trigger };
      if (action === "arrow") {
        if (!extra) throw new Usage("Missing <to>.");
        args.to = extra;
      }
      if (action === "write") {
        if (!extra) throw new Usage("Missing <text>.");
        args.text = p.slice(3).join(" ");
        if (f.confidence !== undefined) args.confidence = Number(f.confidence);
      }
      if (action === "write-line") {
        if (!extra) throw new Usage("Missing <text>.");
        args.text = p.slice(3).join(" ");
        if (f.confidence !== undefined) args.confidence = Number(f.confidence);
      }
      if (action === "send" && typeof f.region === "string") args.region = f.region;
      if (action === "say") args.text = p.slice(2).join(" ");
      if (action === "move") {
        const by = typeof f.by === "string" ? f.by.split(",").map(Number) : [];
        if (by.length !== 2 || by.some((n) => !Number.isFinite(n))) throw new Usage("--by takes dx,dy.");
        args.by = by;
      }
      if (action === "add-file") {
        const path = resolve(target);
        args.name = basename(path);
        args.data = readFileSync(path).toString("base64");
        if (typeof f.near === "string") args.near = f.near;
      }
      if (action === "tap") {
        if (typeof f.on === "string") args.on = f.on;
        if (typeof f.values === "string") args.values = JSON.parse(f.values);
      }
      if (action === "revert") args.agent = p.slice(2).join(" ");
      const r = await (await host()).person(action, args);
      if (r.isError) {
        process.stderr.write(JSON.stringify(r.json) + "\n");
        return 1;
      }
      const j = r.json;
      if (f.json) out(JSON.stringify(j));
      else if (action === "send") out(`Sent ${j.send} to ${j.recipients.join(", ") || "nobody (no Agent has opened this Space)"}`);
      else if (action === "tap") out(`Fired ${j.send} (${j.kind}: ${j.actions.join(", ")})${j.recipients.length ? ` to ${j.recipients.join(", ")}` : ""}`);
      else if (action === "say") out(`Said it (${j.words} words so far)`);
      else if (action === "revert") out(`Reverted ${j.agent}'s ${j.reverted.join(", ")}${j.kept.length ? `; kept ${j.kept.map((k: any) => k.id).join(", ")}` : ""}`);
      else if (action === "history")
        for (const e of j.entries)
          out(`${new Date(e.at).toISOString().slice(11, 19)}  ${e.by.name.padEnd(24)} ${(e.kind === "action" ? e.action : e.kind).padEnd(12)} ${e.state.padEnd(9)} ${e.counts ? `+${e.counts.added} ~${e.counts.changed} -${e.counts.removed}` : `${e.strokes} strokes`}  ${(e.ids ?? []).slice(0, 5).join(", ")}`);
      else out(`Drew ${(j.ids ?? [j.id]).join(", ")}`);
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
    "  reflex setup            First time: add Reflex to Claude Code and Codex, start the Link, pair your iPad",
    "  reflex pair             Show a new code to scan on your iPad",
    "  reflex link             Start the Reflex Link in this terminal (reflex link --help)",
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
