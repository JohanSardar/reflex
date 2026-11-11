// The Space key the Link sends with a grant is the Relay's only copy, and the
// Relay is not supposed to be able to read a log at rest:
//
//   relay/README.md  "The Space key arrives with the grant and is kept as is
//                     only until the token exchange (at most 10 minutes); then
//                     it is wrapped under the access token."
//   relay/domain/log.ts:24  "The key is kept as is only until the OAuth token
//                            exchange (at most 10 minutes)."
//
// An uncollected grant keeps it for the grant's whole life instead:
// `expire()` clears `plain_key` only when `expires <= now` (the grant's own
// expiry, up to 30 days), never when the 10-minute window that `issueGrant`
// wakes at has passed. After 10 minutes no token exchange is possible anyway:
// the pending sign-in expires after 10 minutes (relay/domain/oauth.ts PENDING_MS).
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startRelayAt } from "./harness.ts";
import { identity, home } from "../../link/home.ts";
import { Catalog } from "../../link/pairing/catalog.ts";
import { RelaySync } from "../../link/relay/sync.ts";
import { AssetStore } from "../../link/storage/assets.ts";
import { openDb } from "../../link/storage/db.ts";
import { Inbox } from "../../link/storage/inbox.ts";
import { SpaceStore } from "../../link/storage/journal.ts";
import { RelayTransport, roomFor } from "../../link/transports/relay.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("a grant nobody collects drops the plain Space key within 10 minutes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-review-plain-key-"));
  const relayDir = join(dir, "relay");
  let relay = await startRelayAt(relayDir);
  const id = identity(join(dir, "link"));
  const h = home(join(dir, "link"));
  const db = openDb(h.db);
  const store = new SpaceStore(db, id.actor, new Inbox(db));
  store.recover();
  const transport = new RelayTransport({ url: `ws://127.0.0.1:${relay.port}`, key: id.key, room: () => roomFor(id.person.id), watch: () => [], log: () => {} });
  const sync = new RelaySync({ db, store, assets: new AssetStore(h.assets), catalog: new Catalog(db, id.key), transport, key: id.key, person: () => id.person, connected: () => false, log: () => {} });
  const realNow = Date.now;

  let log: string;
  let gid: string;
  try {
    await transport.listen(() => {});
    for (let i = 0; i < 200 && !transport.connected; i++) await new Promise((r) => setTimeout(r, 50));
    store.ensure("plan", "space");
    await new Promise((r) => setTimeout(r, 500));
    log = sync.keys("plan").log;

    const reg = (await (
      await fetch(`${relay.http}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Abandoned client", redirect_uris: ["http://127.0.0.1:9999/cb"] }),
      })
    ).json()) as { client_id: string };
    const page = await (
      await fetch(
        `${relay.http}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/cb")}` +
          `&code_challenge=${"A".repeat(43)}&code_challenge_method=S256`,
      )
    ).text();
    const code = /id="code">([A-Z0-9-]+)</.exec(page)?.[1];
    assert.ok(code, "the sign-in page has no code");
    // Approved by the Link's terminal for an hour; the client never comes back for its token.
    gid = (await sync.issue(code, "plan", 3_600_000, "Abandoned client")).gid;
  } finally {
    await transport.close();
    await relay.close();
  }

  const plainKey = (): string => {
    const d = new DatabaseSync(join(relayDir, "logs", `${log}.sqlite`), { readOnly: true });
    try {
      const row = d.prepare("SELECT plain_key FROM grants WHERE gid = ?").get(gid) as { plain_key: Uint8Array | null };
      return row.plain_key ? "the plain Space key" : "nothing";
    } finally {
      d.close();
    }
  };
  assert.equal(plainKey(), "the plain Space key", "nothing to test if the key was never there");

  // 11 minutes later: the alarm that `issueGrant` set at 10 minutes has fired in
  // a long-running Relay (a restart runs the same `expire()`), so run it the way
  // the Relay does, with the clock where it would be.
  const later = realNow() + 11 * 60_000;
  Date.now = () => later;
  try {
    relay = await startRelayAt(relayDir, relay.port);
  } finally {
    Date.now = realNow;
  }
  await relay.close();
  assert.equal(plainKey(), "nothing", "11 minutes after the grant was issued, the Relay still holds the Space key in the clear");
});
