// Device forwarding wire, reflex-relay/v0. /v0/connect?room=<32 hex>.
export const RELAY_PROTOCOL = "reflex-relay/v0";
export const MAX_FRAME = 4 * 1024 * 1024;
export const OPENER = 0x8000_0000;

export const ROOM_ID = /^[0-9a-f]{32}$/;
export const DEVICE_ID = /^dev-[0-9a-f]{16}$/;

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

