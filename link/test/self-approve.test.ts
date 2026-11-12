// An Agent with the person's shell must not approve itself. It can make a
// pairing code (`reflex pair` is an admin call) and pair a program of its own
// that says it is an iPad; once the person's own iPad is paired, that device
// syncs but its Allow doesn't count, and it is told so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Link } from "../link.ts";
import { LinkClient } from "../rpc/client.ts";
import { newDeviceKey } from "../pairing/crypto.ts";
import { handshake, type Session } from "../pairing/handshake.ts";
import { parseOffer } from "../pairing/offer.ts";
import { LanTransport } from "../transports/lan.ts";

/** A program that pairs with a code over the LAN and says it is an iPad, keeping every message it gets. */
async function fakeIpad(uri: string, name: string): Promise<{ session: Session; got: Record<string, unknown>[] }> {
  const o = parseOffer(uri);
  const { key } = newDeviceKey();
  const lan = new LanTransport({ device: key.device, port: 0, advertise: false });
  const path = await lan.dial({ transport: "lan", device: o.device, host: "127.0.0.1", port: o.port });
  const r = await handshake(path, { key, person: o.person, name, kind: "ipad" }, { pairedKey: () => undefined, offerSecret: () => undefined }, o);
  const got: Record<string, unknown>[] = [];
  void (async () => {
    for (let m; (m = await r.session.next().catch(() => null)); ) got.push(m.h);
  })();
  return { session: r.session, got };
}

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("an iPad paired with a code from `reflex pair` after the person's iPad can't approve an Agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-self-approve-"));
  const log: string[] = [];
  const link = new Link({ dir, port: 0, prompt: false, p2p: false, webPort: null, log: (m) => log.push(m) });
  await link.start();
  const admin = await LinkClient.connect(dir, "admin");
  const agent = await LinkClient.connect(dir, "agent");
  try {
    // The person pairs their iPad with the code in the Link's terminal.
    const person = await fakeIpad(link.pairingCode("terminal"), "Person's iPad");

    // An Agent asks to be let in, then makes a code of its own and pairs a program claiming to be an iPad.
    await agent.call("agent.hello", { name: "Sneaky Agent", credential: "x".repeat(40), wait_s: 0 }).catch(() => {});
    const [a] = await admin.call<{ id: string; status: string; requested_at: number }[]>("agents.list");
    const { uri } = await admin.call<{ uri: string }>("pair.offer");
    const mine = await fakeIpad(uri, "Agent's iPad");
    await until("the Link's first messages", () => mine.got.some((h) => h.t === "agents"));
    const before = mine.got.filter((h) => h.t === "agents").length;
    await mine.session.send({ t: "agent_decision", id: a.id, status: "approved", requested_at: a.requested_at });

    // The Link answers every decision with the Agents as they now stand.
    await until("the Link's answer", () => mine.got.filter((h) => h.t === "agents").length > before);
    const after = await admin.call<{ id: string; status: string }[]>("agents.list");
    assert.equal(after[0].status, "pending", "an Agent approved itself through a device it paired with `reflex pair`");
    assert.ok(mine.got.some((h) => h.t === "agent_decision_refused"), "the device wasn't told its Allow doesn't count");
    assert.ok(person.got.some((h) => h.t === "device_paired" && h.name === "Agent's iPad"), "the person's iPad wasn't told a new device paired");

    // The person's own Allow still counts.
    await person.session.send({ t: "agent_decision", id: a.id, status: "approved", requested_at: a.requested_at });
    await until("the person's approval", () => log.some((m) => m.includes(`(${a.id}) approved`)));
    person.session.close("done");
    mine.session.close("done");
  } finally {
    admin.close();
    agent.close();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first iPad paired with `reflex pair` (first-time setup) may approve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-first-approve-"));
  const log: string[] = [];
  const link = new Link({ dir, port: 0, prompt: false, p2p: false, webPort: null, log: (m) => log.push(m) });
  await link.start();
  const admin = await LinkClient.connect(dir, "admin");
  const agent = await LinkClient.connect(dir, "agent");
  try {
    const { uri } = await admin.call<{ uri: string }>("pair.offer");
    const ipad = await fakeIpad(uri, "iPad");
    await agent.call("agent.hello", { name: "Claude Code", credential: "y".repeat(40), wait_s: 0 }).catch(() => {});
    const [a] = await admin.call<{ id: string; requested_at: number }[]>("agents.list");
    await ipad.session.send({ t: "agent_decision", id: a.id, status: "approved", requested_at: a.requested_at });
    await until("the approval", () => log.some((m) => m.includes(`(${a.id}) approved`)));
    ipad.session.close("done");
  } finally {
    admin.close();
    agent.close();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
