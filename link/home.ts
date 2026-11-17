// A Link's home folder: its identity, its local RPC credential and socket, its
// database and its assets. One folder per user profile; `REFLEX_HOME` or
// `--home` picks another (two Links on one machine use two homes).
//
//   identity.json   device key, person, actor (0600)
//   rpc.key         the per-profile credential local Agent connections present (0600)
//   admin.key       the credential `reflex-link` commands present (0600)
//   link.db         Sends, Inbox, control catalog
//   assets/         content-addressed asset store
//   link.json       where the running Link listens (socket, LAN port, pid)
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Person } from "./pairing/catalog.ts";
import { type DeviceKey, loadDeviceKey, newDeviceKey } from "./pairing/crypto.ts";

export interface Identity {
  /** When this profile was made (ms); profiles from before this field use identity.json's birth time. */
  created_at?: number;
  key: DeviceKey;
  person: Person;
  name: string; // this device's display name
  actor: string; // this replica's Automerge actor, hex
}

export interface Home {
  dir: string;
  db: string;
  assets: string;
  socket: string;
  runtime: string;
}

export function homeDir(flag?: string): string {
  return resolve(flag ?? process.env.REFLEX_HOME ?? join(homedir(), ".reflex", "link"));
}

export function home(dir: string): Home {
  // Unix socket paths are limited to ~104 bytes; fall back to the temp folder.
  let socket = join(dir, "link.sock");
  if (Buffer.byteLength(socket) > 100) {
    const h = createHash("sha256").update(dir).digest("hex").slice(0, 12);
    socket = join(tmpdir(), `reflex-link-${h}.sock`);
  }
  return { dir, db: join(dir, "link.db"), assets: join(dir, "assets"), socket, runtime: join(dir, "link.json") };
}

function writeSecret(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** What the person calls this computer ("MacBook Pro"): macOS's computer name, else the host name. */
function computerName(): string {
  if (process.platform === "darwin") {
    try {
      const n = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (n) return n;
    } catch {}
  }
  return hostname().replace(/\.local$/, "");
}

/** Loads this device's identity, making one on first run. */
export function identity(dir: string, opts: { name?: string; person?: string } = {}): Identity {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "identity.json");
  if (!existsSync(path)) {
    const { pem } = newDeviceKey();
    const personName = opts.person ?? process.env.USER ?? "Me";
    const body = {
      v: 0,
      key: pem,
      person: { id: `p_${randomBytes(6).toString("hex")}`, name: personName },
      name: opts.name ?? computerName(),
      actor: randomBytes(16).toString("hex"),
      created_at: Date.now(),
    };
    writeSecret(path, JSON.stringify(body, null, 2));
  }
  const j = JSON.parse(readFileSync(path, "utf8"));
  // Profiles made before the computer name was used are named after a network host name ("wirelessprv-10-….edu"),
  // which changes with the network and means nothing on the iPad: show the computer name instead.
  const name = opts.name ?? (/^[\w-]+(\.[\w-]+)+$/.test(j.name) ? computerName() : j.name);
  return {
    key: loadDeviceKey(j.key),
    person: j.person,
    name,
    actor: j.actor,
    ...(j.created_at ? { created_at: j.created_at } : {}),
  };
}

/** A per-profile local RPC credential: `rpc.key` for Agents, `admin.key` for the user's commands. */
export function localKey(dir: string, file: "rpc.key" | "admin.key"): string {
  const path = join(dir, file);
  if (!existsSync(path)) writeSecret(path, randomBytes(32).toString("base64url"));
  return readFileSync(path, "utf8").trim();
}

/**
 * Binds this device to another person: a new device joining someone's devices
 * becomes theirs. Only allowed before it holds anything of its own.
 */
export function adoptPerson(dir: string, person: Person): void {
  const path = join(dir, "identity.json");
  const j = JSON.parse(readFileSync(path, "utf8"));
  j.person = person;
  writeSecret(path, JSON.stringify(j, null, 2));
}
