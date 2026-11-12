// reflex setup, reflex pair: first-time setup in one command, and a fresh
// pairing code at any time, from any terminal.
//
//   reflex setup   puts `reflex` on the PATH, registers the MCP server in Claude Code and Codex (once),
//                  makes sure a Link runs (in the background if none does), and shows a pairing code
//   reflex pair    a new pairing code from the running Link (starting it if needed)
//
// Nothing here asks for a password: no launchctl, no keychain, no sudo. The Link it starts runs
// detached from this terminal and stops with `reflex link stop`; `reflex mcp` and the CLI start it
// again when they need it (after a restart, say).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { homeDir } from "../home.ts";
import { qrText } from "../pairing/offer.ts";
import { LinkClient, RpcError } from "../rpc/client.ts";
import { ensureLink } from "../../agent/src/host/start.ts";
import { claudeEntry, codexConfig, isReflex, sameEntry, type ClaudeEntry, type Want } from "./harness-config.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(REPO, "agent/bin/reflex.mjs");
/** The Node on the PATH (often a symlink that survives upgrades), else the one running this. */
let NODE = process.execPath;
const MARK = "# Made by `reflex setup`";

const HELP = `reflex setup: set up Reflex on this computer, then pair your iPad.

Usage
  reflex setup            Put reflex on your PATH, add Reflex to Claude Code and Codex, start the Link,
                          and show the code to scan on your iPad
  reflex pair             Show a new pairing code (the Link must be this computer's; it starts if needed)

Options
  --home <dir>            Link profile folder (default $REFLEX_HOME or ~/.reflex/link)
  --bin <dir>             Where the reflex command goes (default ~/.local/bin)
  --scope <user|local|project>   Claude Code scope to add Reflex in (default user: every project)
  --no-claude, --no-codex Don't touch that harness's config
  --register              With --home: point Claude Code and Codex at that profile (without it, a --home
                          setup leaves their config alone, so a test profile never takes over your own)
  --no-wait               Don't wait for the iPad to pair
  -h, --help
`;

const { values: f, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    bin: { type: "string" },
    scope: { type: "string", default: "user" },
    "no-claude": { type: "boolean", default: false },
    "no-codex": { type: "boolean", default: false },
    "no-wait": { type: "boolean", default: false },
    register: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const cmd = positionals[0] ?? "setup";
const dir = homeDir(f.home);
/** Not the default profile: the harnesses are told which one, with REFLEX_HOME. */
const customHome = dir !== resolve(homedir(), ".reflex", "link");
process.env.REFLEX_HOME = dir; // the Link this starts, and the one the surfaces reach
const say = (s = ""): void => void process.stdout.write(s + "\n");
const ok = (s: string): void => say(`  ✓ ${s}`);
const note = (s: string): void => say(`  · ${s}`);

/** Whether a program is on the PATH. */
function which(name: string): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

{
  const onPath = which("node");
  if (onPath) NODE = onPath;
}

/** The `reflex` command: a two-line shell script that runs this checkout with this Node. */
function shim(): void {
  const binDir = resolve(f.bin ?? join(homedir(), ".local", "bin"));
  const file = join(binDir, "reflex");
  const body = `#!/bin/sh\n${MARK}: runs the Reflex CLI from ${REPO}.\nexec "${NODE}" "${BIN}" "$@"\n`;
  if (existsSync(file) && !readFileSync(file, "utf8").includes(MARK)) {
    note(`${file} exists and isn't one setup made, so it was left alone. Use: node ${BIN} …`);
    return;
  }
  const same = existsSync(file) && readFileSync(file, "utf8") === body;
  mkdirSync(binDir, { recursive: true });
  if (!same) writeFileSync(file, body);
  chmodSync(file, 0o755);
  const onPath = (process.env.PATH ?? "").split(delimiter).some((d) => resolve(d) === binDir);
  if (onPath) return ok(`reflex is on your PATH (${file})`);
  if (f.bin) return note(`${file} is ready; ${binDir} isn't on your PATH, so call it by its full path`);
  // The default folder, not yet on the PATH: add it for new terminals, once.
  const shell = (process.env.SHELL ?? "").endsWith("bash") ? ".bash_profile" : ".zprofile";
  const profile = join(homedir(), shell);
  const line = `export PATH="$HOME/.local/bin:$PATH" ${MARK}`;
  if (!existsSync(profile) || !readFileSync(profile, "utf8").includes(line)) appendFileSync(profile, `\n${line}\n`);
  ok(`reflex is at ${file}; added ${binDir} to your PATH in ~/${shell} (new terminals have it)`);
}

/** What each harness runs: this checkout's CLI with this Node, as `reflex mcp`, for this profile. */
const want = (channel: boolean): Want => ({ command: NODE, args: [BIN, "mcp", ...(channel ? ["--channel"] : [])], home: customHome ? dir : null });

/** A --home setup is a test profile unless --register says otherwise: the harnesses keep pointing at the person's own. */
const register = (who: string): boolean => {
  if (!customHome || f.register) return true;
  note(`left ${who} alone: --home ${dir} isn't your default profile (pass --register to point ${who} at it)`);
  return false;
};

/** Where Claude Code keeps an entry of each scope: user and local in ~/.claude.json, project in ./.mcp.json. */
function claudeEntryNow(scope: string): ClaudeEntry | undefined {
  const read = (file: string): Record<string, any> => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  if (scope === "project") return read(join(process.cwd(), ".mcp.json")).mcpServers?.reflex;
  const cfg = read(join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json"));
  return scope === "user" ? cfg.mcpServers?.reflex : cfg.projects?.[process.cwd()]?.mcpServers?.reflex;
}

function claude(): void {
  if (f["no-claude"]) return;
  if (!which("claude")) return note("Claude Code isn't installed (no `claude` on the PATH); skipped");
  const scope = f.scope ?? "user";
  if (!["user", "local", "project"].includes(scope)) throw new Error(`--scope is user, local or project, not '${scope}'.`);
  if (!register("Claude Code")) return;
  const run = (args: string[]): string => execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  // Read from Claude Code's config, not `claude mcp get`, which starts the server to check its health (30 s and more).
  const old = claudeEntryNow(scope);
  if (old && !isReflex(old)) return note(`Claude Code already has a server called reflex (${scope} scope) that isn't Reflex; left it alone`);
  const entry = claudeEntry(old, want(true));
  if (old && sameEntry(old, entry)) return ok(`Claude Code already has Reflex (${scope} scope)`);
  // `add` refuses a name that is there, so the old entry goes first, and comes back if the new one can't be added.
  if (old) run(["mcp", "remove", "reflex", "-s", scope]);
  try {
    run(["mcp", "add-json", "-s", scope, "reflex", JSON.stringify(entry)]);
  } catch (e) {
    if (old) run(["mcp", "add-json", "-s", scope, "reflex", JSON.stringify(old)]);
    throw e;
  }
  ok(old ? `updated Reflex in Claude Code (${scope} scope; your other settings for it kept)` : `added Reflex to Claude Code (${scope} scope)`);
}

/** Codex's config.toml: Reflex's keys in [mcp_servers.reflex] (or `reflex = {…}`), everything else left as it was. */
function codex(): void {
  if (f["no-codex"]) return;
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!which("codex") && !existsSync(codexHome)) return note("Codex isn't installed; skipped");
  if (!register("Codex")) return;
  const file = join(codexHome, "config.toml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = codexConfig(text, want(false));
  if (next === text) return ok("Codex already has Reflex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(file, next);
  ok(`${/^\s*\[mcp_servers\.reflex\]|^\s*"?reflex"?\s*=/m.test(text) ? "updated" : "added"} Reflex in Codex (${file})`);
}

async function link(): Promise<void> {
  const r = await ensureLink();
  const pid = existsSync(join(dir, "link.json")) ? JSON.parse(readFileSync(join(dir, "link.json"), "utf8")).pid : "?";
  if (r.started) ok(`started the Reflex Link in the background (pid ${pid}; log ${r.log}; stop it with \`reflex link stop\`)`);
  else ok(`the Reflex Link is running (pid ${pid})`);
}

/** A fresh pairing code from the running Link, then (in a terminal) waits for the iPad to pair. */
async function pair(): Promise<void> {
  const c = await LinkClient.connect(dir, "admin");
  try {
    const o = await c.call<{ uri: string; offer: string; expires: number; line: string }>("pair.offer");
    if (f.json) return say(JSON.stringify(o));
    say("");
    say(await qrText(o.uri));
    say(o.uri);
    say("");
    say(o.line);
    if (f["no-wait"] || !process.stdout.isTTY) return;
    say("Waiting for your iPad… (Ctrl-C stops waiting; the Link keeps running.)");
    while (Date.now() < o.expires) {
      await new Promise((r) => setTimeout(r, 1000));
      // The code itself, so an iPad that was paired already and scans again counts too.
      const u = await c.call<{ used: boolean; name?: string; approves?: boolean }>("pair.check", { offer: o.offer });
      if (!u.used) continue;
      say(`\nPaired with ${u.name ?? "your iPad"}. Done: start Claude Code (\`claude\`) or Codex and ask it to draw on your iPad.`);
      say(
        u.approves
          ? `The first time, your iPad asks "Allow … to use your Spaces?": tap Allow.`
          : `Approving Agents stays with the iPad you paired first: tap Allow there.`,
      );
      return;
    }
    say("The code expired. Run `reflex pair` for a new one.");
  } finally {
    c.close();
  }
}

async function main(): Promise<void> {
  if (f.help) return void process.stdout.write(HELP);
  if (cmd === "pair") {
    await link();
    return pair();
  }
  if (cmd !== "setup") throw new Error(`Unknown command '${cmd}'. Run reflex setup --help.`);
  say("Setting up Reflex");
  shim();
  claude();
  codex();
  await link();
  if (which("claude") && !f["no-claude"] && (!customHome || f.register))
    note("for Sends pushed into Claude Code as new turns, start it with: claude --dangerously-load-development-channels server:reflex");
  await pair();
}

main().catch((e: Error) => {
  const fix = e instanceof RpcError ? e.fix : undefined;
  console.error(`Error: ${e.message}${fix ? `\n${fix}` : ""}`);
  process.exit(1);
});
