// The handshake that turns a pending Path into a session bound to one device.
//
//   I → R  hello  { device, key, eph, person, name, pair?, invite? }
//   R → I  hello  { device, key, eph, person, name }
//   I → R  auth   { sig: Ed25519(transcript), mac?: HMAC(pairing secret, transcript) }
//   R → I  auth   { sig, mac? }
//
// The transcript is the hash of both hello frames as sent. Each side checks the
// other's signature against the key in its hello, and that the device ID is the
// one derived from that key. Then a peer is trusted only if it is already
// paired with exactly that key, or it proves it knows the secret of a live
// pairing offer (which only someone who saw the QR code knows), or of a live
// invite to a shared Space (link/sharing.ts), which makes it a peer for that
// Space only. Everything after the handshake is encrypted with keys from the
// X25519 exchange.
//
// A typed 6-digit code (`pair: "code"`) is too short to use as an HMAC key:
// whoever saw one MAC could try all million codes offline. So the code is
// checked one digit per round, commit before reveal (Bluetooth's passkey entry):
//
//   I → R  commit  HMAC(nI, "code i <round> <digit>" ‖ transcript)
//   R → I  commit  HMAC(nR, "code r <round> <digit>" ‖ transcript)
//   I → R  reveal  nI        R checks it against its own digit
//   R → I  reveal  nR        I checks it against its own digit
//
// Neither side learns a digit before committing to its own guess of it, so
// someone in the middle gets through a round with 1 chance in 10, and through
// all six with 1 in a million. Then the code and transcript make the secret
// the auth MACs use, as for a scanned code.
import {
  b64,
  deviceIdFor,
  FrameCipher,
  mac,
  macEqual,
  newEphemeral,
  PROTOCOL,
  sessionKeys,
  sha256,
  signWith,
  unb64,
  verifyFrom,
  type DeviceKey,
} from "./crypto.ts";
import { randomBytes } from "node:crypto";
import type { Person } from "./catalog.ts";
import type { Path, PathMeasurements, Priority } from "../transports/transport.ts";

export interface Hello {
  t: "hello";
  v: 0;
  protocol: string;
  device: string;
  key: string;
  eph: string;
  person: Person;
  name: string;
  /** What this device is: an iPad, or a Link (which hosts Agents). */
  kind?: "ipad" | "link";
  pair?: string; // offer ID, when pairing
}

export interface PeerInfo {
  device: string;
  key: string;
  person: Person;
  name: string;
  kind: "ipad" | "link";
}

/** What the coordinator tells the handshake about trust. */
export interface Trust {
  /** The key this device was paired with, if it is paired. */
  pairedKey(device: string): string | undefined;
  /** The secret of a live pairing offer, if `offer` names one (responder side). */
  offerSecret(offer: string): Uint8Array | undefined;
  /** The live typed code, if there is one (responder side). */
  liveCode?(): string | undefined;
  /** A typed code that failed a round (responder side): counts toward its limit. */
  codeFailed?(): void;
  /** Uses up the typed code once its rounds pass, if it is still the live one; the Agents it approves, else undefined. */
  takeCode?(code: string, device: string): string[] | undefined;
}

/** A pairing offer read from a QR code (initiator side). */
export interface ScannedOffer {
  offer: string;
  device: string;
  key: string;
  secret: Uint8Array;
  /** A typed 6-digit code instead of a scanned secret: `offer` is "code" and `secret` is unused. */
  code?: string;
}

export interface Me {
  key: DeviceKey;
  person: Person;
  name: string;
  kind: "ipad" | "link";
}

const enc = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

async function nextJson(path: Path, ms: number): Promise<{ raw: Uint8Array; msg: Record<string, unknown> }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("handshake timed out")), ms);
  });
  try {
    const raw = await Promise.race([path.next(), timeout]);
    if (!raw) throw new Error("the other device closed the connection during the handshake");
    const msg = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (msg.t === "refused") throw new Error(`the other device refused: ${String(msg.reason)}`);
    return { raw, msg };
  } finally {
    clearTimeout(timer);
  }
}

function checkHello(m: Record<string, unknown>): Hello {
  const h = m as unknown as Hello;
  if (h.t !== "hello" || h.v !== 0 || h.protocol !== PROTOCOL) throw new Error(`peer speaks ${String(h.protocol)}, not ${PROTOCOL}`);
  if (typeof h.key !== "string" || typeof h.eph !== "string" || typeof h.device !== "string") throw new Error("malformed hello");
  if (deviceIdFor(unb64(h.key)) !== h.device) throw new Error(`device ID ${h.device} does not belong to its key`);
  return h;
}

export interface HandshakeResult {
  session: Session;
  peer: PeerInfo;
  /** True when this connection paired a new device (the caller stores it). */
  paired: boolean;
  offer?: string;
  /** True when the device paired with a typed code. */
  code?: boolean;
  /** The Agents the typed code approves (responder side). */
  codeAgents?: string[];
}

/** A failed handshake, with what the other side said about itself if its hello arrived (for a log line that names it). */
export class HandshakeError extends Error {
  peer?: { device: string; name: string; kind: "ipad" | "link"; paired: boolean; pair?: string };
}

export async function handshake(path: Path, me: Me, trust: Trust, scanned?: ScannedOffer): Promise<HandshakeResult> {
  let seen: HandshakeError["peer"];
  try {
    return await handshakeInner(path, me, trust, scanned, (h) => {
      seen = { device: h.device, name: String(h.name ?? ""), kind: h.kind === "ipad" ? "ipad" : "link", paired: trust.pairedKey(h.device) === h.key, ...(typeof h.pair === "string" ? { pair: h.pair } : {}) };
    });
  } catch (e) {
    const err = new HandshakeError((e as Error).message);
    err.peer = seen;
    throw err;
  }
}

async function handshakeInner(path: Path, me: Me, trust: Trust, scanned: ScannedOffer | undefined, saw: (h: Hello) => void): Promise<HandshakeResult> {
  const role = path.initiator ? "i" : "r";
  const eph = newEphemeral();
  const hello: Hello = {
    t: "hello",
    v: 0,
    protocol: PROTOCOL,
    device: me.key.device,
    key: b64(me.key.publicRaw),
    eph: b64(eph.publicRaw),
    person: me.person,
    name: me.name,
    kind: me.kind,
    ...(scanned && role === "i" ? { pair: scanned.code !== undefined ? "code" : scanned.offer } : {}),
  };
  const mine = enc(hello);
  let theirsRaw: Uint8Array;
  let theirs: Hello;
  if (role === "i") {
    await path.send(mine, "control");
    const r = await nextJson(path, 10_000);
    theirsRaw = r.raw;
    theirs = checkHello(r.msg);
    saw(theirs);
  } else {
    const r = await nextJson(path, 10_000);
    theirsRaw = r.raw;
    theirs = checkHello(r.msg);
    saw(theirs);
    await path.send(mine, "control");
  }
  const transcript = role === "i" ? sha256(PROTOCOL, mine, theirsRaw) : sha256(PROTOCOL, theirsRaw, mine);
  const other = role === "i" ? "r" : "i";

  // Which secret, if any, this connection pairs with.
  let secret: Uint8Array | undefined;
  let offer: string | undefined;
  let codeAgents: string[] | undefined;
  if (role === "i" && scanned) {
    if (theirs.device !== scanned.device || theirs.key !== scanned.key)
      throw new Error("the device that answered is not the one in the pairing code");
    secret = scanned.secret;
    offer = scanned.offer;
    if (scanned.code !== undefined) secret = await codeRounds(path, role, scanned.code, transcript);
  } else if (role === "r" && theirs.pair === "code") {
    const code = trust.liveCode?.();
    if (!code) throw new Error("no pairing code is live on this Link (they last 10 minutes; ask your agent for a new one)");
    try {
      secret = await codeRounds(path, role, code, transcript);
    } catch (e) {
      if (e instanceof WrongCode) trust.codeFailed?.();
      throw e;
    }
    // Single use, checked when the rounds end: a code that expired, was replaced or was used by another device meanwhile doesn't pair.
    codeAgents = trust.takeCode?.(code, theirs.device);
    if (!codeAgents) throw new Error("the pairing code expired or was already used (ask your agent for a new one)");
    offer = "code";
  } else if (role === "r" && typeof theirs.pair === "string") {
    secret = trust.offerSecret(theirs.pair);
    if (!secret) throw new Error("unknown or expired pairing offer");
    offer = theirs.pair;

  }

  const auth = {
    t: "auth",
    sig: signWith(me.key, Buffer.concat([Buffer.from(`${PROTOCOL} auth ${role} `), transcript])),
    ...(secret ? { mac: mac(secret, Buffer.concat([Buffer.from(`${PROTOCOL} pair ${role} `), transcript])) } : {}),
  };
  await path.send(enc(auth), "control");
  const { msg: a } = await nextJson(path, 10_000);
  if (a.t !== "auth" || typeof a.sig !== "string") throw new Error("malformed auth");
  if (!verifyFrom(unb64(theirs.key), Buffer.concat([Buffer.from(`${PROTOCOL} auth ${other} `), transcript]), a.sig))
    throw new Error("peer did not prove its key");

  let paired = false;
  const known = trust.pairedKey(theirs.device);
  if (secret) {
    const want = mac(secret, Buffer.concat([Buffer.from(`${PROTOCOL} pair ${other} `), transcript]));
    if (typeof a.mac !== "string" || !macEqual(a.mac, want)) throw new Error("peer does not know the pairing secret");
    if (known && known !== theirs.key) throw new Error(`device ${theirs.device} is already paired with another key`);
    paired = !known;
  } else if (known !== theirs.key) {
    throw new Error(`device ${theirs.device} is not paired`);
  }

  const keys = sessionKeys(eph, unb64(theirs.eph), transcript);
  const session = new Session(
    path,
    new FrameCipher(role === "i" ? keys.i2r : keys.r2i, transcript),
    new FrameCipher(role === "i" ? keys.r2i : keys.i2r, transcript),
  );
  const kind = theirs.kind === "ipad" ? "ipad" : "link";
  return { session, peer: { device: theirs.device, key: theirs.key, person: theirs.person, name: theirs.name, kind }, paired, offer, ...(offer === "code" ? { code: true, codeAgents: codeAgents ?? [] } : {}) };
}

/** A typed code that doesn't match, as opposed to a connection that broke. */
export class WrongCode extends Error {}

/** The six commit-then-reveal rounds (see the top of this file). Returns the secret the auth MACs use. */
async function codeRounds(path: Path, role: "i" | "r", code: string, transcript: Buffer): Promise<Buffer> {
  if (!/^\d{6}$/.test(code)) throw new WrongCode("a pairing code is 6 digits");
  const other = role === "i" ? "r" : "i";
  const commit = (n: Uint8Array, who: string, round: number, digit: string): string =>
    mac(n, Buffer.concat([Buffer.from(`${PROTOCOL} code ${who} ${round} ${digit} `), transcript]));
  const want = async (t: string, field: string): Promise<string> => {
    const { msg } = await nextJson(path, 10_000);
    if (msg.t !== t || typeof msg[field] !== "string") throw new Error(`expected ${t} during the code check`);
    return msg[field] as string;
  };
  for (let round = 0; round < 6; round++) {
    const digit = code[round];
    const n = randomBytes(16);
    const mine = commit(n, role, round, digit);
    let theirC: string;
    if (role === "i") {
      await path.send(enc({ t: "commit", c: mine }), "control");
      theirC = await want("commit", "c");
      await path.send(enc({ t: "reveal", n: b64(n) }), "control");
      const theirN = unb64(await want("reveal", "n"));
      if (!macEqual(theirC, commit(theirN, other, round, digit))) throw new WrongCode("wrong pairing code");
    } else {
      theirC = await want("commit", "c");
      await path.send(enc({ t: "commit", c: mine }), "control");
      const theirN = unb64(await want("reveal", "n"));
      if (!macEqual(theirC, commit(theirN, other, round, digit))) throw new WrongCode("wrong pairing code");
      await path.send(enc({ t: "reveal", n: b64(n) }), "control");
    }
  }
  return sha256(PROTOCOL, " code secret ", code, transcript);
}

export interface Message {
  h: Record<string, unknown> & { t: string };
  body: Uint8Array;
}

/** An authenticated, encrypted Path. Messages are a JSON header plus optional bytes. */
export class Session {
  readonly path: Path;
  #tx: FrameCipher;
  #rx: FrameCipher;

  constructor(path: Path, tx: FrameCipher, rx: FrameCipher) {
    this.path = path;
    this.#tx = tx;
    this.#rx = rx;
  }

  // Sealing happens in call order, so nonces match the order frames hit the wire.
  send(h: Message["h"], body: Uint8Array = new Uint8Array(), priority: Priority = "change"): Promise<void> {
    const head = Buffer.from(JSON.stringify(h));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length);
    const plain = Buffer.concat([len, head, body]);
    // Refuse before sealing: a frame that is sealed but never sent would put the nonces out of step.
    if (plain.length + 16 > this.path.limits.maxFrameBytes)
      return Promise.reject(new Error(`a ${h.t} message of ${plain.length} bytes is over the ${this.path.limits.maxFrameBytes}-byte frame limit`));
    return this.path.send(this.#tx.seal(plain), priority);
  }

  async next(): Promise<Message | null> {
    const f = await this.path.next();
    if (!f) return null;
    const plain = this.#rx.open(f);
    const n = plain.readUInt32BE(0);
    return { h: JSON.parse(plain.subarray(4, 4 + n).toString("utf8")), body: plain.subarray(4 + n) };
  }

  measurements(): PathMeasurements {
    return this.path.measurements();
  }

  close(reason: string): void {
    this.path.close(reason);
  }
}
