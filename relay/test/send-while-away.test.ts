// review round 2, S6: the S3 fix covers a first index when *no* Agent has
// attached yet. When one has, `#index(false)` marks the Send `routed = 1`
// (relay/domain/session.ts:158 `agents.length > 0`) but only inserts receipts
// under `if (route)` (session.ts:159) — and `route` is false on that first
// index. The only other place that turns unrouted rows into receipts is
// `attach()` (session.ts:190), which only `open_space` calls
// (agent/src/capabilities/index.ts:208); `wait_for_user` does not.
//
// So a Send pressed while the cloud session is not materialized (the Durable
// Object is evicted after ~10 s of idle, or the self-hosted Relay restarts) is
// dropped for a grant whose Agent had already opened the Space and whose Space
// had no earlier Sends: the Agent's next call re-materializes the session,
// indexes the Send as routed with no receipt, and waits out its timeout.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Space } from "@reflex/kernel/node";
import { SvgRenderer } from "../../agent/src/render.ts";
import { newDeviceKey, signWith } from "../../link/pairing/crypto.ts";
import { SpaceLog } from "../domain/log.ts";
import type { Bucket, Hubs, Sql } from "../domain/ports.ts";
import { b64, b64url, random, sealEntry, spaceKeys } from "../domain/seal.ts";
import { grantText, type Grant } from "../domain/wire.ts";

function sqlite(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    all: <T>(q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as T[],
    run: (q: string, ...p: unknown[]) => void db.prepare(q).run(...(p as never[])),
  };
}

test("a Send pressed while the session is not materialized reaches an Agent that already opened the Space", async () => {
  const spaceKey = random(32);
  const logId = spaceKeys(spaceKey).log;
  const keys = spaceKeys(spaceKey);
  const dev = newDeviceKey().key;
  const token = "t".repeat(48);
  const room = "0123456789abcdef0123456789abcdef";
  const sql = sqlite(); // the log's storage: outlives the session
  const kernel = { create: (id: string, kind: string, actor: string) => Space.create(id, kind, actor) as never, load: (b: Uint8Array, a: string) => Space.load(b, a) as never };
  const make = (): SpaceLog =>
    new SpaceLog({
      id: logId,
      sql,
      bucket: { put: async () => {}, get: async () => null, has: async () => false } as Bucket,
      hubs: {
        log: () => ({}) as never,
        auth: () => ({ approve: async () => {}, lookup: async () => ({ client: "c", client_uri: null, scope: "space" }) }),
        room: () => ({ notify: async () => {} }),
      } as unknown as Hubs,
      kernel,
      renderer: () => new SvgRenderer(),
      log: () => {},
      wakeAt: () => {},
    });
  let log = make();
  await log.append(token, room, []);

  const t0 = Date.now();
  const g: Grant = {
    grant: "g_000000000000000a",
    log: logId,
    space: "plan",
    kind: "space",
    epoch: 0,
    agent: "a_rcAAAAA",
    name: "Cloud client",
    person: { id: "p_0123456789abcdef", name: "Johan" },
    scopes: ["read", "write"],
    issued: t0,
    expires: t0 + 60 * 60_000,
    device: dev.device,
    key: b64url(dev.publicRaw),
  };
  await log.issueGrant(token, g, signWith(dev, grantText(g)), b64url(spaceKey), "CODE-A");
  const accessToken = (await log.mint(g.grant, "CODE-A")).token;

  const call = async (l: SpaceLog, name: string, args: unknown): Promise<{ isError?: boolean; text: string }> => {
    const r = await l.fetch(
      new Request("http://relay.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
      }),
      ["mcp"],
      "http://relay.test",
    );
    const body = await r.text();
    const first = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean } })
      .at(0);
    return { isError: first?.result?.isError, text: first?.result?.content?.find((c) => c.type === "text")?.text ?? body };
  };

  // The Agent opens the Space: that is the only `attach()`, and the Space holds no Sends yet.
  const opened = await call(log, "open_space", { space: "plan" });
  assert.equal(opened.isError, false, `open_space failed: ${opened.text}`);

  // The Durable Object goes idle and is evicted (the self-hosted Relay restarts): the
  // space log's storage stays, the live session and its in-memory Space do not.
  log = make();

  // The person presses Send while nothing is materialized: the Link seals the change
  // and appends it, as it does.
  const presser = Space.create("plan", "space", "00112233445566778899aabbccddeeff") as never as {
    heads(): unknown[];
    freezeSend(p: string, d: string, raw: string, at: number): string;
    changesSince(before: unknown[]): Uint8Array;
  };
  const before = presser.heads();
  presser.freezeSend("p_0123456789abcdef", "dev-0", JSON.stringify({ send: "s_00000001", said: "here is the plan" }), Date.now());
  const sealed = sealEntry(keys, { v: 0, space: "plan", kind: "space", author: "device:dev-0", at: Date.now() }, presser.changesSince(before));
  await log.append(token, room, [b64(sealed)]);

  // The Agent's next call, with no open_space in between.
  const waited = await call(log, "wait_for_user", { space: "plan", timeout_s: 0 });
  assert.equal(waited.isError, false, `wait_for_user failed: ${waited.text}`);
  const json = JSON.parse(waited.text) as { kind?: string };
  assert.equal(json.kind, "send", `the Send the person pressed while the session was away never reached its Agent: ${waited.text}`);
});
