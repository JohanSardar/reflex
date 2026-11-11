// Watch mode (SPEC §9, ARCHITECTURE §7.6): while an Agent has `watch` on for a
// Region, the person's work there reaches it as debounced snapshots of only
// that Region, as Send Bundles with kind "watch".
//
// - Debounced: a snapshot is taken once the person has paused (QUIET), or,
//   while they keep writing, at most MAX after the first unsent stroke, marked
//   `user_still_writing`.
// - Budgets: never two snapshots of one Region closer than MIN_GAP, at most
//   PER_HOUR of them per Region, and at most 1500 strokes and 60 lines each
//   (the kernel caps those). A snapshot is only taken when the Region's Ink
//   changed since the last one.
// - A newer snapshot supersedes an older one the Agent hasn't taken yet, so a
//   slow Agent gets the latest work, not a backlog.
//
// A snapshot claims nothing: the Region's own Send button still carries the
// work when the person is done.
import type { Core } from "../agent/src/capabilities/index.ts";
import type { Bounds } from "../agent/src/store.ts";
import type { Inbox } from "./storage/inbox.ts";
import type { SpaceStore } from "./storage/journal.ts";

const env = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const QUIET_MS = env("REFLEX_WATCH_QUIET_S", 4) * 1000;
const MAX_MS = env("REFLEX_WATCH_MAX_S", 20) * 1000;
const MIN_GAP_MS = env("REFLEX_WATCH_MIN_S", 8) * 1000;
const PER_HOUR = env("REFLEX_WATCH_PER_HOUR", 60);

type State = {
  /** The person's strokes in the Region at the last snapshot, and when the Space last changed. */
  shown: string;
  seen: string;
  /** When the person last changed the Region's Ink, and when the first change not yet shown was. */
  lastChange: number;
  firstPending?: number;
  lastSnapshot: number;
  /** Snapshot times in the last hour. */
  recent: number[];
  timer?: ReturnType<typeof setTimeout>;
  overBudget?: boolean;
};

const inside = (r: Bounds, b: Bounds) => {
  const cx = b[0] + b[2] / 2;
  const cy = b[1] + b[3] / 2;
  return cx >= r[0] && cx <= r[0] + r[2] && cy >= r[1] && cy <= r[1] + r[3];
};

export class Watcher {
  #core: Core;
  #store: SpaceStore;
  #inbox: Inbox;
  #log: (event: string, data?: Record<string, unknown>) => void;
  /** `<space>|<region>` → state. */
  #regions = new Map<string, State>();
  #stopped = false;

  constructor(o: { core: Core; store: SpaceStore; inbox: Inbox; log: (event: string, data?: Record<string, unknown>) => void }) {
    this.#core = o.core;
    this.#store = o.store;
    this.#inbox = o.inbox;
    this.#log = o.log;
  }

  /** The person's strokes in each watched Region of a Space, by the Region's ID as the person sees it. */
  #watched(space: string): Map<string, string> {
    const entry = this.#core.spaces.get(space);
    if (!entry || entry.kind !== "space") return new Map();
    const els = this.#core.scene(entry, { person: this.#core.person.person }, "full");
    const out = new Map<string, string>();
    for (const r of els.filter((e: any) => e.type === "region" && e.watch === true)) {
      const ink = els.filter((e: any) => e.type === "ink" && e.owner?.person === this.#core.person.person && inside(r.bounds, e.bounds));
      out.set(r.id, ink.map((e: any) => e.id).sort().join(","));
    }
    return out;
  }

  /** Something in the Space changed: note the watched Regions whose Ink did. */
  changed(space: string) {
    if (this.#stopped) return;
    const now = Date.now();
    const watched = this.#watched(space);
    for (const [key, st] of this.#regions) {
      const [s, r] = key.split("|");
      if (s === space && !watched.has(r)) {
        clearTimeout(st.timer);
        this.#regions.delete(key); // watch was turned off, or the Region removed
      }
    }
    for (const [region, ink] of watched) {
      const key = `${space}|${region}`;
      let st = this.#regions.get(key);
      if (!st) {
        // Watch just came on: what is there now is the baseline; the next change is news.
        this.#regions.set(key, { shown: ink, seen: ink, lastChange: 0, lastSnapshot: 0, recent: [] });
        continue;
      }
      // Only a change to this Region's Ink counts: an Agent's note or Ink elsewhere is not the person writing here.
      if (ink === st.seen) continue;
      st.seen = ink;
      st.lastChange = now;
      st.firstPending ??= now;
      this.#schedule(space, region, st);
    }
  }

  #schedule(space: string, region: string, st: State) {
    clearTimeout(st.timer);
    if (st.firstPending === undefined) return;
    const at = Math.max(Math.min(st.lastChange + QUIET_MS, st.firstPending + MAX_MS), st.lastSnapshot + MIN_GAP_MS);
    st.timer = setTimeout(() => this.#fire(space, region, st), Math.max(0, at - Date.now()));
    st.timer.unref?.();
  }

  #fire(space: string, region: string, st: State) {
    st.timer = undefined;
    if (this.#stopped) return;
    const ink = this.#watched(space).get(region);
    if (ink === undefined) return;
    const now = Date.now();
    if (ink === st.shown) {
      st.firstPending = undefined; // they erased back to what was last shown
      return;
    }
    st.recent = st.recent.filter((t) => now - t < 3_600_000);
    if (st.recent.length >= PER_HOUR) {
      if (!st.overBudget) this.#log("watch_budget", { space, region, per_hour: PER_HOUR });
      st.overBudget = true;
      st.timer = setTimeout(() => this.#fire(space, region, st), st.recent[0] + 3_600_000 - now);
      st.timer.unref?.();
      return;
    }
    st.overBudget = false;
    const stillWriting = now - st.lastChange < QUIET_MS;
    let send: string;
    try {
      send = this.#core.watchSnapshot(space, region, { stillWriting }).send;
    } catch (e) {
      this.#log("watch_failed", { space, region, error: String((e as Error).message ?? e) });
      return;
    }
    st.shown = ink;
    st.firstPending = undefined;
    st.lastSnapshot = now;
    st.recent.push(now);
    this.#supersede(space, send);
    this.#log("watch_snapshot", { space, region, send, user_still_writing: stillWriting, strokes: ink ? ink.split(",").length : 0 });
  }

  /** Older snapshots of this Region that an Agent hasn't taken yet are replaced by the new one. */
  #supersede(space: string, latest: string) {
    const regionOf = (send: string) =>
      this.#store.read(space, (s) => {
        const f = JSON.parse(s.send(send));
        return f?.kind === "watch" ? String(f.region ?? "") : undefined;
      });
    const key = regionOf(latest);
    for (const r of this.#inbox.recipients(space, latest))
      for (const e of this.#inbox.pending(r, space))
        if (e.send !== latest && regionOf(e.send) === key) this.#inbox.mark(space, e.send, r, "acknowledged", "superseded");
  }

  stop() {
    this.#stopped = true;
    for (const st of this.#regions.values()) clearTimeout(st.timer);
  }
}
