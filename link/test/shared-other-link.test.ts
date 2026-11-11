// A person's other Links get the share records their Links hold (link/shared.ts `#sendShare`:
// "To this person's other Links, every record"), so a Space shared with a person is theirs on
// every Link they run, with its key (ADR-0008: one key, held by every member's devices).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog, type PairedDevice } from "../pairing/catalog.ts";
import { b64, newDeviceKey } from "../pairing/crypto.ts";
import { openDb } from "../storage/db.ts";
import { Shares } from "../sharing.ts";

test("a Space shared with this person reaches their other Link", () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-shared-links-"));
  const alice = { person: { id: "p_0000000000a1", name: "Alice" }, key: newDeviceKey().key };
  const bobPerson = { id: "p_0000000000b2", name: "Bob" };
  const bob1 = { person: bobPerson, key: newDeviceKey().key };
  const bob2 = { person: bobPerson, key: newDeviceKey().key };

  // Alice's Link invites Bob as an editor; the record is signed by Alice's Link.
  const aliceDb = openDb(join(dir, "alice.db"));
  const aliceShares = new Shares(new Catalog(aliceDb, alice.key), () => alice);
  const record = aliceShares.add(
    "s1",
    "space",
    { person: bobPerson, role: "editor", device: bob1.key.device, key: b64(bob1.key.publicRaw), since: Date.now() },
    null,
  );

  // Bob's second Link: the same person, a Link of theirs paired with the first (link/pairing).
  const bobDb = openDb(join(dir, "bob2.db"));
  const catalog = new Catalog(bobDb, bob2.key);
  const first: PairedDevice = { device: bob1.key.device, key: b64(bob1.key.publicRaw), name: "Bob's desktop", person: bobPerson, kind: "link", via: "offer", paired_at: Date.now() };
  catalog.pairDevice(first);
  const bob2Shares = new Shares(catalog, () => bob2);

  // Bob's first Link hands its records on when the second one connects (link/shared.ts `bound`).
  const r = bob2Shares.accept(record, first);
  assert.equal(r.ok, true, `Bob's other Link refused the record its own Link passed on: ${r.why}`);
  const kept = bob2Shares.get("s1");
  assert.ok(kept, "Bob's other Link does not hold the Space");
  assert.equal(kept.relay, null);

  aliceDb.close();
  bobDb.close();
  rmSync(dir, { recursive: true, force: true });
});
