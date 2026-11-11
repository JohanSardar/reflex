// Shared Spaces: several people on one Space, each from their own devices
// (ADR-0008, ARCHITECTURE §6 Identity, §7.2, §8.3).
//
// A Space's owner is the person whose Link made it, or who holds it without
// having joined it. They invite people as editors or viewers:
//
//   reflex://invite?v=0&i=<invite>&s=<secret>&sp=<space>&r=<role>&d=<device>&k=<key>
//                  &h=<host,host>&p=<port>&u=<relay>&pi=<owner>&pn=<owner name>
//
// The invited person's Link presents it to the owner's Link (the device in it),
// over the LAN or through the Relay in the invite's own room, whose name only
// the invite's holders know (`inviteRoom`). The handshake proves the device
// knows the secret, like a pairing code; the owner's Link then records the
// membership and hands that Link the Space key, inside the end-to-end session,
// so the Relay only ever carries it sealed.
//
// The membership is a share record the owner's Link signs: the owner, every
// member with their role and Link, a revision and the key epoch. It goes to
// every member's Link and the owner's other Links, which keep the newest one
// signed by the same owner key. Roles are checked on every received change,
// against the receiver's newest record (`writers`):
//
//   the owner's Links  anything: they decide who is in, and pass on only what
//                   they accepted (a member's own earlier strokes, too, after
//                   they became a viewer)
//   owner, editor   their iPads write as their person; a member's Link, as its
//                   person, other editors and Agents (changes aren't signed one
//                   by one, so a member's Link is trusted to pass them on)
//   viewer          nothing
//   not a member    nothing, and the Space isn't synced with them (`allowed`)
//
// A role is checked against the receiver's newest record, not the writer's
// frontier: a stroke an editor made offline and synced after becoming a viewer
// is refused.
//
// Removing someone records it and moves the Space to a new key (a new epoch,
// so a new encrypted log on the Relay); their devices never get it.
import { createHash, randomBytes } from "node:crypto";
import type { Catalog, PairedDevice, Person } from "./pairing/catalog.ts";
import { b64, PROTOCOL, signWith, unb64, verifyFrom, type DeviceKey } from "./pairing/crypto.ts";
import { lanAddresses } from "./pairing/offer.ts";
import { RELAY_PROTOCOL } from "./transports/relay.ts";

export type Role = "owner" | "editor" | "viewer";
export const ROLES = ["editor", "viewer"] as const;

export interface Member {
  person: Person;
  role: "editor" | "viewer";
  /** The member's Link, which met the owner's Link through the invite. */
  device: string;
  key: string;
  since: number;
}

export interface Share {
  v: 0;
  space: string;
  kind: string;
  owner: Person;
  /** The owner's Link that signs this record, and its key. */
  device: string;
  key: string;
  members: Member[];
  removed: { person: Person; at: number }[];
  rev: number;
  /** The Space key's epoch: it goes up each time someone is removed. */
  epoch: number;
  /** The Relay where the owner's Link meets its members' Links, if it uses one. */
  relay: string | null;
  at: number;
}

export interface SignedShare {
  share: Share;
  sig: string;
}

const text = (s: Share): string => `${PROTOCOL} share ${JSON.stringify(s)}`;
const NONE = JSON.stringify({ people: [], agents: [] });

export function roleIn(s: Share, person: string): Role | null {
  if (s.owner.id === person) return "owner";
  return s.members.find((m) => m.person.id === person)?.role ?? null;
}

const editors = (s: Share): string[] => [s.owner.id, ...s.members.filter((m) => m.role === "editor").map((m) => m.person.id)];

/** The signed membership of every shared Space this Link holds, in the control catalog. */
export class Shares {
  #catalog: Catalog;
  #me: () => { person: Person; key: DeviceKey };

  constructor(catalog: Catalog, me: () => { person: Person; key: DeviceKey }) {
    this.#catalog = catalog;
    this.#me = me;
  }

  all(): SignedShare[] {
    return this.#catalog.records<SignedShare>("share").filter((r) => verifyFrom(unb64(r.share.key), text(r.share), r.sig));
  }

  get(space: string): Share | undefined {
    return this.all().find((r) => r.share.space === space)?.share;
  }

  signed(space: string): SignedShare | undefined {
    return this.all().find((r) => r.share.space === space);
  }

  /** Whether this Link's person owns a Space it holds: nobody shared it with them. */
  owns(space: string): boolean {
    const s = this.get(space);
    return !s || s.owner.id === this.#me().person.id;
  }

  /** This person's role in a Space; owner for a Space nobody shared with them. */
  myRole(space: string): Role | null {
    const s = this.get(space);
    return s ? roleIn(s, this.#me().person.id) : "owner";
  }

  // ---------- the owner's side ----------

  #sign(s: Share): SignedShare {
    const me = this.#me();
    const share: Share = { ...s, device: me.key.device, key: b64(me.key.publicRaw), at: Date.now() };
    const signed = { share, sig: signWith(me.key, text(share)) };
    this.#catalog.putRecord("share", share.space, signed);
    return signed;
  }

  #mine(space: string, kind: string): Share {
    const s = this.get(space);
    const me = this.#me();
    if (s && s.owner.id !== me.person.id) throw new Error(`Only ${s.owner.name} can change who is in '${space}'.`);
    return s ?? { v: 0, space, kind, owner: me.person, device: me.key.device, key: b64(me.key.publicRaw), members: [], removed: [], rev: 0, epoch: 0, relay: null, at: 0 };
  }

  /** Adds someone who presented a live invite. */
  add(space: string, kind: string, m: Member, relay: string | null): SignedShare {
    const s = this.#mine(space, kind);
    const members = [...s.members.filter((x) => x.person.id !== m.person.id), m];
    return this.#sign({ ...s, members, rev: s.rev + 1, relay });
  }

  setRole(space: string, person: string, role: "editor" | "viewer"): SignedShare {
    const s = this.#mine(space, "space");
    if (!s.members.some((m) => m.person.id === person)) throw new Error(`${person} is not in '${space}'.`);
    return this.#sign({ ...s, members: s.members.map((m) => (m.person.id === person ? { ...m, role } : m)), rev: s.rev + 1 });
  }

  /** Removes someone: recorded, and the Space moves to a new key epoch. */
  remove(space: string, person: string): { signed: SignedShare; member: Member } {
    const s = this.#mine(space, "space");
    const member = s.members.find((m) => m.person.id === person);
    if (!member) throw new Error(`${person} is not in '${space}'.`);
    const signed = this.#sign({
      ...s,
      members: s.members.filter((m) => m.person.id !== person),
      removed: [...s.removed, { person: member.person, at: Date.now() }].slice(-100),
      rev: s.rev + 1,
      epoch: s.epoch + 1,
    });
    return { signed, member };
  }

  // ---------- everyone else's side ----------

  /**
   * A share record from a peer. Kept only if it is signed by the key that signed the one already
   * here (or, the first time, by the owner's Link this Link reached), and is newer.
   */
  accept(r: SignedShare, from: PairedDevice): { ok: boolean; why?: string; changed?: boolean } {
    const s = r?.share;
    if (!s || typeof s.space !== "string" || !Array.isArray(s.members) || typeof r.sig !== "string") return { ok: false, why: "malformed" };
    if (!verifyFrom(unb64(s.key), text(s), r.sig)) return { ok: false, why: "its signature does not verify" };
    const have = this.signed(s.space);
    if (have) {
      if (have.share.key !== s.key) return { ok: false, why: `it is not signed by ${have.share.owner.name}'s Link` };
      if (s.rev <= have.share.rev) return { ok: true, changed: false };
    } else if (s.owner.id === this.#me().person.id) {
      // One of this person's own Spaces, from another of their Links: that Link signs as the owner.
      if (from.person.id !== s.owner.id) return { ok: false, why: "it claims this person owns it" };
    } else if (from.device !== s.device || from.key !== s.key) {
      return { ok: false, why: "it does not come from the owner's Link" };
    }
    this.#catalog.putRecord("share", s.space, r);
    return { ok: true, changed: true };
  }

  // ---------- checks ----------

  /** Who a device's changes to a Space may be written for (the kernel's `Writers`). */
  writers(d: PairedDevice | undefined, space: string): string {
    if (!d) return NONE;
    const s = this.get(space);
    const me = this.#me().person.id;
    if (!s) {
      if (d.person.id !== me) return NONE;
      return JSON.stringify(d.kind === "ipad" ? { people: [d.person.id] } : { people: [d.person.id], agents: "*" });
    }
    const role = roleIn(s, d.person.id);
    if (role !== "owner" && role !== "editor") return NONE;
    if (d.kind === "ipad") return JSON.stringify({ people: [d.person.id] });
    if (role === "owner") return JSON.stringify({ any: true });
    return JSON.stringify({ people: editors(s), agents: "*" });
  }

  /** Whether a Space syncs with a device at all. */
  allowed(d: PairedDevice | undefined, space: string): boolean {
    if (!d) return false;
    const me = this.#me().person.id;
    if (d.person.id === me) return true;
    const s = this.get(space);
    if (!s || !roleIn(s, d.person.id)) return false;
    // Members sync with the owner's Link, and the owner's Link with every member.
    return s.owner.id === me || d.device === s.device;
  }

  /** The shared Spaces another person's Link is in with this one: as a member of this person's, or as the owner of one this person is still in. */
  spacesWith(device: string): string[] {
    const me = this.#me().person.id;
    return this.all()
      .map((r) => r.share)
      .filter((s) => s.members.some((m) => m.device === device) || (s.device === device && roleIn(s, me) !== null))
      .map((s) => s.space);
  }
}

// ---------- invites ----------

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const PERSON_ID = /^p_[0-9a-f]{12}$/;

export interface Invite {
  invite: string;
  space: string;
  role: "editor" | "viewer";
  secret: Buffer;
  expires: number;
  uri: string;
}

export interface ParsedInvite {
  invite: string;
  secret: Buffer;
  space: string;
  role: "editor" | "viewer";
  device: string;
  key: string;
  hosts: string[];
  port: number;
  owner: Person;
  relay: string | null;
}

/** The Relay room where an invite is presented: only those who hold the invite can name it. */
export const inviteRoom = (secret: Uint8Array): string =>
  createHash("sha256").update(`${RELAY_PROTOCOL} invite room `).update(secret).digest("hex").slice(0, 32);

/** Live invites, in memory only: a restart ends them, like pairing codes. Each is single-use. */
export class Invites {
  #live = new Map<string, Invite>();
  onChange: () => void = () => {};

  create(o: { space: string; role: "editor" | "viewer"; device: string; key: string; owner: Person; port: number | undefined; relay: string | null }, now = Date.now()): Invite {
    const invite = "i_" + randomBytes(6).toString("hex");
    const secret = randomBytes(32);
    const q = new URLSearchParams({
      v: "0",
      i: invite,
      s: b64(secret),
      sp: o.space,
      r: o.role,
      d: o.device,
      k: o.key,
      h: o.port === undefined ? "" : lanAddresses().join(","),
      p: String(o.port ?? 0),
      ...(o.relay ? { u: o.relay } : {}),
      // Last, so an invite cut short is caught by the person ID check.
      pi: o.owner.id,
      pn: o.owner.name,
    });
    const inv = { invite, space: o.space, role: o.role, secret, expires: now + INVITE_TTL_MS, uri: `reflex://invite?${q}` };
    this.#live.set(invite, inv);
    this.onChange();
    return inv;
  }

  live(now = Date.now()): Invite[] {
    for (const [id, i] of this.#live) if (i.expires < now) this.#live.delete(id);
    return [...this.#live.values()];
  }

  get(id: string): Invite | undefined {
    return this.live().find((i) => i.invite === id);
  }

  consume(id: string): void {
    if (this.#live.delete(id)) this.onChange();
  }
}

export function parseInvite(uri: string): ParsedInvite {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    throw new Error("That is not an invite. It starts with reflex://invite?");
  }
  if (u.protocol !== "reflex:" || u.host !== "invite") throw new Error("That is not an invite. It starts with reflex://invite?");
  const g = (k: string, allowEmpty = false): string => {
    const v = u.searchParams.get(k);
    if (v === null || (!v && !allowEmpty)) throw new Error(`The invite is missing '${k}'. Copy the whole invite.`);
    return v;
  };
  if (g("v") !== "0") throw new Error(`Invite version ${g("v")} is not supported.`);
  const secret = unb64(g("s"));
  if (secret.length !== 32) throw new Error("The invite's secret is damaged. Copy the whole invite.");
  const role = g("r");
  if (role !== "editor" && role !== "viewer") throw new Error(`The invite's role '${role}' is not editor or viewer.`);
  const owner = { id: g("pi"), name: g("pn", true) };
  if (!PERSON_ID.test(owner.id)) throw new Error("The invite's person is damaged. Copy the whole invite.");
  const relay = u.searchParams.get("u");
  const hosts = g("h", true).split(",").filter(Boolean);
  if (!hosts.length && !relay) throw new Error("The invite names no way to reach its Link.");
  return { invite: g("i"), secret, space: g("sp"), role, device: g("d"), key: g("k"), hosts, port: Number(g("p")), owner, relay };
}
