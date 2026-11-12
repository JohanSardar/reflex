// The drawing profile: a client that writes Ink and Sends (an iPad, an Android
// tablet, a Link acting as its person). The runner is the Link it pairs with: it
// listens on TCP, shows a pairing code, and holds the 13 scenario Spaces. The
// implementation pairs, syncs them, draws each scenario as the person in real time,
// and presses Send; the runner checks every frame and every change it gets, and the
// Marks its own kernel groups from them.
//
// Driver requests:
//   pair   {code}                 pair with the reflex://pair code (protocol/spec/identity.md §3)
//   ids    {space}                → {ids}: the Element IDs its replica of the Space holds
//   intent {space, intent}        write one user intent as the person (intent.schema.json), now
//   send   {space, raw}           freeze a raw Send (raw-send.schema.json) as the person, now
import { createServer, type Socket } from "node:net";
import { b64, newDeviceKey } from "../../../link/pairing/crypto.ts";
import { handshake, type Session } from "../../../link/pairing/handshake.ts";
import { Offers } from "../../../link/pairing/offer.ts";
import { FramedPath } from "../../../link/transports/framed.ts";
import type { Driver } from "../lib/driver.ts";
import { AGENT, compareMarks, intents, partial, PERSON, stored, T0 } from "../lib/fixtures.ts";
import { hostSpaces, sleep, until } from "../lib/host.ts";
import type { Report } from "../lib/report.ts";
import { invalid, invalidMessage } from "../lib/schemas.ts";

class SocketPath extends FramedPath {
  #s: Socket;
  constructor(s: Socket) {
    super("lan", `${s.remoteAddress}:${s.remotePort}`, false);
    this.#s = s;
    s.on("data", (d: Buffer) => this.onData(d));
    s.on("close", () => this.finish("socket closed"));
    s.on("error", (e) => this.finish(e.message));
  }
  protected write(b: Buffer): Promise<void> {
    return new Promise((r) => (this.#s.write(b) ? r() : this.#s.once("drain", () => r())));
  }
  protected queued(): number {
    return this.#s.writableLength;
  }
  protected destroy(): void {
    this.#s.destroy();
  }
}

/** The person's own iPad or Link may write as the person, and nothing else (protocol/spec/membership.md §4). */
const WRITERS = JSON.stringify({ people: [PERSON.id] });

export async function run(d: Driver, report: Report): Promise<void> {
  const spaces = hostSpaces();
  const me = { key: newDeviceKey().key, person: PERSON, name: "Conformance Link", kind: "link" as const };
  const offers = new Offers();
  const problems = { frames: [] as string[], refused: [] as string[], pongs: 0, seen: new Map<string, number>() };
  let session: Session | null = null;
  let resolveBound!: () => void;
  const bound = new Promise<void>((r) => (resolveBound = r));

  const pump = (space: string) => {
    const m = spaces.get(space)?.space.syncMessage("peer");
    if (m && session) void session.send({ t: "sync", space }, m, "change").catch(() => {});
  };

  const server = createServer((sock) => {
    const path = new SocketPath(sock);
    // The two plain frames the implementation sends first must be its hello and auth.
    const next = path.next.bind(path);
    let plain = 0;
    path.next = async () => {
      const f = await next();
      if (f && plain < 2) {
        plain++;
        try {
          problems.frames.push(...invalidMessage("handshake", JSON.parse(Buffer.from(f).toString("utf8"))));
        } catch {
          problems.frames.push("a handshake frame is not JSON");
        }
      }
      return f;
    };
    handshake(path, me, { pairedKey: () => undefined, offerSecret: (o) => offers.secret(o) })
      .then(async (r) => {
        if (!r.paired) problems.frames.push("the handshake did not pair with the offer");
        offers.consume(r.offer!);
        session = r.session;
        resolveBound();
        await session.send({ t: "spaces", spaces: [...spaces.keys()].map((id) => ({ id, kind: "space" })) });
        await session.send({ t: "ping", n: 1, at: Date.now() });
        for (const id of spaces.keys()) pump(id);
        for (;;) {
          const m = await session.next();
          if (!m) break;
          problems.frames.push(...invalidMessage("session", m.h));
          problems.seen.set(String(m.h.t), (problems.seen.get(String(m.h.t)) ?? 0) + 1);
          const h = m.h as Record<string, any>;
          if (h.t === "ping") void session.send({ t: "pong", n: h.n, at: h.at });
          else if (h.t === "pong") problems.pongs++;
          else if (h.t === "sync" && spaces.has(h.space)) {
            const res = JSON.parse(spaces.get(h.space)!.space.receiveSyncMessageChecked("peer", m.body, WRITERS));
            if (!res.ok) {
              problems.refused.push(`${h.space}: ${res.errors.map((e: { msg: string }) => e.msg).join(" ")}`);
              void session.send({ t: "refused", space: h.space, reason: "conformance: the change was not the person's" });
            } else pump(h.space);
          }
        }
      })
      .catch((e: Error) => problems.frames.push(`handshake: ${e.message}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  try {
    await report.run("pairs with a pairing code over the LAN path", async () => {
      const offer = offers.create({ device: me.key.device, key: b64(me.key.publicRaw), name: me.name, person: PERSON }, port);
      // Only the loopback address: the runner listens there.
      const code = offer.uri.replace(/([?&]h=)[^&]*/, "$1127.0.0.1");
      await d.call("pair", { code }, 60_000);
      await Promise.race([bound, sleep(20_000).then(() => Promise.reject(new Error("it never completed the handshake")))]);
      return [];
    });
    if (!session) return;

    await report.run("syncs every Space the Link holds", async () =>
      until(30_000, async () => {
        const out: string[] = [];
        for (const [id, { scenario }] of spaces) {
          const { ids } = await d.call<{ ids: string[] }>("ids", { space: id }).catch(() => ({ ids: [] as string[] }));
          const missing = scenario.elements.map(stored).filter((e) => !ids.includes(e));
          if (missing.length) out.push(`${id}: missing ${missing.join(", ")}`);
        }
        return out;
      }),
    );

    for (const [id, { scenario, space }] of spaces) {
      await report.run(`draws and sends ${scenario.file}`, async () => {
        const out: string[] = [];
        let clock = T0;
        for (const step of scenario.sends) {
          const { steps, end } = intents(step.draw, clock);
          // The person draws in real time: the gaps between strokes are what group them into Marks.
          let last = clock;
          for (const { at, intent } of steps) {
            await sleep(at - last);
            last = at;
            await d.call("intent", { space: id, intent });
          }
          await sleep(end - last);
          await d.call("send", { space: id, raw: step.raw });
          clock = end;
          // It reaches this Link, checked; the Marks are grouped here.
          const got = await until(15_000, async () => (JSON.parse(space.marks(step.raw.send, JSON.stringify({ viewer: { agent: AGENT } }))) ? [] : ["not here yet"]));
          if (got.length) {
            out.push(`Send ${step.raw.send} never arrived`);
            continue;
          }
          const frozen = JSON.parse(space.send(step.raw.send));
          out.push(...partial({ from: { person: PERSON.id }, ...(step.expect.frozen ?? {}) }, frozen, `/frozen ${step.raw.send}`).filter((p) => !p.includes("/state")));
          out.push(...invalid("raw-send", step.raw).map((p) => `fixture: ${p}`));
          const marks = JSON.parse(space.marks(step.raw.send, JSON.stringify({ viewer: { agent: AGENT } })));
          out.push(...compareMarks(step.expect, marks.marks).map((p) => `${step.raw.send}: ${p}`));
        }
        return out;
      });
    }

    const seen = [...problems.seen].map(([t, n]) => `${t} ×${n}`).join(", ");
    await report.run(`every frame it sent is a Protocol v1 message (handshake, then ${seen})`, () => [...new Set(problems.frames)]);
    await report.run("every change it sent was the person's own", () => problems.refused);
    await report.run("answers a ping with a pong", () => (problems.pongs ? [] : ["no pong came back"]));
  } finally {
    (session as Session | null)?.close("done");
    server.close();
  }
}

