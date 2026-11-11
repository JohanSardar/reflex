// The surfaces' side of the local RPC to the Link.
import { connect, type Socket } from "node:net";
import { frames, home, NoLink, socketPath, token, type ClientFrame, type HostFrame, type WireFile, type Who } from "./rpc.ts";

export type CallResult = { json: Record<string, any>; images: string[]; files?: WireFile[]; isError: boolean };
type Progress = (f: { elapsed_s: number; timeout_s: number }) => void;

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

export class Client {
  #sock: Socket;
  #next = 1;
  #waiting = new Map<number, { resolve: (r: CallResult) => void; reject: (e: Error) => void; progress?: Progress }>();
  #ready: Promise<void>;
  onClose?: () => void;

  private constructor(sock: Socket, client: string, key: string) {
    this.#sock = sock;
    let ready!: () => void;
    this.#ready = new Promise((r, reject) => {
      ready = r;
      sock.once("close", () => reject(new NoLink("The Link refused this connection: its credential did not match.")));
    });
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
      for (const w of this.#waiting.values()) w.reject(new Error("The Reflex Link closed the connection."));
      this.#waiting.clear();
      this.onClose?.();
    });
    sock.on("error", () => {});
    this.#send({ t: "hello", token: key, client });
  }

  /** Connects to the running Link. */
  static async open(client: string): Promise<Client> {
    const key = token();
    let sock: Socket;
    try {
      sock = await dial(socketPath());
    } catch {
      throw new NoLink(`The Reflex Link is not running (profile ${home()}). Start it with \`reflex link\`.`);
    }
    const c = new Client(sock, client, key);
    await c.#ready;
    return c;
  }

  #send(f: ClientFrame) {
    this.#sock.write(JSON.stringify(f) + "\n");
  }

  #request(frame: (id: number) => ClientFrame, o: { signal?: AbortSignal; progress?: Progress } = {}) {
    const id = this.#next++;
    return new Promise<CallResult>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject, progress: o.progress });
      o.signal?.addEventListener("abort", () => this.#send({ t: "cancel", id }), { once: true });
      this.#send(frame(id));
    });
  }

  call(tool: string, args: unknown, who: Who, o: { signal?: AbortSignal; progress?: Progress } = {}) {
    return this.#request((id) => ({ t: "call", id, tool, args, who }), o);
  }

  person(action: string, args: Record<string, any>) {
    return this.#request((id) => ({ t: "person", id, action, args }));
  }

  close() {
    this.#sock.end();
  }
}
