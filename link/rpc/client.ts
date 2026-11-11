// Client for the Link's local RPC: a Unix socket, one JSON object per line.
// Every connection first presents a per-profile credential (`auth`). Used by
// the `reflex-link` commands, and by whatever connects an Agent (T6 plugs the
// Agent layer in here).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { home } from "../home.ts";

export class RpcError extends Error {
  reason: string;
  fix?: string;
  constructor(reason: string, message: string, fix?: string) {
    super(message);
    this.reason = reason;
    this.fix = fix;
  }
}

export class LinkClient {
  #socket: Socket;
  #buf = "";
  #n = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.#buf += d;
      let i: number;
      while ((i = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        const m = JSON.parse(line);
        const p = this.#pending.get(m.id);
        if (!p) continue;
        this.#pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new RpcError(m.error.reason, m.error.message, m.error.fix));
      }
    });
    socket.on("close", () => {
      for (const p of this.#pending.values()) p.reject(new RpcError("link_gone", "The Link closed the connection."));
      this.#pending.clear();
    });
  }

  /** Connects to the Link running from `dir` and authenticates as `role`. */
  static async connect(dir: string, role: "admin" | "agent"): Promise<LinkClient> {
    const h = home(dir);
    const runtime = existsSync(h.runtime) ? JSON.parse(readFileSync(h.runtime, "utf8")) : null;
    const socketPath: string = runtime?.socket ?? h.socket;
    const keyFile = join(dir, role === "admin" ? "admin.key" : "rpc.key");
    if (!existsSync(keyFile))
      throw new RpcError("no_link", `No Link has run from ${dir}.`, "Start one with `reflex-link`, or pass --home.");
    const key = readFileSync(keyFile, "utf8").trim();
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", () =>
        reject(new RpcError("link_not_running", `The Link at ${dir} is not running.`, "Start it with `reflex-link`.")),
      );
    });
    const c = new LinkClient(socket);
    await c.call("auth", { role, key });
    return c;
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.#n;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  close(): void {
    this.#socket.end();
  }
}
