// The Relay's wire format, `reflex-relay/v0`. The Link's Relay transport
// (link/transports/relay.ts) and the iPad's (apps/ipad/.../RelayConnection.swift)
// speak the same thing; nothing imports this file from outside `relay/`.
//
// A device opens one WebSocket to `/v0/connect?room=<room>`. A room is where
// one person's devices meet: `room = hex(sha256("reflex-relay/v0 room " + person))[0..32]`.
//
//   relay → device  {t:"challenge", nonce}
//   device → relay  {t:"hello", device, key, sig}       sig = Ed25519("reflex-relay/v0 hello <room> <nonce>")
//   relay → device  {t:"welcome", device}
//   device → relay  {t:"watch", devices:[...]}          the devices it accepts frames from; replaces the list
//   relay → device  {t:"presence", device, online, joined?}  for each watched device, now and on every change;
//                                                       joined: it connected anew, so channels to it are gone
//
// Frames between two devices are binary WebSocket messages:
//
//   [u8 n][n bytes: device ID][u32 BE channel][payload]
//
// The sender writes the receiver's device ID; the relay rewrites it to the
// sender's before forwarding, so a device can't pretend to be another. It
// forwards only if the receiver watches the sender. Channel bit 31 is set by
// whoever opened the channel, so both ends can open channel 5 at once. The
// first frame on a new channel opens it; `{t:"close", device, ch}` closes it,
// and `{t:"undeliverable", device, ch}` says the receiver isn't there. The
// payloads are the end-to-end handshake and then frames sealed with keys the
// relay never sees (link/pairing/handshake.ts).
//
// Requests (each answered by `{t:"result", req, ok, ...}` or `{..., ok:false, error}`):
//
//   {t:"log.append", req, log, token, entries:[b64], snapshot?}  → {seqs}   snapshot: one entry holding the whole Space
//   {t:"log.read",   req, log, token, after, limit?}      → {entries:[{seq, data}], last}
//   {t:"log.watch",  req, log, token}                    → {last}; later {t:"log.new", log, last}
//   {t:"log.assets", req, log, token, ids}               → {have:[ids]}
//   {t:"auth.lookup", req, code}                          → {client, scope}
//   {t:"grant.issue", req, code, log, token, grant, key}  → {grant}
//   {t:"grant.revoke", req, log, token, grant}            → {}
//
// Assets go over HTTP: PUT/GET `/v0/log/<log>/assets/<id>` with
// `x-reflex-log-token`. Everything in a log or an asset is sealed with the
// Space key, which the relay holds only under a live grant (ADR-0004).
export const RELAY_PROTOCOL = "reflex-relay/v0";
export const MAX_FRAME = 4 * 1024 * 1024;
export const OPENER = 0x8000_0000;

export const LOG_ID = /^[0-9a-f]{64}$/;
export const ROOM_ID = /^[0-9a-f]{32}$/;
export const DEVICE_ID = /^dev-[0-9a-f]{16}$/;
export const ASSET_ID = /^[0-9a-f]{64}$/;

export function helloText(room: string, nonce: string): string {
  return `${RELAY_PROTOCOL} hello ${room} ${nonce}`;
}

/** `[u8 n][device][u32 ch][payload]` */
export function frame(device: string, ch: number, payload: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(device);
  const out = new Uint8Array(1 + id.length + 4 + payload.length);
  out[0] = id.length;
  out.set(id, 1);
  new DataView(out.buffer).setUint32(1 + id.length, ch >>> 0);
  out.set(payload, 5 + id.length);
  return out;
}

export function unframe(b: Uint8Array): { device: string; ch: number; payload: Uint8Array } | null {
  if (b.length < 5) return null;
  const n = b[0];
  if (b.length < 1 + n + 4) return null;
  const device = new TextDecoder().decode(b.subarray(1, 1 + n));
  const ch = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1 + n);
  return { device, ch, payload: b.subarray(5 + n) };
}

/** A grant as the device that issued it signs it (ADR-0004). */
export interface Grant {
  grant: string;
  log: string;
  space: string;
  kind: string;
  epoch: number;
  /** The Agent ID the cloud session writes as. */
  agent: string;
  /** The OAuth client's name, as the person saw it when they approved. */
  name: string;
  person: { id: string; name: string };
  scopes: string[];
  issued: number;
  expires: number;
  /** The device that issued it, and its Ed25519 key (base64url). */
  device: string;
  key: string;
}

export function grantText(g: Grant): string {
  const { grant, log, space, kind, epoch, agent, name, person, scopes, issued, expires, device, key } = g;
  return `${RELAY_PROTOCOL} grant ` + JSON.stringify({ grant, log, space, kind, epoch, agent, name, person, scopes, issued, expires, device, key });
}

/** What a sealed log entry says inside. Only key holders can read it. */
export interface EntryHeader {
  v: 0;
  space: string;
  kind: string;
  /** `device:<id>` for a device, `grant:<id>` for a cloud session. */
  author: string;
  at: number;
  /** For a device: Ed25519 over the change bytes' SHA-256, by its device key. */
  sig?: string;
  /** The bytes are the whole Space (`save()`), so replay can start here. */
  snapshot?: boolean;
}
