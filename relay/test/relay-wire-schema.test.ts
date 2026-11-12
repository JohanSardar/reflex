// Review: every message the Relay puts on the wire is a relay.schema.json message,
// which is what tests/conformance/profiles/relay.ts ("every message it sent is a
// Protocol v1 relay message") and protocol/spec/transports.md §6 promise. The
// conformance profile never asks auth.lookup, so its answer goes unchecked.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, createHash, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deviceIdFor } from "../domain/seal.ts";
import { helloText } from "../domain/wire.ts";
import { invalidMessage } from "../../tests/conformance/lib/schemas.ts";
import { startRelayAt, sleep } from "./harness.ts";

type Msg = Record<string, any>;

/** One device's WebSocket to a room. */
class Device {
  readonly id: string;
  readonly key: string;
  #priv: KeyObject;
  ws!: WebSocket;
  msgs: Msg[] = [];

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
    this.key = raw.toString("base64url");
    this.id = deviceIdFor(new Uint8Array(raw));
    this.#priv = privateKey;
  }

  async connect(ws: string, room: string): Promise<void> {
    this.ws = new WebSocket(`${ws}/v0/connect?room=${room}`);
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") this.msgs.push(JSON.parse(e.data) as Msg);
    };
    const challenge = await this.wait((m) => m.t === "challenge", "a challenge");
    const sig = sign(null, Buffer.from(helloText(room, String(challenge.nonce))), this.#priv).toString("base64url");
    this.ws.send(JSON.stringify({ t: "hello", device: this.id, key: this.key, sig }));
    await this.wait((m) => m.t === "welcome", "a welcome");
  }

  async request(m: Msg): Promise<Msg> {
    this.ws.send(JSON.stringify(m));
    return this.wait((x) => x.t === "result" && x.req === m.req, `the result of ${m.t}`);
  }

  async wait(match: (m: Msg) => boolean, what: string, ms = 5000): Promise<Msg> {
    for (let end = Date.now() + ms; Date.now() < end || this.msgs.some(match); ) {
      const i = this.msgs.findIndex(match);
      if (i >= 0) return this.msgs.splice(i, 1)[0];
      await sleep(20);
    }
    throw new Error(`no ${what} within ${ms} ms`);
  }
}

test("auth.lookup's answer is a relay.schema.json message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-review-wire-"));
  const relay = await startRelayAt(join(dir, "relay"));
  const dev = new Device();
  try {
    // A sign-in waiting for the person's approval, the way a cloud Agent starts one.
    const reg = (await (
      await fetch(`${relay.http}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "A cloud Agent", redirect_uris: ["http://127.0.0.1:9999/cb"] }),
      })
    ).json()) as { client_id: string };
    const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
    const page = await (
      await fetch(
        `${relay.http}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/cb")}&code_challenge=${challenge}&code_challenge_method=S256`,
      )
    ).text();
    const code = /id="code">([A-Z0-9-]+)</.exec(page)?.[1];
    assert.ok(code, "the sign-in page has a code");

    await dev.connect(`ws://127.0.0.1:${relay.port}`, randomBytes(16).toString("hex"));
    const answer = await dev.request({ t: "auth.lookup", req: 1, code });
    assert.equal(answer.ok, true, `the lookup failed: ${JSON.stringify(answer)}`);

    assert.deepEqual(invalidMessage("relay", answer), [], `the Relay sent ${JSON.stringify(answer)}`);
  } finally {
    dev.ws?.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
