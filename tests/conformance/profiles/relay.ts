// The Relay profile: a server that meets one person's devices in a room, forwards
// the frames they seal end to end, and keeps each Space's sealed log
// (protocol/spec/transports.md §6). The runner is the devices: it connects, says
// hello, watches, sends frames, and appends to and reads a log, and checks every
// message the Relay sends against relay.schema.json. It also fetches the
// Protocol's schemas from /protocol/v1/, where their $ids point (§8).
//
// --url gives the Relay's http(s) origin. Or a driver with one request:
//   start  → {url}: a fresh Relay, with no logs, listening at url
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Driver } from "../lib/driver.ts";
import { sleep } from "../lib/host.ts";
import type { Report } from "../lib/report.ts";
import { invalidMessage } from "../lib/schemas.ts";

const SCHEMAS = new URL("../../../protocol/schema/", import.meta.url);
type Msg = Record<string, any>;

/** One device's WebSocket to a room. */
class Device {
  readonly id: string;
  readonly key: string;
  #priv: KeyObject;
  ws!: WebSocket;
  msgs: Msg[] = [];
  frames: { device: string; ch: number; payload: Buffer }[] = [];
  closed: { code: number; reason: string } | null = null;
  #n = 0;
  readonly problems: string[];
  constructor(problems: string[]) {
    this.problems = problems;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
    this.key = raw.toString("base64url");
    this.id = `dev-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
    this.#priv = privateKey;
  }
  async connect(ws: string, room: string, opts: { badSig?: boolean } = {}): Promise<void> {
    this.ws = new WebSocket(`${ws}/v0/connect?room=${room}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data);
        this.problems.push(...invalidMessage("relay", m).map((p) => `${this.label}: ${p}`));
        this.msgs.push(m);
      } else {
        const b = Buffer.from(e.data as ArrayBuffer);
        const n = b[0];
        this.frames.push({ device: b.subarray(1, 1 + n).toString("utf8"), ch: b.readUInt32BE(1 + n), payload: b.subarray(5 + n) });
      }
    };
    this.ws.onclose = (e) => (this.closed = { code: e.code, reason: e.reason });
    const challenge = await this.wait((m) => m.t === "challenge", "a challenge");
    const text = `reflex-relay/v0 hello ${room} ${challenge.nonce}`;
    const sig = sign(null, Buffer.from(opts.badSig ? `${text}x` : text), this.#priv).toString("base64url");
    this.json({ t: "hello", device: this.id, key: this.key, sig });
  }
  get label() {
    return this.id.slice(0, 8);
  }
  json(m: Msg) {
    const own = invalidMessage("relay", m);
    if (own.length) throw new Error(`the runner's own message: ${own.join("; ")}`);
    this.ws.send(JSON.stringify(m));
  }
  frame(to: string, ch: number, payload: Buffer) {
    const id = Buffer.from(to);
    const head = Buffer.alloc(5 + id.length);
    head[0] = id.length;
    id.copy(head, 1);
    head.writeUInt32BE(ch >>> 0, 1 + id.length);
    this.ws.send(Buffer.concat([head, payload]));
  }
  async request(m: Msg): Promise<Msg> {
    const req = ++this.#n;
    this.json({ ...m, req });
    return this.wait((x) => x.t === "result" && x.req === req, `the result of ${m.t}`);
  }
  async wait(match: (m: Msg) => boolean, what: string, ms = 5000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.msgs.findIndex(match);
      if (i >= 0) return this.msgs.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`${this.label}: no ${what} within ${ms} ms${this.closed ? ` (closed ${this.closed.code} ${this.closed.reason})` : ""}`);
      await sleep(20);
    }
  }
  async waitClosed(ms = 5000): Promise<{ code: number; reason: string } | null> {
    for (let end = Date.now() + ms; !this.closed && Date.now() < end; ) await sleep(20);
    return this.closed;
  }
}

export async function run(d: Driver | null, report: Report, o: { url?: string }): Promise<void> {
  const http = (o.url ?? (await d!.call<{ url: string }>("start", {}, 30_000)).url).replace(/\/$/, "");
  const ws = http.replace(/^http/, "ws");
  const room = randomBytes(16).toString("hex");
  const problems: string[] = [];
  const a = new Device(problems);
  const b = new Device(problems);
  const c = new Device(problems);
  const all = [a, b, c];

  try {
    await report.run("challenges a new connection, and closes one whose hello is not signed by its key (4403)", async () => {
      const bad = new Device(problems);
      await bad.connect(ws, room, { badSig: true });
      const closed = await bad.waitClosed();
      return closed?.code === 4403 ? [] : [`expected a close with 4403, got ${JSON.stringify(closed)}`];
    });

    await report.run("welcomes each device whose hello checks out", async () => {
      const out: string[] = [];
      for (const dev of all) {
        await dev.connect(ws, room);
        const w = await dev.wait((m) => m.t === "welcome", "welcome");
        if (w.device !== dev.id) out.push(`${dev.label}: welcomed as ${w.device}`);
      }
      return out;
    });

    await report.run("tells a device that watches another whether it is online, and when it comes and goes", async () => {
      a.json({ t: "watch", devices: [b.id] });
      const p = await a.wait((m) => m.t === "presence" && m.device === b.id, "presence of b");
      b.json({ t: "watch", devices: [a.id] });
      await b.wait((m) => m.t === "presence" && m.device === a.id, "presence of a");
      return p.online === true ? [] : [`b is online, the Relay said ${JSON.stringify(p)}`];
    });

    await report.run("forwards a frame to a device that watches the sender, with the device ID rewritten to the sender's", async () => {
      const payload = randomBytes(300);
      a.frame(b.id, 0x8000_0005, payload);
      for (let i = 0; i < 100 && !b.frames.length; i++) await sleep(20);
      const f = b.frames.shift();
      if (!f) return ["b got no frame"];
      const out: string[] = [];
      if (f.device !== a.id) out.push(`the frame names ${f.device}, expected the sender ${a.id}`);
      if (f.ch !== 0x8000_0005) out.push(`channel ${f.ch.toString(16)}, expected 80000005`);
      if (!f.payload.equals(payload)) out.push("the payload changed");
      return out;
    });

    await report.run("answers a frame to a device that does not watch the sender with undeliverable, and forwards nothing", async () => {
      c.frame(b.id, 7, Buffer.from("hi"));
      const u = await c.wait((m) => m.t === "undeliverable", "undeliverable");
      await sleep(200);
      const out = u.device === b.id && u.ch === 7 ? [] : [`got ${JSON.stringify(u)}`];
      if (b.frames.length) out.push("b got c's frame, though it does not watch c");
      return out;
    });

    await report.run("passes a channel close on, from the sender", async () => {
      a.json({ t: "close", device: b.id, ch: 0x8000_0005 });
      const m = await b.wait((m) => m.t === "close", "close");
      return m.device === a.id && m.ch === 0x8000_0005 ? [] : [`got ${JSON.stringify(m)}`];
    });

    const log = randomBytes(32).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const entries = [randomBytes(64), randomBytes(200)].map((e) => e.toString("base64"));
    await report.run("keeps a log: the first writer's token sets it; appends get sequence numbers; reads give them back", async () => {
      const out: string[] = [];
      const ap = await a.request({ t: "log.append", log, token, entries });
      if (!ap.ok || JSON.stringify(ap.seqs) !== "[1,2]") out.push(`append: ${JSON.stringify(ap)}`);
      const rd = await b.request({ t: "log.read", log, token, after: 0 });
      if (!rd.ok || rd.last !== 2 || JSON.stringify(rd.entries?.map((e: Msg) => e.data)) !== JSON.stringify(entries)) out.push(`read: ${JSON.stringify(rd).slice(0, 300)}`);
      const after = await b.request({ t: "log.read", log, token, after: 1 });
      if (after.entries?.length !== 1 || after.entries[0].seq !== 2) out.push(`read after 1: ${JSON.stringify(after).slice(0, 300)}`);
      return out;
    });

    await report.run("refuses a log request with the wrong token, or for a log nobody wrote", async () => {
      const out: string[] = [];
      const wrong = await c.request({ t: "log.read", log, token: randomBytes(32).toString("base64url"), after: 0 });
      if (wrong.ok !== false || typeof wrong.error !== "string") out.push(`wrong token: ${JSON.stringify(wrong)}`);
      const none = await c.request({ t: "log.read", log: randomBytes(32).toString("hex"), token, after: 0 });
      if (none.ok !== false) out.push(`unknown log: ${JSON.stringify(none)}`);
      const append = await c.request({ t: "log.append", log, token: randomBytes(32).toString("base64url"), entries });
      if (append.ok !== false) out.push(`append with the wrong token: ${JSON.stringify(append)}`);
      return out;
    });

    await report.run("tells a device that watches a log when it grows", async () => {
      const w = await a.request({ t: "log.watch", log, token });
      if (!w.ok || w.last !== 2) return [`watch: ${JSON.stringify(w)}`];
      await b.request({ t: "log.append", log, token, entries: [randomBytes(10).toString("base64")] });
      const m = await a.wait((m) => m.t === "log.new", "log.new");
      return m.log === log && m.last === 3 ? [] : [`got ${JSON.stringify(m)}`];
    });

    await report.run("keeps sealed assets over HTTP, with the log token", async () => {
      const out: string[] = [];
      const id = randomBytes(32).toString("hex");
      const bytes = randomBytes(5000);
      const url = `${http}/v0/log/${log}/assets/${id}`;
      const put = await fetch(url, { method: "PUT", headers: { "x-reflex-log-token": token }, body: bytes });
      if (put.status < 200 || put.status > 299) out.push(`PUT answered ${put.status}`);
      const get = await fetch(url, { headers: { "x-reflex-log-token": token } });
      if (!Buffer.from(await get.arrayBuffer()).equals(bytes)) out.push(`GET answered ${get.status} with other bytes`);
      const bad = await fetch(url, { headers: { "x-reflex-log-token": randomBytes(32).toString("base64url") } });
      await bad.body?.cancel();
      if (bad.status < 400 || bad.status > 499) out.push(`GET with the wrong token answered ${bad.status}`);
      const have = await a.request({ t: "log.assets", log, token, ids: [id, randomBytes(32).toString("hex")] });
      if (JSON.stringify(have.have) !== JSON.stringify([id])) out.push(`log.assets: ${JSON.stringify(have)}`);
      return out;
    });

    await report.run("answers a ping", async () => {
      const r = await a.request({ t: "ping", at: 123 });
      return r.ok && r.at === 123 ? [] : [`got ${JSON.stringify(r)}`];
    });

    await report.run("tells a watcher when a device goes", async () => {
      b.ws.close();
      const m = await a.wait((m) => m.t === "presence" && m.device === b.id && m.online === false, "b going offline");
      return m ? [] : ["nothing"];
    });

    await report.run("every message it sent is a Protocol v1 relay message", () => [...new Set(problems)]);

    await report.run("serves the Protocol's schemas at their $ids, under /protocol/v1/", async () => {
      const out: string[] = [];
      const files = readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json")).sort();
      const index = (await (await fetch(`${http}/protocol/v1/`)).json().catch(() => null)) as { schemas?: string[] } | null;
      if (JSON.stringify(index?.schemas) !== JSON.stringify(files)) out.push(`the index lists ${JSON.stringify(index?.schemas)}`);
      for (const f of files) {
        const r = await fetch(`${http}/protocol/v1/${f}`);
        const text = await r.text();
        const local = readFileSync(new URL(f, SCHEMAS), "utf8");
        if (r.status !== 200 || text !== local) out.push(`${f}: ${r.status}, ${text === local ? "same" : "different"} contents`);
        if (!String(r.headers.get("content-type")).includes("json")) out.push(`${f}: content-type ${r.headers.get("content-type")}`);
        const id = new URL(JSON.parse(local).$id);
        if (id.pathname !== `/protocol/v1/${f}`) out.push(`${f}: its $id is ${id.href}`);
      }
      const missing = await fetch(`${http}/protocol/v1/nothing.schema.json`);
      await missing.body?.cancel();
      if (missing.status !== 404) out.push(`a missing schema answered ${missing.status}`);
      return out;
    });
  } finally {
    for (const dev of all) dev.ws?.close();
  }
}
