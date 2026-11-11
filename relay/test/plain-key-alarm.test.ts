// review round 2, S4: the 10-minute plain-key deadline is only honoured if the
// platform is still woken at it. Both platforms keep ONE alarm and the last
// `wakeAt` wins: relay/node/server.ts:88 `clearTimeout(timers.get(id))` then a
// new timer, and relay/cloudflare/worker.ts:164 `setAlarm(at)` replaces the
// alarm. `mint()` (relay/domain/log.ts:204) schedules the *minted* grant's own
// expiry unconditionally, so an uncollected grant's 10-minute key clear is
// dropped as soon as any other grant on the same log is exchanged.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SvgRenderer } from "../../agent/src/render.ts";
import { newDeviceKey, signWith } from "../../link/pairing/crypto.ts";
import { SpaceLog } from "../domain/log.ts";
import type { Bucket, Hubs, Sql } from "../domain/ports.ts";
import { b64url, random, spaceKeys } from "../domain/seal.ts";
import { grantText, type Grant } from "../domain/wire.ts";

const MIN = 60_000;

function sqlite(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    all: <T>(q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as T[],
    run: (q: string, ...p: unknown[]) => void db.prepare(q).run(...(p as never[])),
  };
}

test("another grant's token exchange leaves the 10-minute plain-key alarm in place", async () => {
  const spaceKey = random(32);
  const logId = spaceKeys(spaceKey).log;
  const dev = newDeviceKey().key;
  const token = "t".repeat(48);

  // The platform's single wake time, replaced by every `wakeAt` (see the two
  // implementations above).
  let alarm = 0;
  const log = new SpaceLog({
    id: logId,
    sql: sqlite(),
    bucket: { put: async () => {}, get: async () => null, has: async () => false } as Bucket,
    hubs: {
      log: () => ({}) as never,
      auth: () => ({ approve: async () => {}, lookup: async () => ({ client: "c", client_uri: null, scope: "space" }) }),
      room: () => ({ notify: async () => {} }),
    } as unknown as Hubs,
    kernel: { create: () => ({} as never), load: () => ({} as never) },
    renderer: () => new SvgRenderer(),
    log: () => {},
    wakeAt: (at) => {
      alarm = at;
    },
  });
  await log.append(token, "0123456789abcdef0123456789abcdef", []);

  const t0 = Date.now();
  const grant = (gid: string, ms: number, agent: string): Grant => ({
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
    expires: t0 + ms,
    device: dev.device,
    key: b64url(dev.publicRaw),
  });

  // Grant A is approved and the client never comes back for its token: the key
  // waits, and the Relay wakes at 10 minutes to drop it.
  const a = grant("g_000000000000000a", 30 * 24 * 60 * MIN, "a_rcAAAAA");
  await log.issueGrant(token, a, signWith(dev, grantText(a)), b64url(spaceKey), "CODE-A");
  const deadlineA = alarm;
  assert.ok(deadlineA > 0 && deadlineA <= Date.now() + 10 * MIN, `grant A did not schedule its 10-minute key clear (${deadlineA})`);

  // Meanwhile another client is granted the same Space and exchanges its token.
  const b = grant("g_000000000000000b", 60 * MIN, "a_rcBBBBB");
  await log.issueGrant(token, b, signWith(dev, grantText(b)), b64url(spaceKey), "CODE-B");
  await log.mint(b.grant, "CODE-B");

  assert.ok(
    alarm <= deadlineA,
    `the Relay is now woken at ${new Date(alarm).toISOString()}, not at grant A's 10-minute key clear ` +
      `(${new Date(deadlineA).toISOString()}): A's plain Space key sits in the database until then`,
  );
});
