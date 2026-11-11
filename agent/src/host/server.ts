// The Agent layer's side of the local RPC: serves the capability table to the
// surfaces. The Link runs it (link/agent-host.ts) and says who each caller is.
import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Core, ReflexError, type Identity } from "../capabilities/index.ts";
import { frames, type ClientFrame, type HostFrame, type Who } from "./rpc.ts";

/** A surface holding a connection open so Sends can be pushed to it (a Send Adapter's live end). */
export type Listener = {
  who: Identity;
  adapter: string;
  config: Record<string, unknown>;
  client: string;
  /** Sends one Send Bundle down the connection; resolves with the surface's answer, or a failure after `ms`. */
  push(json: Record<string, any>, images: Buffer[], ms?: number): Promise<{ ok: boolean; reason?: string }>;
  /** Resolves when the connection closes. */
  closed: Promise<void>;
};

export type HostOptions = {
  core: Core;
  socket: string;
  /** The credential every local client presents. */
  token: string;
  /** Who a caller is, once the person approved it; throws a ReflexError otherwise. */
  authorize: (who: Who, signal: AbortSignal) => Promise<Identity>;
  /** `reflex dev person`: only on a Link started with --dev. */
  devPerson: boolean;
  /** Registers a push target; returns its ID, or throws a ReflexError when it isn't accepted. */
  listen?: (l: Listener) => string;
  /** Adds, lists or removes the caller's push targets that need no connection (`reflex adapters`). */
  adapters?: (who: Identity, action: string, args: Record<string, unknown>) => Record<string, any>;
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
    // Pushes waiting for their answer, by push number.
    const pushes = new Map<number, (r: { ok: boolean; reason?: string }) => void>();
    let pushNo = 0;
    let closed!: () => void;
    const closedP = new Promise<void>((r) => (closed = r));
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
      if (f.t === "pushed") {
        pushes.get(f.push)?.({ ok: f.ok === true, ...(f.reason ? { reason: String(f.reason).slice(0, 300) } : {}) });
        return;
      }
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
          send({
            t: "result",
            id: f.id,
            json: r.json,
            images: r.images.map((b) => b.toString("base64")),
            ...(r.files?.length ? { files: r.files.map((x) => ({ id: x.id, name: x.name, mime: x.mime, data: x.data.toString("base64") })) } : {}),
            isError: r.isError,
          });
        } else if (f.t === "listen") {
          if (!o.listen) throw new ReflexError("unavailable", [{ code: "unavailable", msg: "This host takes no push targets.", fix: "Use wait_for_user." }]);
          const who = await o.authorize(f.who, ac.signal);
          const id = f.id;
          const target = o.listen({
            who,
            adapter: String(f.adapter),
            config: f.config && typeof f.config === "object" ? f.config : {},
            client,
            closed: closedP,
            push: (json, images, ms = 5000) =>
              new Promise((resolve) => {
                if (!sock.writable) return resolve({ ok: false, reason: "connection closed" });
                const n = ++pushNo;
                const done = (r: { ok: boolean; reason?: string }) => {
                  clearTimeout(timer);
                  pushes.delete(n);
                  resolve(r);
                };
                const timer = setTimeout(() => done({ ok: false, reason: `no answer within ${ms} ms` }), ms);
                pushes.set(n, done);
                void closedP.then(() => done({ ok: false, reason: "connection closed" }));
                // The same deadline on both ends: a surface that gets the push late drops it, so a push the Link
                // counted as failed (and left for wait_for_user) never also reaches the session.
                send({ t: "push", id, push: n, json, images: images.map((b) => b.toString("base64")), deadline: Date.now() + ms - 250 });
              }),
          });
          log("listening", { client, who: who.name, adapter: f.adapter, target });
          send({ t: "listening", id, target, agent: who.agent });
        } else if (f.t === "adapters") {
          if (!o.adapters) throw new ReflexError("unavailable", [{ code: "unavailable", msg: "This host takes no push targets.", fix: "Use wait_for_user." }]);
          const who = await o.authorize(f.who, ac.signal);
          const json = o.adapters(who, String(f.action), f.args && typeof f.args === "object" ? f.args : {});
          log("adapters", { client, who: who.name, action: f.action });
          send({ t: "result", id: f.id, json, images: [], isError: false });
        } else if (f.t === "person") {
          if (!o.devPerson)
            throw new ReflexError("unavailable", [{ code: "unavailable", msg: "Acting as the person needs a Link started with --dev.", fix: "Draw and press Send on the iPad, or restart the Link with `reflex link --dev`." }]);
          const a = f.args;
          let json: Record<string, any>;
          if (f.action === "circle") json = core.personCircle(a.space, a.target);
          else if (f.action === "underline") json = core.personUnderline(a.space, a.target);
          else if (f.action === "strike") json = core.personStrike(a.space, a.target);
          else if (f.action === "arrow") json = core.personArrow(a.space, a.target, a.to);
          else if (f.action === "write") json = core.personWrite(a.space, a.target, a.text, { confidence: a.confidence });
          else if (f.action === "say") json = core.personSay(a.space, a.text);
          else if (f.action === "move") json = core.personMove(a.space, a.target, a.by);
          else if (f.action === "add-file") json = core.personAddFile(a.space, { name: a.name, bytes: Buffer.from(a.data, "base64"), mime: a.mime }, { near: a.near });
          else if (f.action === "tap") json = core.personFire(a.space, a.target, a.on ?? "tap", { values: a.values });
          else if (f.action === "revert") json = core.personRevert(a.space, a.agent);
          else if (f.action === "history") json = core.timeline(a.space);
          else if (f.action === "stroke") json = core.personStroke(a.space, a.points);
          else if (f.action === "write-line") json = core.personWriteLine(a.space, a.target, a.text, { confidence: a.confidence });
          else if (f.action === "send") json = core.personSend(a.space, { said: a.said, trigger: a.trigger, region: a.region });
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
      closed();
      if (calls.size) log("client_closed", { client, held: [...calls.keys()] });
      for (const ac of calls.values()) ac.abort();
    });
    sock.on("error", () => {});
  }

  rmSync(o.socket, { force: true }); // a stale socket from a Link that was killed
  return new Promise((resolve, reject) => {
    const server = createServer(serve);
    // close() waits for every connection to end, and `reflex mcp` holds one for the harness's whole session,
    // so the Link could never stop. Closing drops them; their held calls abort (see "close" above).
    const open = new Set<Socket>();
    server.on("connection", (s) => {
      open.add(s);
      s.on("close", () => open.delete(s));
    });
    const close = server.close.bind(server);
    server.close = (cb) => {
      for (const s of open) s.destroy();
      return close(cb);
    };
    server.once("error", reject);
    server.listen(o.socket, () => resolve(server));
  });
}
