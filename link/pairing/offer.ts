// Pairing offers: what the QR code carries.
//
//   reflex://pair?v=0&o=<offer>&d=<device>&k=<key>&s=<secret>&h=<host,host>&p=<port>&n=<name>&pi=<person>&pn=<person name>
//
// The person tells a new device whose device it becomes (ADR-0008).
//
// The secret is single-use and expires after ten minutes. Only someone who saw
// the code knows it, and the device key in it lets the scanner check it
// reached the right device, not whoever answered on that address.
import { randomBytes, randomInt } from "node:crypto";
import { networkInterfaces } from "node:os";
import { b64, unb64 } from "./crypto.ts";
import type { ScannedOffer } from "./handshake.ts";
import type { Person } from "./catalog.ts";

const TTL_MS = 10 * 60 * 1000;
/** Wrong tries before a typed code stops working: 5 in a million for someone guessing. */
const CODE_TRIES = 5;

/**
 * The typed code: 6 digits the person reads off their agent and types on the iPad. One is live at a time; an
 * Agent that asks while one is live gets the same code, and typing it approves every Agent that asked for it.
 */
export interface Code {
  code: string;
  expires: number;
  agents: Set<string>;
  fails: number;
}

export interface Offer {
  offer: string;
  secret: Buffer;
  expires: number;
  uri: string;
  /** Where the code was shown: in the Link's own terminal (the person is there), or made by an admin call (`reflex pair`). */
  source: "terminal" | "admin";
}

export interface ParsedOffer extends ScannedOffer {
  hosts: string[];
  port: number;
  name: string;
  person: Person;
}

/**
 * The addresses an iPad can reach this machine at, for a pairing code: home and office networks first,
 * VPN and carrier-grade NAT addresses (Tailscale's 100.64.0.0/10) last, since an iPad off the VPN waits
 * for each to time out. Loopback and link-local are left out: an iPad dialing 127.0.0.1 reaches itself.
 * Only a machine with no network at all lists 127.0.0.1 (for the Simulator on the same Mac).
 */
export function lanAddresses(): string[] {
  const rank = (ip: string): number => {
    const [a, b] = ip.split(".").map(Number);
    if (a === 192 && b === 168) return 0;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31)) return 1;
    if (a === 100 && b >= 64 && b <= 127) return 3;
    return 2;
  };
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (!a.internal && a.family === "IPv4" && !a.address.startsWith("169.254.") && !out.includes(a.address)) out.push(a.address);
  out.sort((x, y) => rank(x) - rank(y));
  return out.length ? out : ["127.0.0.1"];
}

export class Offers {
  #live = new Map<string, Offer>();
  #code: Code | null = null;
  /** The device that used the last typed code, and which Agents it approved. */
  lastCode: { code: string; device: string; agents: string[] } | null = null;

  /**
   * The live typed code, with this Agent added to the ones it approves; a new one if none is live, or if this Agent
   * (or, with no Agent, a terminal) asks again: after a failed typing the person is told to ask for a new code, and a
   * new one makes any digit a look-alike Link learned useless. The Agents waiting on the old code carry over.
   */
  code(agent?: string, now = Date.now()): Code {
    const again = this.liveCode(now) !== undefined && (agent ? this.#code!.agents.has(agent) : true);
    if (!this.liveCode(now) || again)
      this.#code = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expires: now + TTL_MS, agents: new Set(again ? this.#code!.agents : []), fails: 0 };
    if (agent) this.#code!.agents.add(agent);
    return this.#code!;
  }

  liveCode(now = Date.now()): string | undefined {
    const c = this.#code;
    if (!c) return undefined;
    if (c.expires < now || c.fails >= CODE_TRIES) {
      this.#code = null;
      return undefined;
    }
    return c.code;
  }

  /** Whether this Agent waits on the live code. */
  codeFor(agent: string): Code | undefined {
    return this.liveCode() && this.#code!.agents.has(agent) ? this.#code! : undefined;
  }

  codeFailed(): void {
    if (this.#code) this.#code.fails++;
  }

  /** Uses up the typed code if it is still the live one; returns the Agents it approves, or undefined. */
  takeCode(code: string, device: string): string[] | undefined {
    if (this.liveCode() !== code) return undefined;
    const c = this.#code!;
    this.#code = null;
    this.lastCode = { code: c.code, device, agents: [...c.agents] };
    return [...c.agents];
  }
  /** Codes used up, and by which device: `reflex pair` waits on this, so an iPad that was paired already and scans again counts. */
  #used = new Map<string, string>();

  create(me: { device: string; key: string; name: string; person: Person }, port: number, source: Offer["source"] = "terminal", now = Date.now()): Offer {
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
    const o: Offer = { offer, secret, expires: now + TTL_MS, uri: `reflex://pair?${q}`, source };
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

  /** Where a live (or just consumed) offer's code was shown. */
  source(offer: string): Offer["source"] | undefined {
    return this.#live.get(offer)?.source;
  }

  /** An offer is used up once a device pairs with it. */
  consume(offer: string, device?: string): void {
    if (this.#live.delete(offer) && device) this.#used.set(offer, device);
  }

  /** The device that used this code, if one did. */
  usedBy(offer: string): string | undefined {
    return this.#used.get(offer);
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
