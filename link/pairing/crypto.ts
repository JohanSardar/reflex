// Device keys, the authenticated handshake, and encrypted frames.
//
// Every device has a long-term Ed25519 key. Its device ID is derived from that
// key, so a device can't claim another's ID. A connection starts with a
// handshake: both sides send a hello with their key and a fresh X25519 key,
// then sign the transcript. Session keys come from the X25519 secret, so every
// frame after the handshake is encrypted and authenticated (ChaCha20-Poly1305
// with a counter nonce: a dropped, reordered or replayed frame fails).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

export const PROTOCOL = "reflex-link/v0";

export const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");
export const sha256 = (...parts: (Uint8Array | string)[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

// Raw 32-byte public keys travel on the wire; Node wants SPKI/DER.
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const rawPublic = (k: KeyObject): Buffer => (k.export({ format: "der", type: "spki" }) as Buffer).subarray(12);
const edPublic = (raw: Uint8Array): KeyObject =>
  createPublicKey({ key: Buffer.concat([ED_SPKI, raw]), format: "der", type: "spki" });
const xPublic = (raw: Uint8Array): KeyObject =>
  createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: "der", type: "spki" });

/** The device ID that belongs to an Ed25519 public key. */
export function deviceIdFor(publicKey: Uint8Array): string {
  return `dev-${sha256(publicKey).subarray(0, 8).toString("hex")}`;
}

export interface DeviceKey {
  privateKey: KeyObject;
  publicRaw: Buffer;
  device: string;
}

export function newDeviceKey(): { pem: string; key: DeviceKey } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  return { pem, key: loadDeviceKey(pem) };
}

export function loadDeviceKey(pem: string): DeviceKey {
  const privateKey = createPrivateKey(pem);
  const publicRaw = rawPublic(createPublicKey(privateKey));
  return { privateKey, publicRaw, device: deviceIdFor(publicRaw) };
}

export function signWith(key: DeviceKey, msg: Uint8Array | string): string {
  return b64(sign(null, Buffer.from(msg), key.privateKey));
}

export function verifyFrom(publicRaw: Uint8Array, msg: Uint8Array | string, sig: string): boolean {
  try {
    return verify(null, Buffer.from(msg), edPublic(publicRaw), unb64(sig));
  } catch {
    return false;
  }
}

export function mac(secret: Uint8Array, msg: Uint8Array | string): string {
  return b64(createHmac("sha256", secret).update(msg).digest());
}

export function macEqual(a: string, b: string): boolean {
  const x = unb64(a);
  const y = unb64(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface Ephemeral {
  privateKey: KeyObject;
  publicRaw: Buffer;
}

export function newEphemeral(): Ephemeral {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicRaw: rawPublic(publicKey) };
}

/** Directional session keys for one connection. */
export function sessionKeys(mine: Ephemeral, theirRaw: Uint8Array, transcript: Buffer): { i2r: Buffer; r2i: Buffer } {
  const shared = diffieHellman({ privateKey: mine.privateKey, publicKey: xPublic(theirRaw) });
  const okm = Buffer.from(hkdfSync("sha256", shared, transcript, `${PROTOCOL} session keys`, 64));
  return { i2r: okm.subarray(0, 32), r2i: okm.subarray(32, 64) };
}

/** One direction of an encrypted session. Nonces are a counter; frames must arrive in order. */
export class FrameCipher {
  #key: Buffer;
  #aad: Buffer;
  #n = 0n;
  constructor(key: Buffer, aad: Buffer) {
    this.#key = key;
    this.#aad = aad;
  }
  #nonce(): Buffer {
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(this.#n++, 4);
    return n;
  }
  seal(plain: Uint8Array): Buffer {
    const c = createCipheriv("chacha20-poly1305", this.#key, this.#nonce(), { authTagLength: 16 });
    c.setAAD(this.#aad, { plaintextLength: plain.length });
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([body, c.getAuthTag()]);
  }
  open(sealed: Uint8Array): Buffer {
    if (sealed.length < 16) throw new Error("frame too short");
    const body = sealed.subarray(0, sealed.length - 16);
    const d = createDecipheriv("chacha20-poly1305", this.#key, this.#nonce(), { authTagLength: 16 });
    d.setAAD(this.#aad, { plaintextLength: body.length });
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(body), d.final()]); // throws if tampered, replayed or reordered
  }
}
