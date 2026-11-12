// The Send Adapter profile: the webhook push (protocol/spec/send-bundles.md §6).
//
// --role receiver: something that takes Sends by webhook (a harness's endpoint). The
// runner POSTs signed deliveries to it and checks it takes each valid one once and
// turns away a bad signature and a stale timestamp. Driver requests:
//   start {secret}   → {url}: start listening, checking signatures with this secret
//   taken            → {deliveries}: the reflex-delivery IDs it acted on, in order, each once
// Or give --url and the secret in REFLEX_WEBHOOK_SECRET: the "taken once" check is skipped.
//
// --role sender: something that pushes Sends by webhook (a Link). The runner is the
// receiver, and checks each request: its headers, its signature, its body against
// webhook.schema.json, and that it retries a 5xx with the same delivery ID and not a 4xx.
// Driver requests:
//   target {url}             → {secret}: add a webhook target for an Agent, pointing at url
//   space  {space, setup}    → {agent?}: the Agent makes the Space and applies the setup batches;
//                              agent is the ID the person's side gives its Elements, if not "a_claude"
//   intent {space, intent}   as in the drawing profile
//   send   {space, raw}      as in the drawing profile
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { Driver } from "../lib/driver.ts";
import { AGENT, intents, PERSON, scenarios, T0 } from "../lib/fixtures.ts";
import { sleep, until } from "../lib/host.ts";
import type { Report } from "../lib/report.ts";
import { invalid } from "../lib/schemas.ts";

const EXAMPLES = new URL("../../../protocol/examples/", import.meta.url);
/** A 1×1 PNG, standing in for a crop. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const sign = (secret: string, ts: string, body: string) => `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

export async function run(d: Driver | null, report: Report, o: { role?: string; url?: string }): Promise<void> {
  if (o.role === "receiver") return receiver(d, report, o.url);
  if (o.role === "sender") {
    if (!d) throw new Error("the sender role needs --impl");
    return sender(d, report);
  }
  throw new Error("give --role receiver or --role sender");
}

// --- receiver ---

async function receiver(d: Driver | null, report: Report, given?: string): Promise<void> {
  const secret = given ? (process.env.REFLEX_WEBHOOK_SECRET ?? "") : `whsec_${randomBytes(24).toString("base64url")}`;
  if (!secret) throw new Error("with --url, set REFLEX_WEBHOOK_SECRET to the receiver's secret");
  const url = given ?? (await d!.call<{ url: string }>("start", { secret }, 30_000)).url;
  const bundles = ["send-bundle.json", "send-bundle.region.json", "send-bundle.watch.json"].map((f) => JSON.parse(readFileSync(new URL(f, EXAMPLES), "utf8")));

  const post = async (bundle: Record<string, any>, o: { attempt?: number; ts?: number; secret?: string; target?: string } = {}) => {
    const delivery = `${bundle.space}/${bundle.send}`;
    const attempt = o.attempt ?? 1;
    const full = { ...bundle, images: (bundle.images ?? []).map((i: object) => ({ ...i, mime: "image/png", data: PNG })) };
    const body = JSON.stringify({ type: "send", delivery, target: o.target ?? "t_conformance", agent: "a_conformance", attempt, bundle: full });
    const problems = invalid("webhook", JSON.parse(body)).map((p) => `the runner's own request: ${p}`);
    if (problems.length) throw new Error(problems.join("; "));
    const ts = String(o.ts ?? Date.now());
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "reflex-delivery": delivery, "reflex-attempt": String(attempt), "reflex-timestamp": ts, "reflex-signature": sign(o.secret ?? secret, ts, body) },
      body,
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  };

  for (const b of bundles)
    await report.run(`acknowledges a signed ${b.kind === "watch" ? "watch " : b.region ? "Region " : ""}Send (${b.space}/${b.send}) with a 2xx`, async () => {
      const s = await post(b);
      return s >= 200 && s < 300 ? [] : [`it answered ${s}`];
    });
  await report.run("acknowledges a repeated delivery (a retry) with a 2xx", async () => {
    const s = await post(bundles[0], { attempt: 2 });
    return s >= 200 && s < 300 ? [] : [`it answered ${s}; a retry of a delivery it took must still be acknowledged, or the sender tries again`];
  });
  const other = { ...bundles[0], send: "s_99" };
  await report.run("turns away a request signed with another secret (4xx)", async () => {
    const s = await post(other, { secret: "whsec_not-the-secret" });
    return s >= 400 && s < 500 ? [] : [`it answered ${s}`];
  });
  await report.run("turns away a correctly signed request older than 5 minutes (4xx)", async () => {
    const s = await post({ ...bundles[0], send: "s_98" }, { ts: Date.now() - 10 * 60_000 });
    return s >= 400 && s < 500 ? [] : [`it answered ${s}`];
  });
  if (d && !given)
    await report.run("acts on each valid delivery once, and on nothing it turned away", async () => {
      await sleep(500);
      const { deliveries } = await d.call<{ deliveries: string[] }>("taken");
      const want = bundles.map((b) => `${b.space}/${b.send}`);
      return JSON.stringify(deliveries) === JSON.stringify(want) ? [] : [`it acted on ${JSON.stringify(deliveries)}, expected ${JSON.stringify(want)}`];
    });
}

// --- sender ---

interface Got {
  at: number;
  headers: IncomingMessage["headers"];
  method: string;
  body: string;
}

async function sender(d: Driver, report: Report): Promise<void> {
  const got: Got[] = [];
  /** How the runner answers the next requests, by delivery ID; 202 otherwise. */
  const answers = new Map<string, number[]>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const g = { at: Date.now(), headers: req.headers, method: req.method ?? "", body: Buffer.concat(chunks).toString("utf8") };
      got.push(g);
      const plan = answers.get(String(req.headers["reflex-delivery"])) ?? [];
      res.writeHead(plan.shift() ?? 202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/reflex`;
  let secret = "";

  /** Problems with one request, as a delivery of this Send. */
  const check = (g: Got, space: string, send: string, attempt: number): string[] => {
    const out: string[] = [];
    const h = g.headers;
    if (g.method !== "POST") out.push(`method ${g.method}, expected POST`);
    if (!String(h["content-type"]).startsWith("application/json")) out.push(`content-type ${h["content-type"]}`);
    if (h["reflex-delivery"] !== `${space}/${send}`) out.push(`reflex-delivery ${h["reflex-delivery"]}, expected ${space}/${send}`);
    if (h["reflex-attempt"] !== String(attempt)) out.push(`reflex-attempt ${h["reflex-attempt"]}, expected ${attempt}`);
    const ts = String(h["reflex-timestamp"] ?? "");
    if (!/^\d+$/.test(ts) || Math.abs(g.at - Number(ts)) > 60_000) out.push(`reflex-timestamp ${ts} is not the time it was sent, in ms`);
    if (h["reflex-signature"] !== sign(secret, ts, g.body)) out.push("reflex-signature does not match HMAC-SHA256(secret, timestamp.body)");
    let body: Record<string, any>;
    try {
      body = JSON.parse(g.body);
    } catch {
      return [...out, "the body is not JSON"];
    }
    out.push(...invalid("webhook", body));
    if (body.delivery !== h["reflex-delivery"] || body.attempt !== attempt) out.push("the body's delivery and attempt differ from its headers");
    const b = body.bundle ?? {};
    if (b.space !== space || b.send !== send) out.push(`the Bundle is ${b.space}/${b.send}`);
    // The Bundle is wait_for_user's, with each crop's bytes added.
    const bare = { ...b, images: (b.images ?? []).map(({ mime: _m, data: _d, ...i }: Record<string, unknown>) => i) };
    out.push(...invalid("send-bundle", bare));
    for (const [i, img] of (b.images ?? []).entries()) {
      if (img.mime !== "image/png" || !Buffer.from(String(img.data ?? ""), "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) out.push(`images/${i} carries no PNG`);
    }
    if (b.from?.person !== PERSON.id && !String(b.from?.person ?? "").startsWith("p_")) out.push(`the Bundle is from ${JSON.stringify(b.from)}`);
    return out;
  };

  /** The person draws one scenario's first Send, as in the drawing profile. Returns the Send's ID. */
  const drawAndSend = async (space: string, s: (typeof all)[number], agent: string) => {
    const map = <T>(v: T): T => JSON.parse(JSON.stringify(v).replaceAll(`"${AGENT}:`, `"${agent}:`));
    const step = s.sends[0];
    const { steps, end } = intents(step.draw, T0);
    let last = T0;
    for (const { at, intent } of steps) {
      await sleep(at - last);
      last = at;
      await d.call("intent", { space, intent: map(intent) });
    }
    await sleep(end - last);
    await d.call("send", { space, raw: map(step.raw) });
    return step.raw.send;
  };

  const all = scenarios();
  const pick = (n: number) => all.find((s) => s.scenario === n)!;
  const ready = new Map<number, string>();
  const prepare = async (n: number) => {
    const s = pick(n);
    const r = await d.call<{ agent?: string }>("space", { space: s.space, setup: s.setup }, 60_000);
    ready.set(n, r.agent || AGENT);
    return s;
  };
  const arrivals = (delivery: string) => got.filter((g) => g.headers["reflex-delivery"] === delivery);

  try {
    await report.run("adds a webhook target and gives its signing secret", async () => {
      secret = (await d.call<{ secret: string }>("target", { url }, 30_000)).secret ?? "";
      return secret ? [] : ["no secret came back"];
    });
    if (!secret) return;

    // Scenarios 1 (a plain Send), 9 (a Region Send) and 12 (a Send after a move).
    for (const n of [1, 9, 12])
      await report.run(`pushes ${pick(n).file}'s Send, signed, as one Protocol v1 webhook request`, async () => {
        const s = await prepare(n);
        const send = await drawAndSend(s.space, s, ready.get(n)!);
        const delivery = `${s.space}/${send}`;
        const late = await until(15_000, async () => (arrivals(delivery).length ? [] : [`no request for ${delivery} within 15 s`]));
        if (late.length) return late;
        await sleep(300);
        const reqs = arrivals(delivery);
        return [...check(reqs[0], s.space, send, 1), ...(reqs.length > 1 ? [`${reqs.length} requests for one Send that was acknowledged`] : [])];
      });

    await report.run("tries a 5xx again after about 1 s, with the same delivery ID and the next attempt, and stops at a 2xx", async () => {
      const s = await prepare(2);
      answers.set(`${s.space}/${s.sends[0].raw.send}`, [503]);
      const send = await drawAndSend(s.space, s, ready.get(2)!);
      const delivery = `${s.space}/${send}`;
      const late = await until(15_000, async () => (arrivals(delivery).length >= 2 ? [] : [`${arrivals(delivery).length} request(s) for ${delivery}, expected a second one`]));
      if (late.length) return late;
      await sleep(7000);
      const reqs = arrivals(delivery);
      const out = [...check(reqs[0], s.space, send, 1), ...check(reqs[1], s.space, send, 2).map((p) => `retry: ${p}`)];
      const gap = reqs[1].at - reqs[0].at;
      if (gap < 800) out.push(`the retry came ${gap} ms after the 503`);
      if (reqs.length !== 2) out.push(`${reqs.length} requests, expected 2 (a 503, then a 202)`);
      return out;
    });

    await report.run("does not try a 4xx again", async () => {
      const s = await prepare(3);
      answers.set(`${s.space}/${s.sends[0].raw.send}`, [400]);
      const send = await drawAndSend(s.space, s, ready.get(3)!);
      const delivery = `${s.space}/${send}`;
      const late = await until(15_000, async () => (arrivals(delivery).length ? [] : [`no request for ${delivery} within 15 s`]));
      if (late.length) return late;
      await sleep(7000);
      const n = arrivals(delivery).length;
      return n === 1 ? [] : [`${n} requests after a 400, expected 1`];
    });
  } finally {
    server.close();
  }
}
