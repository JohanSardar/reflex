// The Agent layer's side of the local RPC: serves the capability table to the
// surfaces. The Link runs it (link/agent-host.ts) and says who each caller is.
import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Core, ReflexError, type Identity } from "../capabilities/index.ts";
import { frames, type ClientFrame, type HostFrame, type Who } from "./rpc.ts";

export type HostOptions = {
  core: Core;
  socket: string;
  /** The credential every local client presents. */
  token: string;
  /** Who a caller is, once the person approved it; throws a ReflexError otherwise. */
  authorize: (who: Who, signal: AbortSignal) => Promise<Identity>;
  /** `reflex dev person`: only on a Link started with --dev. */
  devPerson: boolean;
  log: (event: string, data?: Record<string, unknown>) => void;
};

export function serveHost(o: HostOptions): Promise<Server> {
  const { core, log } = o;
  const want = Buffer.from(o.token);

  function serve(sock: Socket) {
    let authed = false;
    let client = "?";
    const calls = new Map<number, AbortController>();
    const send = (f: HostFrame) => sock.writable && sock.write(JSON.stringify(f) + "\n");
    sock.on("data", frames(async (f: ClientFrame) => {
      if (f.t === "hello") {
        const got = Buffer.from(String(f.token ?? ""));
        authed = got.length === want.length && timingSafeEqual(got, want);
        client = String(f.client);
        if (!authed) {
          log("rejected", { client });
          sock.destroy();
        } else send({ t: "ready" });
        return;
      }
      if (!authed) return sock.destroy();
      if (f.t === "cancel") {
        calls.get(f.id)?.abort();
        log("cancel", { client, id: f.id });
        return;
      }
      const ac = new AbortController();
      calls.set(f.id, ac);
      try {
        if (f.t === "call") {
          const who = await o.authorize(f.who, ac.signal);
          const started = Date.now();
          if (f.tool === "wait_for_user") log("wait_start", { client, who: who.name, args: f.args as Record<string, unknown> });
          const r = await core.call(f.tool, f.args, {
            who,
            signal: ac.signal,
            progress: (p) => send({ t: "progress", id: f.id, ...p }),
          });
          log("call", { client, who: who.name, tool: f.tool, ms: Date.now() - started, isError: r.isError, ...(r.isError ? { reason: r.json.reason } : {}), aborted: ac.signal.aborted });
          send({ t: "result", id: f.id, json: r.json, images: r.images.map((b) => b.toString("base64")), isError: r.isError });
        } else if (f.t === "person") {
          if (!o.devPerson)
            throw new ReflexError("unavailable", [{ code: "unavailable", msg: "Acting as the person needs a Link started with --dev.", fix: "Draw and press Send on the iPad, or restart the Link with `reflex link --dev`." }]);
          const a = f.args;
          let json: Record<string, any>;
          if (f.action === "circle") json = core.personCircle(a.space, a.target);
          else if (f.action === "underline") json = core.personUnderline(a.space, a.target);
          else if (f.action === "stroke") json = core.personStroke(a.space, a.points);
          else if (f.action === "send") json = core.personSend(a.space, { said: a.said, trigger: a.trigger });
          else throw new Error(`unknown person action ${f.action}`);
          send({ t: "result", id: f.id, json, images: [], isError: false });
        }
      } catch (e) {
        if (e instanceof ReflexError) send({ t: "result", id: f.id, json: { ok: false, ...e.body }, images: [], isError: true });
        else send({ t: "failed", id: f.id, message: String((e as Error).message) });
      } finally {
        calls.delete(f.id);
      }
    }));
    // A closed pipe aborts that client's held calls. Sends stay in the Inbox.
    sock.on("close", () => {
      if (calls.size) log("client_closed", { client, held: [...calls.keys()] });
      for (const ac of calls.values()) ac.abort();
    });
    sock.on("error", () => {});
  }

  rmSync(o.socket, { force: true }); // a stale socket from a Link that was killed
  return new Promise((resolve, reject) => {
    const server = createServer(serve);
    server.once("error", reject);
    server.listen(o.socket, () => resolve(server));
  });
}
