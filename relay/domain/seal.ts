// Device challenge authentication shared by Node and Cloudflare.
import { sha256 } from "@noble/hashes/sha2.js";
const te = new TextEncoder();
export const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
export const unb64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
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
