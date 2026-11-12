// An Agent with the person's shell must not approve itself through Reflex.
//
// It can make a pairing code (`reflex pair` is an admin call), stop the Link
// (`reflex link stop`) and run `reflex link` itself under a pty, read the code
// that terminal shows, and type `y` there. Once the person's own iPad approves,
// none of that makes it an approver: a newly paired iPad syncs, and approves
// only when an approving iPad says "Let … approve Agents?"; the terminal can
// only refuse.
//
// What this doesn't cover: code running as the person's OS user can read the
// device key in identity.json and sign catalog records itself. That stays
// possible until the keys move to the Keychain or the Secure Enclave
// (link/README.md, "Not here yet").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { identity } from "../home.ts";
import { Link } from "../link.ts";
import { LinkClient } from "../rpc/client.ts";
import { newDeviceKey } from "../pairing/crypto.ts";
import { handshake, type Session } from "../pairing/handshake.ts";
import { parseOffer } from "../pairing/offer.ts";
import { LanTransport } from "../transports/lan.ts";

const BIN = fileURLToPath(new URL("../bin/reflex-link.ts", import.meta.url));

/** A program that pairs with a code over the LAN and says it is an iPad, keeping every message it gets. */
async function fakeIpad(uri: string, name: string, key = newDeviceKey().key): Promise<{ session: Session; got: Record<string, any>[] }> {
  const o = parseOffer(uri);
  const lan = new LanTransport({ device: key.device, port: 0, advertise: false });
  const path = await lan.dial({ transport: "lan", device: o.device, host: "127.0.0.1", port: o.port });
  const r = await handshake(path, { key, person: o.person, name, kind: "ipad" }, { pairedKey: () => undefined, offerSecret: () => undefined }, o);
  const got: Record<string, any>[] = [];
  void (async () => {
    for (let m; (m = await r.session.next().catch(() => null)); ) got.push(m.h);
  })();
  return { session: r.session, got };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await ok())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const count = (got: Record<string, any>[], t: string): number => got.filter((h) => h.t === t).length;
const lastAgents = (got: Record<string, any>[]): Record<string, any> => got.filter((h) => h.t === "agents").at(-1)!;

/** Sends a decision and waits for the Link's answer to it (it answers every decision with `agents`). */
async function decide(ipad: { session: Session; got: Record<string, any>[] }, a: { id: string; requested_at: number }): Promise<void> {
  const before = count(ipad.got, "agents");
  await ipad.session.send({ t: "agent_decision", id: a.id, status: "approved", requested_at: a.requested_at });
  await until("the Link's answer", () => count(ipad.got, "agents") > before);
}

async function withLink(fn: (link: Link, dir: string, admin: LinkClient, log: string[]) => Promise<void>, dir = mkdtempSync(join(tmpdir(), "reflex-approve-"))): Promise<void> {
  const log: string[] = [];
  const link = new Link({ dir, port: 0, prompt: false, p2p: false, webPort: null, log: (m) => log.push(m) });
  await link.start();
  const admin = await LinkClient.connect(dir, "admin");
  try {
    await fn(link, dir, admin, log);
  } finally {
    admin.close();
    await link.stop();
  }
}

/** An Agent asks to be let in; returns its pending record. */
async function agentAsks(dir: string, admin: LinkClient, name = "Sneaky Agent"): Promise<{ id: string; status: string; requested_at: number }> {
  const agent = await LinkClient.connect(dir, "agent");
  await agent.call("agent.hello", { name, credential: name.padEnd(40, "x"), wait_s: 0 }).catch(() => {});
  agent.close();
  return (await admin.call<{ id: string; name: string; status: string; requested_at: number }[]>("agents.list")).find((a) => a.name === name)!;
}

test("an iPad paired with `reflex pair` after the person's iPad approves only when that iPad lets it", async () => {
  await withLink(async (link, dir, admin, log) => {
    const person = await fakeIpad(link.pairingCode("terminal"), "Person's iPad");
    const a = await agentAsks(dir, admin);
    const mine = await fakeIpad((await admin.call<{ uri: string }>("pair.offer")).uri, "Agent's iPad");
    await until("its first agents", () => count(mine.got, "agents") > 0);
    assert.equal(lastAgents(mine.got).approver, false, "a device paired with `reflex pair` was told it approves");
    await decide(mine, a);
    assert.equal((await agentAsks(dir, admin)).status, "pending", "an Agent approved itself through a device it paired with `reflex pair`");
    assert.ok(mine.got.some((h) => h.t === "agent_decision_refused"), "the device wasn't told its Allow doesn't count");

    // The person's iPad hears of it, and is asked whether it may approve.
    await until("the person's iPad hears of it", () => person.got.some((h) => h.t === "device_paired" && h.name === "Agent's iPad"));
    await until("the person's iPad is asked", () => person.got.some((h) => h.t === "approver_requests" && h.requests.some((r: any) => r.name === "Agent's iPad")));

    // The person's own Allow still counts.
    await decide(person, a);
    assert.ok(log.some((m) => m.includes(`(${a.id}) approved`)), "the person's Allow didn't land");
    person.session.close("done");
    mine.session.close("done");
  });
});

test("the first iPad paired with `reflex pair` on a new profile may approve; after the window it may not", async () => {
  await withLink(async (_link, dir, admin, log) => {
    const ipad = await fakeIpad((await admin.call<{ uri: string }>("pair.offer")).uri, "iPad");
    const a = await agentAsks(dir, admin, "Claude Code");
    await decide(ipad, a);
    assert.ok(log.some((m) => m.includes(`(${a.id}) approved`)), "the first iPad, paired during setup, couldn't approve");
    ipad.session.close("done");
  });
  process.env.REFLEX_FIRST_PAIR_S = "0";
  try {
    await withLink(async (_link, dir, admin) => {
      const ipad = await fakeIpad((await admin.call<{ uri: string }>("pair.offer")).uri, "Late iPad");
      const a = await agentAsks(dir, admin);
      await decide(ipad, a);
      assert.equal((await agentAsks(dir, admin)).status, "pending", "a `reflex pair` code made after the first-pairing window made an approver");
      ipad.session.close("done");
    });
  } finally {
    delete process.env.REFLEX_FIRST_PAIR_S;
  }
});

test("forgetting a gone approving iPad lets the reinstalled one approve with `reflex pair`, no terminal", async () => {
  // A profile made yesterday: its first-pairing window closed long ago.
  const dir = mkdtempSync(join(tmpdir(), "reflex-forget-"));
  identity(dir);
  const id = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
  writeFileSync(join(dir, "identity.json"), JSON.stringify({ ...id, created_at: Date.now() - 86_400_000 }), { mode: 0o600 });
  await withLink(async (link, dir, admin, log) => {
    const old = await fakeIpad(link.pairingCode("terminal"), "Old iPad");
    old.session.close("reinstalled");
    // The reinstalled app has a new key: it pairs, syncs, and can't approve while the old record approves.
    const key = newDeviceKey().key;
    const fresh = await fakeIpad((await admin.call<{ uri: string }>("pair.offer")).uri, "iPad", key);
    await until("its first agents", () => count(fresh.got, "agents") > 0);
    assert.equal(lastAgents(fresh.got).approver, false);
    fresh.session.close("done");

    const status = await admin.call<{ paired: { device: string; name: string }[] }>("status");
    await admin.call("forget", { device: status.paired.find((d) => d.name === "Old iPad")!.device });
    const again = await fakeIpad((await admin.call<{ uri: string }>("pair.offer")).uri, "iPad", key);
    await until("its first agents", () => count(again.got, "agents") > 0);
    assert.equal(lastAgents(again.got).approver, true, "the reinstalled iPad couldn't become the approver after the old one was forgotten");
    const a = await agentAsks(dir, admin, "Claude Code");
    await decide(again, a);
    assert.ok(log.some((m) => m.includes(`(${a.id}) approved`)));
    again.session.close("done");
  }, dir);
});

// The attack the second review reproduced, through the real command under a pty: stop the background Link, run
// `reflex link` in a terminal the Agent controls, pair its own "iPad" with the code it shows, and type y.
const python = spawnSync("python3", ["-c", "import pty"]).status === 0;
test("an Agent that stops the Link and runs `reflex link` in its own terminal can't approve itself", { skip: !python && "needs python3 for a pty" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-pty-approve-"));
  // The person set up and paired their iPad; it approves.
  await withLink(async (link, d, admin) => {
    const person = await fakeIpad(link.pairingCode("terminal"), "Person's iPad");
    await agentAsks(d, admin);
    person.session.close("done");
  }, dir);

  const ptyPy = join(dir, "pty.py");
  writeFileSync(
    ptyPy,
    "import os, pty, sys, select\npid, fd = pty.fork()\nif pid == 0:\n    os.execvp(sys.argv[1], sys.argv[1:])\nwhile True:\n    r, _, _ = select.select([fd, 0], [], [])\n    if fd in r:\n        try: d = os.read(fd, 65536)\n        except OSError: break\n        if not d: break\n        os.write(1, d)\n    if 0 in r:\n        d = os.read(0, 65536)\n        if not d: break\n        os.write(fd, d)\n",
  );
  const fg = spawn("python3", ["-I", ptyPy, process.execPath, BIN, "--home", dir, "--no-p2p", "--no-web", "--relay", "off", "--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  fg.stdout.on("data", (b) => (out += b));
  fg.stderr.on("data", (b) => (out += b));
  try {
    await until("the Link in the Agent's terminal", () => existsSync(join(dir, "link.json")) && /reflex:\/\/pair\?\S+/.test(out), 30_000);
    const admin = await LinkClient.connect(dir, "admin");
    try {
      const a = await agentAsks(dir, admin);
      // The code that terminal shows, scanned by the Agent's own "iPad".
      const mine = await fakeIpad(/reflex:\/\/pair\?\S+/.exec(out)![0], "Agent's iPad");
      await until("its first agents", () => count(mine.got, "agents") > 0);
      assert.equal(lastAgents(mine.got).approver, false, "an iPad paired from the terminal's code approves while the person's iPad does");
      await decide(mine, a);
      assert.equal((await agentAsks(dir, admin)).status, "pending", "an Agent approved itself with the terminal's pairing code");

      // y in that terminal, to the question it asks about an Agent asking now.
      const b = await agentAsks(dir, admin, "Another Agent");
      await until("the terminal's question", () => out.includes(`"Another Agent" (${b.id})`));
      fg.stdin.write("y\r");
      await until("the terminal's answer", () => out.includes("this terminal can only refuse"));
      assert.equal((await agentAsks(dir, admin, "Another Agent")).status, "pending", "an Agent approved itself by typing y in a terminal it runs");
      mine.session.close("done");
      await admin.call("shutdown");
    } finally {
      admin.close();
    }
    await until("the Link to stop", () => !existsSync(join(dir, "link.json")), 15_000);
  } finally {
    fg.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
