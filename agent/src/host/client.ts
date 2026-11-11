// The surfaces' side of the local RPC. Starts the host when none is running.
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { frames, logPath, socketPath, token, type ClientFrame, type HostFrame } from "./rpc.ts";

export type CallResult = { json: Record<string, any>; images: string[]; isError: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

function startHost() {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  const out = openSync(logPath("host-stdio"), "a");
  spawn(process.execPath, [main], { detached: true, stdio: ["ignore", out, out], env: process.env }).unref();
}

export class Client {
  #sock: Socket;
  #next = 1;
  #waiting = new Map<number, { resolve: (r: CallResult) => void; reject: (e: Error) => void; progress?: (f: { elapsed_s: number; timeout_s: number }) => void }>();
  #ready: Promise<void>;
  onClose?: () => void;

  private constructor(sock: Socket, client: string) {
    this.#sock = sock;
    let ready!: () => void;
    this.#ready = new Promise((r) => (ready = r));
    sock.on("data", frames((f: HostFrame) => {
      if (f.t === "ready") return ready();
      const w = this.#waiting.get(f.id);
      if (!w) return;
      if (f.t === "progress") return w.progress?.(f);
      this.#waiting.delete(f.id);
      if (f.t === "failed") w.reject(new Error(f.message));
      else w.resolve(f);
    }));
    sock.on("close", () => {
      for (const w of this.#waiting.values()) w.reject(new Error("The Reflex host closed the connection."));
      this.#waiting.clear();
      this.onClose?.();
    });
    this.#send({ t: "hello", token: token(), client });
  }

  /** Connects to the host, starting it first if needed. */
  static async open(client: string): Promise<Client> {
    token(); // creates the private profile directory
    const path = socketPath();
    for (let i = 0; i < 50; i++) {
      try {
        const c = new Client(await dial(path), client);
        await c.#ready;
        return c;
      } catch {
        if (i === 0) startHost(); // none running, or a stale socket file from one that died
        await sleep(100);
      }
    }
    throw new Error(`Could not reach or start the Reflex host at ${path}. See ${logPath("host-stdio")}.`);
  }

  #send(f: ClientFrame) {
    this.#sock.write(JSON.stringify(f) + "\n");
  }

  #request(frame: (id: number) => ClientFrame, o: { signal?: AbortSignal; progress?: (f: { elapsed_s: number; timeout_s: number }) => void } = {}) {
    const id = this.#next++;
    return new Promise<CallResult>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject, progress: o.progress });
      o.signal?.addEventListener("abort", () => this.#send({ t: "cancel", id }), { once: true });
      this.#send(frame(id));
    });
  }

  call(tool: string, args: unknown, who: { name: string }, o: { signal?: AbortSignal; progress?: (f: { elapsed_s: number; timeout_s: number }) => void } = {}) {
    return this.#request((id) => ({ t: "call", id, tool, args, who }), o);
  }

  person(action: string, args: Record<string, any>) {
    return this.#request((id) => ({ t: "person", id, action, args }));
  }

  close() {
    this.#sock.end();
  }
}
