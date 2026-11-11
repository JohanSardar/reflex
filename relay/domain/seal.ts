// Sealing log entries and assets with a Space key, synchronously, the same way
// in Workers and Node (pure JS: no Node crypto, no async WebCrypto). The Link
// does the same with node:crypto (link/relay/keys.ts); the two must agree.
//
//   log id     hex(HMAC-SHA256(K, "reflex-relay/v0 log id"))      names the log; reveals nothing about the Space
//   log token  b64url(HMAC-SHA256(K, "reflex-relay/v0 log token"))  proves the holder knows K; the relay keeps its hash
//   entry key  HMAC-SHA256(K, "reflex-relay/v0 entry key")
//   asset key  HMAC-SHA256(K, "reflex-relay/v0 asset key"); an asset's relay ID is hex(HMAC(asset key, its SHA-256 hex))
//
// Sealed = nonce (12 random bytes) || AES-256-GCM(plain) || tag (16), with
// AAD "reflex-relay/v0 <what> <log>". An entry's plain text is
// [u32 BE header length][header JSON][change bytes].
import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { RELAY_PROTOCOL, type EntryHeader } from "./wire.ts";

const te = new TextEncoder();
const td = new TextDecoder();

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const b64url = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const sha256hex = (data: Uint8Array | string): string => hex(sha256(typeof data === "string" ? te.encode(data) : data));
export const random = (n: number): Uint8Array => randomBytes(n);

const mac = (key: Uint8Array, label: string): Uint8Array => hmac(sha256, key, te.encode(`${RELAY_PROTOCOL} ${label}`));

export interface SpaceKeys {
  log: string;
  token: string;
  entry: Uint8Array;
  asset: Uint8Array;
}

export function spaceKeys(key: Uint8Array): SpaceKeys {
  if (key.length !== 32) throw new Error("a Space key is 32 bytes");
  return { log: hex(mac(key, "log id")), token: b64url(mac(key, "log token")), entry: mac(key, "entry key"), asset: mac(key, "asset key") };
}

export function assetId(keys: SpaceKeys, hash: string): string {
  return hex(hmac(sha256, keys.asset, te.encode(hash)));
}

export function seal(key: Uint8Array, aad: string, plain: Uint8Array): Uint8Array {
  const nonce = randomBytes(12);
  const body = gcm(key, nonce, te.encode(aad)).encrypt(plain);
  const out = new Uint8Array(12 + body.length);
  out.set(nonce);
  out.set(body, 12);
  return out;
}

/** Throws if the bytes were not sealed with this key for this purpose. */
export function open(key: Uint8Array, aad: string, sealed: Uint8Array): Uint8Array {
  if (sealed.length < 28) throw new Error("sealed bytes too short");
  return gcm(key, sealed.subarray(0, 12), te.encode(aad)).decrypt(sealed.subarray(12));
}

export function sealEntry(keys: SpaceKeys, header: EntryHeader, bytes: Uint8Array): Uint8Array {
  const head = te.encode(JSON.stringify(header));
  const plain = new Uint8Array(4 + head.length + bytes.length);
  new DataView(plain.buffer).setUint32(0, head.length);
  plain.set(head, 4);
  plain.set(bytes, 4 + head.length);
  return seal(keys.entry, `${RELAY_PROTOCOL} entry ${keys.log}`, plain);
}

export function openEntry(keys: SpaceKeys, sealed: Uint8Array): { header: EntryHeader; bytes: Uint8Array } {
  const plain = open(keys.entry, `${RELAY_PROTOCOL} entry ${keys.log}`, sealed);
  const n = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  return { header: JSON.parse(td.decode(plain.subarray(4, 4 + n))), bytes: plain.subarray(4 + n) };
}

export function sealAsset(keys: SpaceKeys, bytes: Uint8Array): Uint8Array {
  return seal(keys.asset, `${RELAY_PROTOCOL} asset ${keys.log}`, bytes);
}

export function openAsset(keys: SpaceKeys, sealed: Uint8Array): Uint8Array {
  return open(keys.asset, `${RELAY_PROTOCOL} asset ${keys.log}`, sealed);
}

/** The Space key, wrapped under an access token so the relay can't read it at rest without that token. */
export function wrapKey(token: string, key: Uint8Array): Uint8Array {
  return seal(hmac(sha256, te.encode(token), te.encode(`${RELAY_PROTOCOL} wrap`)), `${RELAY_PROTOCOL} space key`, key);
}

export function unwrapKey(token: string, wrapped: Uint8Array): Uint8Array {
  return open(hmac(sha256, te.encode(token), te.encode(`${RELAY_PROTOCOL} wrap`)), `${RELAY_PROTOCOL} space key`, wrapped);
}

/** Ed25519 verify through WebCrypto, which Workers and Node both have. */
export async function verifyEd25519(publicRaw: Uint8Array, msg: Uint8Array | string, sig: Uint8Array): Promise<boolean> {
  try {
    const k = await crypto.subtle.importKey("raw", publicRaw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", k, sig as BufferSource, (typeof msg === "string" ? te.encode(msg) : msg) as BufferSource);
  } catch {
    return false;
  }
}

/** The device ID that belongs to an Ed25519 key (link/pairing/crypto.ts). */
export function deviceIdFor(publicRaw: Uint8Array): string {
  return "dev-" + hex(sha256(publicRaw)).slice(0, 16);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
