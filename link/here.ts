// Who is here: live cursors, names and selections in each Space (ARCHITECTURE
// §6, Presence). Short-lived messages on the same sessions as changes, kept in
// memory only and never written into a Space or its history.
//
//   here { device, space, person, name, cursor: [x, y] | null, selection: [id], at }
//   here { device, gone: true }
//
// An iPad reports its own (`presence` with `cursor` and `selection`, in Space
// coordinates). The Link passes each one on to the person's other iPads and web
// viewers, and to the Links of the people the Space is shared with. A member's
// Link passes on only its own person's; the owner's Link, which every member's
// Link meets, also passes each member's on to the others. An entry goes when its
// device leaves the Space, disconnects, or the Link it came through does.
import type { Person } from "./pairing/catalog.ts";

export interface HereEntry {
  device: string;
  space: string;
  person: Person;
  /** The device's name. */
  name: string;
  cursor: [number, number] | null;
  selection: string[];
  at: number;
}

export type HereMessage = HereEntry | { device: string; gone: true };

interface Route {
  /** The peers to tell, other than the one it came from. */
  send(to: string, m: HereMessage): void;
  /** Connected peers that may hear about this Space, and whether each is this person's own. */
  peers(space: string): { device: string; own: boolean; link: boolean }[];
  /** Whether this Link's person owns the Space (the hub for its members). */
  owns(space: string): boolean;
  web(m: HereMessage): void;
}

const MAX_SELECTION = 50;

export class Here {
  #entries = new Map<string, { e: HereEntry; via: string | null }>();
  #route: Route;

  constructor(route: Route) {
    this.#route = route;
  }

  all(): HereEntry[] {
    return [...this.#entries.values()].map((x) => x.e);
  }

  /** From one of this person's iPads. */
  local(device: string, person: Person, name: string, h: Record<string, unknown>): void {
    const space = typeof h.space === "string" && h.space ? h.space.slice(0, 200) : null;
    if (!space) return this.#gone(device);
    const c = h.cursor;
    const cursor = Array.isArray(c) && c.length === 2 && c.every((v) => typeof v === "number" && Number.isFinite(v)) ? ([c[0], c[1]] as [number, number]) : null;
    const selection = (Array.isArray(h.selection) ? h.selection : []).filter((x): x is string => typeof x === "string").slice(0, MAX_SELECTION);
    this.#set({ device, space, person, name, cursor, selection, at: Date.now() }, null);
  }

  /** From a Link peer. `allowed`: whether that peer may speak about this Space, for this person. */
  remote(from: string, h: Record<string, unknown>, allowed: (space: string, person: string) => boolean): void {
    const device = String(h.device ?? "");
    if (!device) return;
    if (h.gone === true) {
      const was = this.#entries.get(device);
      if (was?.via === from) this.#gone(device);
      return;
    }
    const space = String(h.space ?? "");
    const p = h.person as Person | undefined;
    if (!space || typeof p?.id !== "string" || !allowed(space, p.id)) return;
    const was = this.#entries.get(device);
    if (was && was.via !== from) return; // heard first through another path
    const c = h.cursor;
    const cursor = Array.isArray(c) && c.length === 2 && c.every((v) => typeof v === "number" && Number.isFinite(v)) ? ([c[0], c[1]] as [number, number]) : null;
    const selection = (Array.isArray(h.selection) ? h.selection : []).filter((x): x is string => typeof x === "string").slice(0, MAX_SELECTION);
    this.#set({ device, space, person: { id: p.id, name: String(p.name ?? "") }, name: String(h.name ?? ""), cursor, selection, at: Date.now() }, from);
  }

  /** A peer disconnected: it and everything heard through it is gone. */
  dropped(device: string): void {
    for (const [d, x] of [...this.#entries]) if (d === device || x.via === device) this.#gone(d);
  }

  /** Everything known now, for a peer that just connected. */
  replay(to: string): void {
    for (const { e, via } of this.#entries.values()) if (via !== to && e.device !== to && this.#to(e.space, via).has(to)) this.#route.send(to, e);
  }

  #to(space: string, via: string | null): Set<string> {
    const hub = this.#route.owns(space);
    // This person's iPads hear everything; their other Links, what their own iPads report here;
    // other people's Links, what this person's devices report, or everything when this is the owner's Link.
    return new Set(
      this.#route
        .peers(space)
        .filter((p) => p.device !== via && (p.own ? !p.link || via === null : via === null || hub))
        .map((p) => p.device),
    );
  }

  #set(e: HereEntry, via: string | null): void {
    const was = this.#entries.get(e.device);
    if (was && was.e.space !== e.space) this.#gone(e.device);
    this.#entries.set(e.device, { e, via });
    for (const d of this.#to(e.space, via)) if (d !== e.device) this.#route.send(d, e);
    this.#route.web(e);
  }

  #gone(device: string): void {
    const was = this.#entries.get(device);
    if (!was) return;
    this.#entries.delete(device);
    const m = { device, gone: true as const };
    for (const d of this.#to(was.e.space, was.via)) if (d !== device) this.#route.send(d, m);
    this.#route.web(m);
  }
}
