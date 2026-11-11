// A Link for a T8 test: a temp REFLEX_HOME, this Agent approved up front (the way the
// Link's terminal answers "y", without needing a TTY), and `reflex link --dev` running.
// Every call goes through the real CLI, so a test drives what a person and an Agent drive.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../link/storage/db.ts";
import { home, identity, localKey } from "../link/home.ts";
import { Catalog } from "../link/pairing/catalog.ts";
import { credential } from "../agent/src/host/rpc.ts";

export const AGENT = "T8 Agent";
const node = process.execPath;

export async function startLink(port) {
  const dir = mkdtempSync(join(tmpdir(), "reflex-t8-"));
  const env = { ...process.env, REFLEX_HOME: dir };
  // The agent layer's helpers (credential, socketPath) read REFLEX_HOME when called.
  process.env.REFLEX_HOME = dir;
  identity(dir);
  localKey(dir, "rpc.key");
  localKey(dir, "admin.key");
  const db = openDb(home(dir).db);
  const catalog = new Catalog(db, identity(dir).key);
  catalog.decide(catalog.request(AGENT, credential(AGENT)).id, "approved", "terminal");
  db.close();

  const link = spawn(node, ["agent/bin/reflex.mjs", "link", "--dev", "--no-prompt", "--port", String(port)], { env, stdio: "ignore", detached: true });
  const run = (args, extraEnv = {}) =>
    spawnSync(node, ["agent/bin/reflex.mjs", ...args], { encoding: "utf8", env: { ...env, REFLEX_AGENT_NAME: AGENT, ...extraEnv } });
  /** Runs a command that must succeed and returns its JSON. */
  const json = (args, extraEnv) => {
    const r = run([...args, "--json"], extraEnv);
    if (r.status !== 0) throw new Error(`reflex ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  /** Runs afterwards without REFLEX_AGENT_NAME, so it acts as the person (a Link started with --dev). */
  const person = (args) => json(["dev", "person", ...args], { REFLEX_AGENT_NAME: "" });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    up = run(["spaces", "list"]).status === 0;
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error("the Link never came up");
  const stop = () => {
    link.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, env, run, json, person, stop };
}
