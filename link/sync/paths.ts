// Fastest-path selection with hysteresis (ARCHITECTURE §6). A peer can be
// reached over several live paths at once (LAN, peer-to-peer); every path
// stays open and anything that arrives on any of them is taken, but each side
// sends over one, the active path. The iPad runs the same rule
// (apps/ipad/Packages/ReflexLink/Sources/ReflexLink/Paths.swift).
//
//   score     = RTT (ms, smoothed) + 1 ms per KiB waiting in the path's queue
//   switch    when another path's score has been under SWITCH_RATIO × the
//             active one's, and at least MIN_GAIN_MS lower, for HOLD_MS straight
//   fail over at once when the active path closes or goes silent
//
// A path with no RTT yet never takes over from one that has one, so a new
// path proves itself first.
import type { Session } from "../pairing/handshake.ts";

export const SWITCH_RATIO = 0.75;
export const MIN_GAIN_MS = 1;
export const HOLD_MS = 4_000;
/** A path that has received nothing for this long is dead, even if its socket is open. Pings go every 2 s. */
export const SILENT_MS = 7_000;

export interface PathEntry {
  session: Session;
  /** The device that dialed this path. */
  initiator: string;
  since: number;
  lastHeard: number;
}

export function score(s: Session): number {
  const m = s.measurements();
  return m.rttMs === null ? Infinity : m.rttMs + m.queuedBytes / 1024;
}

export class PathSet {
  #paths: PathEntry[] = [];
  #active: PathEntry | null = null;
  /** The challenger and when it started being better. */
  #better: { entry: PathEntry; since: number } | null = null;

  all(): PathEntry[] {
    return [...this.#paths];
  }

  get size(): number {
    return this.#paths.length;
  }

  on(transport: string): PathEntry | undefined {
    return this.#paths.find((e) => e.session.path.transport === transport);
  }

  entry(s: Session): PathEntry | undefined {
    return this.#paths.find((e) => e.session === s);
  }

  active(): Session | null {
    return this.#active?.session ?? null;
  }

  /** Adds a path. The first path becomes active; later ones must win on score. */
  add(session: Session, initiator: string, now = Date.now()): void {
    const e: PathEntry = { session, initiator, since: now, lastHeard: now };
    this.#paths.push(e);
    this.#active ??= e;
  }

  /** Removes a path. Returns the new active session if the active one was removed. */
  remove(session: Session): { wasActive: boolean; active: Session | null } {
    const e = this.entry(session);
    if (!e) return { wasActive: false, active: this.active() };
    this.#paths = this.#paths.filter((x) => x !== e);
    if (this.#better?.entry === e) this.#better = null;
    if (this.#active !== e) return { wasActive: false, active: this.active() };
    this.#active = this.#best();
    this.#better = null;
    return { wasActive: true, active: this.active() };
  }

  #best(): PathEntry | null {
    let best: PathEntry | null = null;
    for (const e of this.#paths) if (!best || score(e.session) < score(best.session)) best = e;
    return best;
  }

  /** Re-checks the active path after a measurement. Returns the new active session if it switched. */
  evaluate(now = Date.now()): Session | null {
    const cur = this.#active;
    if (!cur) return null;
    const best = this.#best();
    if (!best || best === cur) {
      this.#better = null;
      return null;
    }
    const a = score(cur.session);
    const b = score(best.session);
    if (!(b < a * SWITCH_RATIO && a - b >= MIN_GAIN_MS)) {
      this.#better = null;
      return null;
    }
    if (this.#better?.entry !== best) this.#better = { entry: best, since: now };
    if (now - this.#better.since < HOLD_MS) return null;
    this.#active = best;
    this.#better = null;
    return best.session;
  }
}
