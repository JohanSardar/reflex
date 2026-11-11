// Local RPC between the thin surfaces (an MCP stdio process, a CLI command)
// and the one long-lived process that holds the Spaces (ARCHITECTURE §1).
// A Unix socket in a private directory plus a per-profile token; never an
// open loopback port. Frames are newline-delimited JSON.
import { mkdirSync, readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const home = () => process.env.REFLEX_HOME ?? join(homedir(), ".reflex", "dev");
/** Unix socket paths are capped near 104 bytes; a long profile path gets a short hashed one in tmp. */
export const socketPath = () => {
  const p = join(home(), "host.sock");
  return p.length < 100 ? p : join(tmpdir(), `reflex-${createHash("sha256").update(home()).digest("hex").slice(0, 12)}.sock`);
};
export const logPath = (name: string) => join(home(), `${name}.log`);

/** The per-profile credential every client presents. Created on first use, 0600. */
export function token(): string {
  const dir = home();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, "token");
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString("hex"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

export type ClientFrame =
  | { t: "hello"; token: string; client: string }
  | { t: "call"; id: number; tool: string; args: unknown; who: { name: string } }
  | { t: "person"; id: number; action: string; args: Record<string, any> }
  | { t: "cancel"; id: number };

export type HostFrame =
  | { t: "ready" }
  | { t: "result"; id: number; json: Record<string, any>; images: string[]; isError: boolean }
  | { t: "progress"; id: number; elapsed_s: number; timeout_s: number }
  | { t: "failed"; id: number; message: string };

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
