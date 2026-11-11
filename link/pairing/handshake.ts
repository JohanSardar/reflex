// The handshake that turns a pending Path into a session bound to one device.
//
//   I → R  hello  { device, key, eph, person, name, pair? }
//   R → I  hello  { device, key, eph, person, name }
//   I → R  auth   { sig: Ed25519(transcript), mac?: HMAC(pairing secret, transcript) }
//   R → I  auth   { sig, mac? }
//
// The transcript is the hash of both hello frames as sent. Each side checks the
// other's signature against the key in its hello, and that the device ID is the
// one derived from that key. Then a peer is trusted only if it is already
// paired with exactly that key, or it proves it knows the secret of a live
// pairing offer (which only someone who saw the QR code knows). Everything
// after the handshake is encrypted with keys from the X25519 exchange.
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
  pair?: string; // offer ID, when pairing
}

export interface PeerInfo {
  device: string;
  key: string;
  person: Person;
  name: string;
}

/** What the coordinator tells the handshake about trust. */
export interface Trust {
  /** The key this device was paired with, if it is paired. */
  pairedKey(device: string): string | undefined;
  /** The secret of a live pairing offer, if `offer` names one (responder side). */
  offerSecret(offer: string): Uint8Array | undefined;
}

/** A pairing offer read from a QR code (initiator side). */
export interface ScannedOffer {
  offer: string;
  device: string;
  key: string;
  secret: Uint8Array;
}

export interface Me {
  key: DeviceKey;
  person: Person;
  name: string;
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
}

export async function handshake(path: Path, me: Me, trust: Trust, scanned?: ScannedOffer): Promise<HandshakeResult> {
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
    ...(scanned && role === "i" ? { pair: scanned.offer } : {}),
  };
  const mine = enc(hello);
  let theirsRaw: Uint8Array;
  let theirs: Hello;
  if (role === "i") {
    await path.send(mine, "control");
    const r = await nextJson(path, 10_000);
    theirsRaw = r.raw;
    theirs = checkHello(r.msg);
  } else {
    const r = await nextJson(path, 10_000);
    theirsRaw = r.raw;
    theirs = checkHello(r.msg);
    await path.send(mine, "control");
  }
  const transcript = role === "i" ? sha256(PROTOCOL, mine, theirsRaw) : sha256(PROTOCOL, theirsRaw, mine);
  const other = role === "i" ? "r" : "i";

  // Which secret, if any, this connection pairs with.
  let secret: Uint8Array | undefined;
  let offer: string | undefined;
  if (role === "i" && scanned) {
    if (theirs.device !== scanned.device || theirs.key !== scanned.key)
      throw new Error("the device that answered is not the one in the pairing code");
    secret = scanned.secret;
    offer = scanned.offer;
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
  return { session, peer: { device: theirs.device, key: theirs.key, person: theirs.person, name: theirs.name }, paired, offer };
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
