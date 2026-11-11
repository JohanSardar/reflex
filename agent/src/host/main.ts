// The small entry point T4 runs the Agent layer from: one long-lived process
// holding in-memory Spaces and an in-memory Inbox. It stands in for the Link
// (T5) until T6 joins them; the Link then hosts the same Core with its
// journal and durable Inbox behind the same interfaces.
//
// Surfaces start it on demand. It keeps running after they exit, so Spaces
// and Sends outlive any one MCP connection or CLI command.
import { connect, createServer, type Socket } from "node:net";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { Core, identify, ReflexError } from "../capabilities/index.ts";
import { MemoryInbox, MemorySpaces } from "../store.ts";
import { SvgRenderer } from "../render.ts";
import { frames, logPath, socketPath, token, type ClientFrame, type HostFrame } from "./rpc.ts";

const log = (event: string, data: Record<string, unknown> = {}) => appendFileSync(logPath("host"), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n");

const core = new Core({
  spaces: new MemorySpaces(),
  inbox: new MemoryInbox(),
  renderer: new SvgRenderer(),
  person: { person: "p_you", name: process.env.REFLEX_PERSON_NAME ?? "You" },
  progressEvery: Number(process.env.REFLEX_PROGRESS_S ?? 15),
  log,
});
const secret = token();

function serve(sock: Socket) {
  let authed = false;
  let client = "?";
  const calls = new Map<number, AbortController>();
  const send = (f: HostFrame) => sock.writable && sock.write(JSON.stringify(f) + "\n");
  sock.on("data", frames(async (f: ClientFrame) => {
    if (f.t === "hello") {
      authed = f.token === secret;
      client = f.client;
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
        const who = identify(f.who.name);
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

const path = socketPath();
// Two surfaces may start a host at once: the second one finds the first and leaves.
const alive = await new Promise<boolean>((resolve) => {
  const probe = connect(path);
  probe.once("connect", () => (probe.destroy(), resolve(true)));
  probe.once("error", () => resolve(false));
});
if (alive) process.exit(0);
if (existsSync(path)) unlinkSync(path);
const server = createServer(serve);
server.listen(path, () => log("host_started", { pid: process.pid, socket: path }));
const stop = () => {
  log("host_stopped", { pid: process.pid });
  server.close();
  if (existsSync(path)) unlinkSync(path);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
