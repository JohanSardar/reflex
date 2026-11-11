// review round 2, S5: `#sessionFor` now admits several sessions on one log, but
// the memory guard still compares the isolate's *total* WASM memory against the
// per-session budget (relay/domain/log.ts:272-276) and, on that aggregate
// overage, writes the persistent `meta.too_big` marker for the current snapshot
// (relay/domain/log.ts:243-244). The Worker runs with memoryLimit 96 MB
// (relay/cloudflare/worker.ts:165) and keeps ONE WASM memory for every session
// (relay/cloudflare/kernel.ts:13), so two 60 MB sessions on the same Space trip
// the guard; the marker then survives the isolate restart that frees the memory
// (Durable Object storage, `meta`), and a Space that opens fine on its own is
// refused with 507 for as long as no new snapshot arrives.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SvgRenderer } from "../../agent/src/render.ts";
import { Space } from "@reflex/kernel/node";
import { newDeviceKey, signWith } from "../../link/pairing/crypto.ts";
import { SpaceLog } from "../domain/log.ts";
import type { Bucket, Hubs, Sql } from "../domain/ports.ts";
import { b64url, random, spaceKeys } from "../domain/seal.ts";
import { grantText, type Grant } from "../domain/wire.ts";

const MB = 1024 * 1024;
/** What one materialized Space takes, as `memoryBytes()` reports it. */
const SESSION = 60 * MB;
const LIMIT = 96 * MB;

function sqlite(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    all: <T>(q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as T[],
    run: (q: string, ...p: unknown[]) => void db.prepare(q).run(...(p as never[])),
  };
}

test("a second grant over the memory budget does not mark the Space too big for good", async () => {
  const spaceKey = random(32);
  const logId = spaceKeys(spaceKey).log;
  const dev = newDeviceKey().key;
  const token = "t".repeat(48);
  const sql = sqlite(); // the Durable Object's storage: outlives the isolate

  // The isolate's WASM memory: one buffer shared by every session, and it never
  // shrinks. A fresh isolate starts at zero.
  let used = 0;
  const kernel = {
    create: (id: string, kind: string, actor: string) => {
      used += SESSION;
      return Space.create(id, kind, actor) as never;
    },
    load: (bytes: Uint8Array, actor: string) => {
      used += SESSION;
      return Space.load(bytes, actor) as never;
    },
    memoryBytes: () => used,
  };
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
      memoryLimit: LIMIT,
    });
  let log = make();
  await log.append(token, "0123456789abcdef0123456789abcdef", []);

  const t0 = Date.now();
  const grant = (gid: string, agent: string): Grant => ({
    grant: gid,
    log: logId,
    space: "plan",
    kind: "space",
    epoch: 0,
    agent,
    name: "Cloud client",
    person: { id: "p_0123456789abcdef", name: "Johan" },
    scopes: ["read", "write"],
    issued: t0,
    expires: t0 + 60 * 60_000,
    device: dev.device,
    key: b64url(dev.publicRaw),
  });
  const open = async (l: SpaceLog, accessToken: string): Promise<Response> =>
    l.fetch(
      new Request("http://relay.test/mcp", { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
      ["mcp"],
      "http://relay.test",
    );

  const a = grant("g_000000000000000a", "a_rcAAAAA");
  await log.issueGrant(token, a, signWith(dev, grantText(a)), b64url(spaceKey), "CODE-A");
  const tokenA = (await log.mint(a.grant, "CODE-A")).token;
  const first = await open(log, tokenA);
  assert.notEqual(first.status, 507, "grant A alone does not fit the budget the test set up");

  // The second client is granted the same Space: its session is the second
  // copy in the isolate, over the budget. Refusing this one is expected.
  const b = grant("g_000000000000000b", "a_rcBBBBB");
  await log.issueGrant(token, b, signWith(dev, grantText(b)), b64url(spaceKey), "CODE-B");
  const tokenB = (await log.mint(b.grant, "CODE-B")).token;
  const second = await open(log, tokenB);
  assert.equal(second.status, 507, `the second session over the budget was not refused: ${second.status}`);
  assert.match(await second.text(), /too big to open/, "the refusal is not the memory guard's 507");

  // A ends, and the Durable Object is evicted: new isolate instance, empty WASM
  // memory, same storage. One session now fits again.
  await log.revokeGrant(token, a.grant);
  used = 0;
  log = make();
  const again = await open(log, tokenB);
  const body = await again.text();
  assert.notEqual(again.status, 507, `after the isolate restarted with empty memory, the Space is still refused: ${body}`);
});
