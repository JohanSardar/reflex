// The Link's side of shared Spaces (link/sharing.ts has the records and the
// rules): invites, joining with one, role changes and removals, handing the
// share record and the Space key to the Links that should have them, and the
// Relay rooms where this Link meets other people's Links.
//
//   share   { share, sig, key? }   the owner's signed membership record; `key` is the
//                                  Space key for its epoch, only to a member's Link or
//                                  the owner's own other Links, inside the end-to-end session
//
// Where Links of different people meet on the Relay: a member's Link joins the
// owner's room (`roomFor(owner)`) and accepts frames only from the owner's Link;
// the owner's Link watches its members' Links in its own room. An invite is
// presented in the invite's own room (`inviteRoom`), where the owner's Link
// accepts anyone while the invite is live: only the invite's holders can name
// that room, and the handshake checks they know its secret.
import type { Catalog, PairedDevice, Person } from "./pairing/catalog.ts";
import { b64, type DeviceKey } from "./pairing/crypto.ts";
import type { PeerInfo } from "./pairing/handshake.ts";
import type { RelaySync } from "./relay/sync.ts";
import { inviteRoom, Invites, parseInvite, roleIn, type Invite, type Shares, type SignedShare } from "./sharing.ts";
import type { SpaceStore } from "./storage/journal.ts";
import type { Coordinator, Peer } from "./sync/coordinator.ts";
import { RelayTransport, roomFor } from "./transports/relay.ts";

export interface ShareSummary {
  space: string;
  owner: Person;
  /** This person's role. */
  role: "owner" | "editor" | "viewer" | null;
  members: { person: Person; role: "editor" | "viewer" }[];
  epoch: number;
}

export class SharedSpaces {
  readonly invites = new Invites();
  #shares: Shares;
  #store: SpaceStore;
  #catalog: Catalog;
  #coord: Coordinator;
  #relay: RelaySync | null;
  #relayUrl: string | null;
  #me: () => { person: Person; key: DeviceKey; name: string };
  #lan: () => number | undefined;
  #log: (m: string) => void;
  /** Relay rooms of other people whose Spaces this Link is in, by owner. */
  #rooms = new Map<string, RelayTransport>();
  /** The owner's side of each live invite's Relay room. */
  #inviteRooms = new Map<string, RelayTransport>();
  /** Someone's role in a Space changed, or who is in it: tell the iPads, rename in Bundles. */
  onChanged: () => void = () => {};

  constructor(o: {
    shares: Shares;
    store: SpaceStore;
    catalog: Catalog;
    coord: Coordinator;
    relay: RelaySync | null;
    relayUrl: string | null;
    me: () => { person: Person; key: DeviceKey; name: string };
    lanPort: () => number | undefined;
    log: (m: string) => void;
  }) {
    this.#shares = o.shares;
    this.#store = o.store;
    this.#catalog = o.catalog;
    this.#coord = o.coord;
    this.#relay = o.relay;
    this.#relayUrl = o.relayUrl;
    this.#me = o.me;
    this.#lan = o.lanPort;
    this.#log = o.log;
    o.coord.inviteSecret = (id) => this.invites.get(id)?.secret;
    o.coord.onInvited = (peer, id) => this.#admit(peer, id);
  }

  /** Joins the Relay rooms of every owner whose Space this Link is in. */
  start(): void {
    const me = this.#me().person.id;
    for (const r of this.#shares.all()) if (roleIn(r.share, me)) this.#room(r.share.owner, r.share.relay);
  }

  async stop(): Promise<void> {
    for (const t of [...this.#rooms.values(), ...this.#inviteRooms.values()]) await t.close();
  }

  summary(): ShareSummary[] {
    const me = this.#me().person.id;
    return this.#shares.all().map(({ share: s }) => ({
      space: s.space,
      owner: s.owner,
      role: roleIn(s, me),
      members: s.members.map((m) => ({ person: m.person, role: m.role })),
      epoch: s.epoch,
    }));
  }

  /** Every person in a shared Space, for names in Send Bundles and on screens. */
  people(): Person[] {
    return this.#shares.all().flatMap(({ share: s }) => [s.owner, ...s.members.map((m) => m.person)]);
  }

  // ---------- the owner's side ----------

  /** A new single-use invite to one of this person's Spaces. Only the person can ask for one (the terminal, or their iPad). */
  invite(space: string, role: "editor" | "viewer"): Invite {
    if (!this.#store.has(space) || this.#store.kind(space) !== "space") throw new Error(`No Space '${space}' to share.`);
    if (!this.#shares.owns(space)) throw new Error(`Only ${this.#shares.get(space)!.owner.name} can invite people to '${space}'.`);
    const me = this.#me();
    const inv = this.invites.create({ space, role, device: me.key.device, key: b64(me.key.publicRaw), owner: me.person, port: this.#lan(), relay: this.#relayUrl });
    if (this.#relayUrl) void this.#openInviteRoom(inv);
    this.#log(`invite ${inv.invite} to '${space}' as ${role} (single use, 24 hours)`);
    return inv;
  }

  async #openInviteRoom(inv: Invite): Promise<void> {
    const t = new RelayTransport({ url: this.#relayUrl!, key: this.#me().key, room: () => inviteRoom(inv.secret), watch: () => ["*"], log: this.#log, name: `invite:${inv.invite}` });
    this.#inviteRooms.set(inv.invite, t);
    await this.#coord.addTransport(t);
    // Closed once used, or when it expires.
    const t2 = setTimeout(() => void this.#closeInviteRoom(inv.invite), Math.max(0, inv.expires - Date.now()));
    t2.unref();
  }

  async #closeInviteRoom(id: string): Promise<void> {
    const t = this.#inviteRooms.get(id);
    if (!t) return;
    this.#inviteRooms.delete(id);
    await this.#coord.removeTransport(t);
  }

  /** Someone proved they hold a live invite: they become a member, and their Link gets the record and key once bound. */
  #admit(peer: PeerInfo, id: string): void {
    const inv = this.invites.get(id);
    if (!inv) throw new Error("unknown, used or expired invite");
    const me = this.#me().person;
    if (peer.person.id === me.id) throw new Error("that device is already this person's; pair it instead of inviting it");
    if (peer.kind !== "link") throw new Error("an invite is presented by the invited person's Link; join from the iPad paired with it");
    this.invites.consume(id);
    // Its room closes after this session moves to the owner's room, so the session isn't cut short.
    const t = setTimeout(() => void this.#closeInviteRoom(id), 60_000);
    t.unref();
    this.#coord.rememberGuest(peer);
    const signed = this.#shares.add(inv.space, this.#store.kind(inv.space), { person: peer.person, role: inv.role, device: peer.device, key: peer.key, since: Date.now() }, this.#relayUrl);
    this.#log(`${peer.person.name} (${peer.person.id}) joined '${inv.space}' as ${inv.role}, from ${peer.name} (${peer.device})`);
    this.#changed(signed);
  }

  setRole(space: string, person: string, role: "editor" | "viewer"): ShareSummary {
    const signed = this.#shares.setRole(space, person, role);
    this.#log(`${signed.share.members.find((m) => m.person.id === person)!.person.name} is now ${role === "editor" ? "an editor" : "a viewer"} in '${space}'`);
    this.#changed(signed);
    return this.summary().find((s) => s.space === space)!;
  }

  /** Removes someone: recorded, the Space moves to a new key, and their devices stop getting it. */
  remove(space: string, person: string): ShareSummary {
    const { signed, member } = this.#shares.remove(space, person);
    this.#log(`removed ${member.person.name} (${member.person.id}) from '${space}'`);
    this.#relay?.rotate(space);
    // They learn they were removed (the record without them), and nothing else.
    const p = this.#coord.peers().find((x) => x.device === member.device);
    if (p) this.#coord.send(p, { t: "share", share: signed.share, sig: signed.sig });
    this.#changed(signed);
    if (!this.#shares.spacesWith(member.device).length) setTimeout(() => this.#coord.forgetGuest(member.device), 500).unref();
    return this.summary().find((s) => s.space === space)!;
  }

  /** The record changed here: send it on, and re-check what syncs with whom. */
  #changed(signed: SignedShare): void {
    for (const p of this.#coord.peers()) this.#sendShare(p, signed);
    this.#coord.refresh();
    this.onChanged();
  }

  #sendShare(p: Peer, r: SignedShare): void {
    const d = this.#catalog.device(p.device);
    if (!d || d.kind !== "link") return;
    const me = this.#me().person.id;
    const s = r.share;
    const own = d.person.id === me;
    // To this person's other Links, every record; to someone else's, only those of Spaces this person owns that they are in.
    if (!own && !(s.owner.id === me && s.members.some((m) => m.device === d.device))) return;
    const key = this.#relay?.keyOf(s.space);
    this.#coord.send(p, { t: "share", share: s, sig: r.sig, ...(key ? { key } : {}) });
  }

  /** A Link connected: hand it the records it should have. */
  bound(p: Peer): void {
    for (const r of this.#shares.all()) this.#sendShare(p, r);
  }

  // ---------- everyone else's side ----------

  /** A share record from a Link. Returns whether it was one. */
  message(p: Peer, h: Record<string, unknown>): boolean {
    if (h.t !== "share") return false;
    const d = this.#catalog.device(p.device);
    if (!d || d.kind !== "link") return true;
    const r = { share: h.share, sig: h.sig } as SignedShare;
    const res = this.#shares.accept(r, d);
    if (!res.ok) {
      this.#log(`ignored a share record from ${p.name}: ${res.why}`);
      return true;
    }
    const s = r.share;
    const me = this.#me().person;
    const role = roleIn(s, me.id);
    // The key comes with every record, even one this Link already has (it may have missed the key).
    if (role && typeof h.key === "string") this.#relay?.setKey(s.space, h.key, s.owner.id === me.id ? p.name : `${s.owner.name}'s Link`);
    if (!res.changed) return true;
    if (!role) {
      this.#log(`${s.owner.name} removed this person from '${s.space}'. The copy here stays, and gets nothing new.`);
      this.#relay?.dropKey(s.space);
      if (!this.#shares.spacesWith(s.device).length) this.#coord.forgetGuest(s.device);
    } else {
      if (!this.#store.has(s.space)) {
        this.#store.ensure(s.space, s.kind);
        this.#log(`now holding '${s.space}', shared by ${s.owner.name}`);
      }
      this.#log(`'${s.space}' (${s.owner.name}'s): this person is ${role === "owner" ? "the owner" : `${role === "editor" ? "an editor" : "a viewer"}`}; ${s.members.length} ${s.members.length === 1 ? "member" : "members"}, key epoch ${s.epoch}`);
      if (s.owner.id !== me.id) this.#room(s.owner, s.relay);
    }
    this.#coord.refresh();
    this.onChanged();
    return true;
  }

  /** Joins the owner's Relay room, accepting frames only from the owner's Links of Spaces this Link is in. */
  #room(owner: Person, relay: string | null | undefined): void {
    if (owner.id === this.#me().person.id || !relay || this.#rooms.has(owner.id)) return;
    const t = new RelayTransport({
      url: relay,
      key: this.#me().key,
      room: () => roomFor(owner.id),
      watch: () => this.#shares.all().filter((r) => r.share.owner.id === owner.id && roleIn(r.share, this.#me().person.id)).map((r) => r.share.device),
      log: this.#log,
      name: `relay:${owner.id}`,
    });
    this.#rooms.set(owner.id, t);
    void this.#coord.addTransport(t);
  }

  /** Joins a Space with an invite: this Link presents it to the owner's Link, which records the membership. */
  async join(uri: string): Promise<{ space: string; role: string; owner: Person }> {
    const inv = parseInvite(uri);
    const me = this.#me();
    if (inv.owner.id === me.person.id) throw new Error(`'${inv.space}' is already this person's: an invite is for someone else.`);
    if (this.#store.has(inv.space) && !this.#shares.get(inv.space)) throw new Error(`This Link already has a Space named '${inv.space}' of its own.`);
    let t: RelayTransport | undefined;
    const relay = inv.relay
      ? async () => {
          t = new RelayTransport({ url: inv.relay!, key: me.key, room: () => inviteRoom(inv.secret), watch: () => [inv.device], log: this.#log, name: `invite:${inv.invite}` });
          await t.listen(() => {});
          // Wait for the owner's Link to show up in the room.
          for (let i = 0; i < 40; i++) {
            try {
              return await t.dial({ transport: t.name, device: inv.device, host: inv.relay!, port: 0 });
            } catch {
              await new Promise((r) => setTimeout(r, 250));
            }
          }
          throw new Error("the owner's Link is not on the Relay");
        }
      : undefined;
    try {
      await this.#coord.presentInvite({ ...inv, name: inv.owner.name || "the owner" }, relay);
    } catch (e) {
      await t?.close();
      throw e;
    }
    // The record and the key follow on the same session.
    for (let i = 0; i < 80; i++) {
      const s = this.#shares.get(inv.space);
      if (s && roleIn(s, me.person.id)) {
        // The invite's room was only for meeting; from now on the owner's room carries it.
        if (t) setTimeout(() => void t!.close(), 30_000).unref();
        return { space: inv.space, role: roleIn(s, me.person.id)!, owner: s.owner };
      }
      await new Promise((r) => setTimeout(r, 125));
    }
    await t?.close();
    throw new Error(`${inv.owner.name}'s Link took the invite but sent no membership for '${inv.space}'.`);
  }

  /** A device by ID for a Space: a paired one, or another member's Link there (whose log entries this Link checks). */
  device(id: string, space: string): PairedDevice | undefined {
    const d = this.#catalog.device(id);
    if (d) return d;
    const s = this.#shares.get(space);
    const m = s?.members.find((x) => x.device === id);
    return m && { device: m.device, key: m.key, name: m.person.name, person: m.person, kind: "link", via: "invite", paired_at: m.since };
  }
}
