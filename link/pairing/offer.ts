// Pairing offers: what the QR code carries.
//
//   reflex://pair?v=0&o=<offer>&d=<device>&k=<key>&s=<secret>&h=<host,host>&p=<port>&n=<name>&pi=<person>&pn=<person name>
//
// The person tells a new device whose device it becomes (ADR-0008).
//
// The secret is single-use and expires after ten minutes. Only someone who saw
// the code knows it, and the device key in it lets the scanner check it
// reached the right device, not whoever answered on that address.
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import { b64, unb64 } from "./crypto.ts";
import type { ScannedOffer } from "./handshake.ts";
import type { Person } from "./catalog.ts";

const TTL_MS = 10 * 60 * 1000;

export interface Offer {
  offer: string;
  secret: Buffer;
  expires: number;
  uri: string;
}

export interface ParsedOffer extends ScannedOffer {
  hosts: string[];
  port: number;
  name: string;
  person: Person;
}

/** This machine's LAN addresses, IPv4 first, loopback last. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (!a.internal && a.family === "IPv4") out.push(a.address);
  out.push("127.0.0.1");
  return out;
}

export class Offers {
  #live = new Map<string, Offer>();

  create(me: { device: string; key: string; name: string; person: Person }, port: number, now = Date.now()): Offer {
    const offer = "o_" + randomBytes(6).toString("hex");
    const secret = randomBytes(32);
    const q = new URLSearchParams({
      v: "0",
      o: offer,
      d: me.device,
      k: me.key,
      s: b64(secret),
      h: lanAddresses().join(","),
      p: String(port),
      n: me.name,
      pi: me.person.id,
      pn: me.person.name,
    });
    const o = { offer, secret, expires: now + TTL_MS, uri: `reflex://pair?${q}` };
    this.#live.set(offer, o);
    return o;
  }

  /** The secret of a live offer. */
  secret(offer: string, now = Date.now()): Buffer | undefined {
    const o = this.#live.get(offer);
    if (!o) return undefined;
    if (o.expires < now) {
      this.#live.delete(offer);
      return undefined;
    }
    return o.secret;
  }

  /** An offer is used up once a device pairs with it. */
  consume(offer: string): void {
    this.#live.delete(offer);
  }

  remaining(offer: string, now = Date.now()): number {
    return Math.max(0, (this.#live.get(offer)?.expires ?? now) - now);
  }

  live(offer: string): boolean {
    return this.secret(offer) !== undefined;
  }
}

export function parseOffer(uri: string): ParsedOffer {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    throw new Error("That is not a pairing code. It starts with reflex://pair?");
  }
  if (u.protocol !== "reflex:" || u.host !== "pair") throw new Error("That is not a pairing code. It starts with reflex://pair?");
  const g = (k: string): string => {
    const v = u.searchParams.get(k);
    if (!v) throw new Error(`The pairing code is missing '${k}'. Copy the whole code.`);
    return v;
  };
  if (g("v") !== "0") throw new Error(`Pairing code version ${g("v")} is not supported.`);
  // The person comes last in the code, so a code cut short shows here: a damaged ID, or no name after it.
  if (!/^p_[0-9a-f]{12}$/.test(g("pi")) || u.searchParams.get("pn") === null) throw new Error("The pairing code is cut short. Copy the whole code.");
  return {
    offer: g("o"),
    device: g("d"),
    key: g("k"),
    secret: unb64(g("s")),
    hosts: g("h").split(","),
    port: Number(g("p")),
    name: u.searchParams.get("n") ?? "",
    person: { id: g("pi"), name: u.searchParams.get("pn") ?? "" },
  };
}

export function qrText(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: "terminal", small: true, errorCorrectionLevel: "M" });
}
