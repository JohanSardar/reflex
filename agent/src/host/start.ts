// Starting the Link when nothing is listening: `reflex mcp`, the CLI and
// `reflex setup` run `reflex link --no-prompt` in the background, detached from
// any terminal, with its output in `<home>/link.log`. The Link takes a lock on
// its profile, so two surfaces starting one at once end up with one Link.
// REFLEX_AUTOSTART=0 turns this off (a surface then answers `unavailable`).
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { home, socketPath } from "./rpc.ts";

const BIN = fileURLToPath(new URL("../../bin/reflex.mjs", import.meta.url));

/** Whether something answers on the Agent socket. */
export function listening(path = socketPath()): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export const logFile = (dir = home()) => join(dir, "link.log");

/**
 * Makes sure a Link is running for this profile, starting one in the background if not.
 * Resolves with whether it started one; throws with the Link's own words if it can't.
 */
export async function ensureLink(o: { wait_s?: number } = {}): Promise<{ started: boolean; log: string }> {
  const dir = home();
  const log = logFile(dir);
  if (await listening()) return { started: false, log };
  if (process.env.REFLEX_AUTOSTART === "0") throw new Error(`The Reflex Link is not running (profile ${dir}). Start it with \`reflex link\`, or run \`reflex setup\`.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [BIN, "link", "--no-prompt"], {
    detached: true, // its own session: closing this terminal or harness doesn't stop it
    stdio: ["ignore", out, out],
    env: { ...process.env, REFLEX_HOME: dir },
  });
  closeSync(out);
  let exited: number | null = null;
  child.once("exit", (code) => (exited = code ?? 1));
  child.unref();
  const deadline = Date.now() + (o.wait_s ?? 30) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    // Up once it wrote link.json, its last step: its admin socket and pairing are ready then too.
    if (existsSync(join(dir, "link.json")) && (await listening())) return { started: true, log };
    // Another Link took the profile first (two surfaces started one at once): wait for that one instead.
    if (exited !== null && !/already running|Another Link is starting/.test(tail(log))) break;
  }
  throw new Error(`The Reflex Link did not start (profile ${dir}). Its log, ${log}, ends:\n${tail(log)}`);
}

function tail(file: string): string {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").trimEnd().split("\n").slice(-6).join("\n");
}
