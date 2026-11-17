// CPace over X25519: the typed code checked through a Relay (draft-irtf-cfrg-cpace).
//
// Through a Relay the code meets strangers: everyone pairing on that Relay waits in one pairing room, and the
// iPad tries the code on each Link there. So the check must cost a party that doesn't know the code exactly
// one guess per attempt, and tell it nothing else, whichever side it plays. CPace does that:
//
//   g  = a point on Curve25519 hashed from the code and this connection's transcript
//   I → R  cpace  Ya = X25519(ya, g)
//   R → I  cpace  Yb = X25519(yb, g)
//   K  = X25519(ya, Yb) = X25519(yb, Ya)
//
// Ya and Yb are random points whatever the code is, so watching them (the Relay sees them) says nothing about
// it, and K matches only when both used the same code. The auth MACs that follow (handshake.ts) prove K, and
// the Link counts a wrong one toward the code's 5 tries. Someone without the code gets 1 chance in a million
// per try, as with croc's PAKE over its code words.
//
// g is found by try-and-increment: hash, and keep the first u-coordinate that is on the curve (not its
// twist), so Ya and Yb don't give away which side of the curve the code hashed to. The loop's length
// depends on the code, but only this device sees how long it took.
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from "node:crypto";
import { PROTOCOL, sha256 } from "./crypto.ts";

const P = 2n ** 255n - 19n;
const A = 486662n;

function modpow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b %= P;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

const le = (b: Uint8Array): bigint => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);

/** The generator for this code on this connection: a u-coordinate on Curve25519 (32 bytes, little-endian). */
export function cpaceGenerator(code: string, transcript: Uint8Array): Buffer {
  for (let i = 0; i < 1000; i++) {
    const h = sha256(PROTOCOL, ` cpace generator ${i} `, code, " ", transcript);
    h[31] &= 0x7f;
    const u = le(h);
    if (u < 2n || u >= P) continue;
    // On the curve when u³ + Au² + u is a square (Euler's criterion).
    if (modpow((u * ((u * (u + A)) % P) + u) % P, (P - 1n) / 2n) === 1n) return h;
  }
  throw new Error("no generator found"); // 2^-1000
}

const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");

/** X25519(scalar, u), throwing on the all-zero result a low-order point gives. */
function x25519(scalar: KeyObject, u: Uint8Array): Buffer {
  return diffieHellman({ privateKey: scalar, publicKey: createPublicKey({ key: Buffer.concat([X_SPKI, u]), format: "der", type: "spki" }) });
}

/** One side's CPace: its share to send, and the secret once the other side's share arrives. */
export class Cpace {
  #y: KeyObject;
  readonly share: Buffer;
  constructor(code: string, transcript: Uint8Array, scalar?: Uint8Array) {
    this.#y = scalar ? createPrivateKey({ key: Buffer.concat([X_PKCS8, scalar]), format: "der", type: "pkcs8" }) : generateKeyPairSync("x25519").privateKey;
    this.share = x25519(this.#y, cpaceGenerator(code, transcript));
  }
  /** The pairing secret the auth MACs use: from K, both shares (initiator's first) and the transcript. */
  secret(theirs: Uint8Array, initiator: boolean, transcript: Uint8Array): Buffer {
    if (theirs.length !== 32) throw new Error("malformed CPace share");
    const k = x25519(this.#y, theirs);
    const [ya, yb] = initiator ? [this.share, theirs] : [theirs, this.share];
    return sha256(PROTOCOL, " cpace secret ", k, ya, yb, transcript);
  }
}
