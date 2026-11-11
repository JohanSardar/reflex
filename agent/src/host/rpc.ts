// Local RPC between the thin surfaces (an MCP stdio process, a CLI command)
// and the Link, the one long-lived process that holds the Spaces and runs the
// Agent layer (ARCHITECTURE §1). A Unix socket in the Link's private folder
// plus the Link's per-profile credential (`rpc.key`); never an open loopback
// port. Frames are newline-delimited JSON.
//
// Each Agent also presents a credential of its own, made the first time it
// connects and kept in `agents/` under the profile. The Link knows an Agent
// by it: the person approves it once, and it keeps its ID and color after.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The Link's profile folder, the same one `reflex link` uses. */
export const home = () => resolve(process.env.REFLEX_HOME ?? join(homedir(), ".reflex", "link"));
/** Unix socket paths are capped near 104 bytes; a long profile path gets a short hashed one in tmp. */
export const socketPath = (dir = home()) => {
  const p = join(dir, "agent.sock");
  return Buffer.byteLength(p) <= 100 ? p : join(tmpdir(), `reflex-agent-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}.sock`);
};
export const logPath = (name: string) => join(home(), `${name}.log`);

export class NoLink extends Error {}

/** The Link's credential for Agent connections. */
export function token(): string {
  const file = join(home(), "rpc.key");
  if (!existsSync(file)) throw new NoLink(`No Reflex Link has run from ${home()}. Start one with \`reflex link\`.`);
  return readFileSync(file, "utf8").trim();
}

/** This Agent's own credential, made on first use (0600). */
export function credential(name: string): string {
  const dir = join(home(), "agents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, createHash("sha256").update(name).digest("hex").slice(0, 16) + ".cred");
  if (!existsSync(file)) writeFileSync(file, "rxa_" + randomBytes(32).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

export type Who = { name: string; credential: string };

export type ClientFrame =
  | { t: "hello"; token: string; client: string }
  | { t: "call"; id: number; tool: string; args: unknown; who: Who }
  | { t: "person"; id: number; action: string; args: Record<string, any> }
  | { t: "cancel"; id: number }
  /** Opens a push target for this Agent (a Send Adapter on this connection), held until the connection closes. */
  | { t: "listen"; id: number; who: Who; adapter: string; config: Record<string, unknown> }
  /** Manages this Agent's own push targets that need no live connection (a webhook): add, list, remove. */
  | { t: "adapters"; id: number; who: Who; action: string; args: Record<string, unknown> }
  /** The answer to a push: whether the Send reached the harness. */
  | { t: "pushed"; push: number; ok: boolean; reason?: string };

/** A file's bytes in a result, base64. */
export type WireFile = { id: string; name: string; mime: string; data: string };

export type HostFrame =
  | { t: "ready" }
  | { t: "result"; id: number; json: Record<string, any>; images: string[]; files?: WireFile[]; isError: boolean }
  | { t: "progress"; id: number; elapsed_s: number; timeout_s: number }
  | { t: "failed"; id: number; message: string }
  /** The listen request was accepted: Sends for this Agent are pushed on this connection. */
  | { t: "listening"; id: number; target: string; agent: string }
  /** A Send Bundle pushed to a listening surface. It answers with a "pushed" frame. */
  /** `deadline` (ms since the epoch): after it the Link has counted the push as failed, so the surface must drop it. */
  | { t: "push"; id: number; push: number; json: Record<string, any>; images: string[]; deadline: number };

/** Splits a stream into JSON frames. */
export function frames(onFrame: (f: any) => void) {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onFrame(JSON.parse(line));
    }
  };
}
