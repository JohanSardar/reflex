// A member's Link may write only as its own person and the Agents it hosts: the owner's Link
// must refuse a change that makes the owner's person write (link/sharing.ts `writers`,
// kernel/core/src/auth.rs, ARCHITECTURE §7.2).
//
// The Send is the sharp case: every Send records who sent it (`from`) and carries only that
// person's Marks (ADR-0008, T22). If a member's Link can write for the owner, an editor's Link
// can hand the owner's Agents a Send that looks like the owner's, and can erase the owner's Ink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Space } from "@reflex/kernel/node";
import { Catalog } from "../pairing/catalog.ts";
import { b64, newDeviceKey } from "../pairing/crypto.ts";
import { openDb } from "../storage/db.ts";
import { Shares } from "../sharing.ts";
import { receiveChecked } from "../relay/sync.ts";

const ACTOR = "aa".repeat(16);

test("a member's Link cannot make a Send for the owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-shared-writers-"));
  const db = openDb(join(dir, "link.db"));
  const owner = { person: { id: "p_0000000000a1", name: "Alice" }, key: newDeviceKey().key };
  const member = { person: { id: "p_0000000000b2", name: "Bob" }, key: newDeviceKey().key };
  const catalog = new Catalog(db, owner.key);
  const shares = new Shares(catalog, () => owner);
  shares.add("s1", "space", { person: member.person, role: "editor", device: member.key.device, key: b64(member.key.publicRaw), since: Date.now() }, null);
  // The owner's Link met the member's Link through an invite (link/sync/coordinator.ts rememberGuest).
  catalog.pairDevice({ device: member.key.device, key: b64(member.key.publicRaw), name: "Bob's Link", person: member.person, kind: "link", via: "invite", paired_at: Date.now() });

  const ownerSpace = Space.create("s1", "space", ACTOR);
  ownerSpace.applyUserIntent(
    owner.person.id,
    owner.key.device,
    JSON.stringify({ intent: "add_stroke", id: "a1", stroke: { points: [[0, 0, 0, 0.5], [10, 10, 8, 0.5]], width: 3 }, color: "red" }),
    Date.now(),
  );
  const heads = ownerSpace.heads();

  // The member's Link holds the same Space and freezes a Send that claims to come from the owner.
  const memberSpace = Space.load(ownerSpace.save(), "bb".repeat(16));
  const send = JSON.parse(
    memberSpace.freezeSend(owner.person.id, member.key.device, JSON.stringify({ send: "s_forged", said: "looks right to me" }), Date.now()),
  );
  assert.equal(send.from.person, owner.person.id, "the forged Send claims the owner");
  const bytes = memberSpace.changesSince(heads);

  // What the owner's Link does with the changes the member's Link sends (link/relay/sync.ts, with
  // the writers link/sharing.ts gives another person's Link).
  const r = receiveChecked(ownerSpace, bytes, shares.writers(catalog.device(member.key.device), "s1"));
  assert.equal(r.ok, false, `the owner's Link accepted a Send made for the owner by the member's Link: ${JSON.stringify(r)}`);

  ownerSpace.free();
  memberSpace.free();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
