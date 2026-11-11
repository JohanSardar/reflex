// Space keys and sealing for the Relay's log, with node:crypto. Must match
// relay/domain/seal.ts byte for byte:
//
//   log id     hex(HMAC-SHA256(K, "reflex-relay/v0 log id"))
//   log token  b64url(HMAC-SHA256(K, "reflex-relay/v0 log token"))
//   entry key  HMAC-SHA256(K, "reflex-relay/v0 entry key")
//   asset key  HMAC-SHA256(K, "reflex-relay/v0 asset key"); asset ID = hex(HMAC(asset key, sha256 hex))
//   sealed     nonce(12) || AES-256-GCM(plain) || tag(16), AAD "reflex-relay/v0 <entry|asset> <log>"
//   entry      [u32 BE header length][header JSON][change bytes]
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { RELAY_PROTOCOL } from "../transports/relay.ts";

export interface SpaceKeys {
  log: string;
  token: string;
  entry: Buffer;
  asset: Buffer;
}

export interface EntryHeader {
  v: 0;
  space: string;
  kind: string;
  author: string;
  at: number;
  sig?: string;
  snapshot?: boolean;
}

const mac = (k: Uint8Array, label: string): Buffer => createHmac("sha256", k).update(`${RELAY_PROTOCOL} ${label}`).digest();

export function spaceKeys(k: Uint8Array): SpaceKeys {
  return { log: mac(k, "log id").toString("hex"), token: mac(k, "log token").toString("base64url"), entry: mac(k, "entry key"), asset: mac(k, "asset key") };
}

export const assetId = (keys: SpaceKeys, hash: string): string => createHmac("sha256", keys.asset).update(hash).digest("hex");

function seal(key: Buffer, aad: string, plain: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

function open(key: Buffer, aad: string, sealed: Uint8Array): Buffer {
  const b = Buffer.from(sealed);
  if (b.length < 28) throw new Error("sealed bytes too short");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

export function sealEntry(keys: SpaceKeys, header: EntryHeader, bytes: Uint8Array): Buffer {
  const head = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return seal(keys.entry, `${RELAY_PROTOCOL} entry ${keys.log}`, Buffer.concat([len, head, bytes]));
}

export function openEntry(keys: SpaceKeys, sealed: Uint8Array): { header: EntryHeader; bytes: Buffer } {
  const plain = open(keys.entry, `${RELAY_PROTOCOL} entry ${keys.log}`, sealed);
  const n = plain.readUInt32BE(0);
  return { header: JSON.parse(plain.subarray(4, 4 + n).toString("utf8")), bytes: plain.subarray(4 + n) };
}

export const sealAsset = (keys: SpaceKeys, bytes: Uint8Array): Buffer => seal(keys.asset, `${RELAY_PROTOCOL} asset ${keys.log}`, bytes);

/** A grant as relay/domain/wire.ts signs it: the same fields, in the same order. */
export interface Grant {
  grant: string;
  log: string;
  space: string;
  kind: string;
  epoch: number;
  agent: string;
  name: string;
  person: { id: string; name: string };
  scopes: string[];
  issued: number;
  expires: number;
  device: string;
  key: string;
}

export function grantText(g: Grant): string {
  const { grant, log, space, kind, epoch, agent, name, person, scopes, issued, expires, device, key } = g;
  return `${RELAY_PROTOCOL} grant ` + JSON.stringify({ grant, log, space, kind, epoch, agent, name, person, scopes, issued, expires, device, key });
}
