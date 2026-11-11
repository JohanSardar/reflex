// What the person's iPads report about themselves, kept in memory only:
//
//   presence { space: string | null, pen: boolean }   the Space on screen (null when none is, or
//                                                     the app is in the background), and whether
//                                                     the pen is down right now
//   hints    { space, region, hints: [{ strokes, text, confidence }] }
//                                                     the iPad's handwriting recognizer's lines for
//                                                     the person's Ink in a watched Region, replacing
//                                                     what it sent before for that Region
//
// `request_attention` uses it to answer `already_viewing`, and watch mode for
// `user_still_writing` (a live pen-down signal) and for the recognized text of
// strokes no Send has carried yet. A device counts only while it is connected.

export type Hint = { strokes: string[]; text: string; confidence: number };

/** After the pen lifts, how long the person still counts as writing: the gap between strokes of one line. */
const BETWEEN_STROKES_MS = 1500;
const MAX_HINTS = 200;

type Device = { space: string | null; pen: boolean; penUpAt: number };

export class Presence {
  #devices = new Map<string, Device>();
  /** space → region → device → hints. */
  #hints = new Map<string, Map<string, Map<string, Hint[]>>>();
  #connected: () => Set<string>;

  constructor(connected: () => Set<string>) {
    this.#connected = connected;
  }

  /** A `presence` or `hints` message from a device of the person's. Returns whether it was one. */
  receive(device: string, h: Record<string, unknown>): boolean {
    if (h.t === "presence") {
      const was = this.#devices.get(device);
      const pen = h.pen === true;
      const space = typeof h.space === "string" && h.space ? h.space.slice(0, 200) : null;
      this.#devices.set(device, { space, pen, penUpAt: was?.pen && !pen ? Date.now() : (was?.penUpAt ?? 0) });
      return true;
    }
    if (h.t === "hints") {
      if (typeof h.space !== "string" || typeof h.region !== "string" || !Array.isArray(h.hints)) return true;
      const hints = (h.hints as unknown[]).slice(0, MAX_HINTS).flatMap((x): Hint[] => {
        const o = x as Record<string, unknown>;
        if (!Array.isArray(o?.strokes) || typeof o.text !== "string") return [];
        const strokes = (o.strokes as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 2000);
        const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.min(1, Math.max(0, o.confidence)) : 0.5;
        return strokes.length && o.text.trim() ? [{ strokes, text: o.text.slice(0, 2000), confidence }] : [];
      });
      let regions = this.#hints.get(h.space);
      if (!regions) this.#hints.set(h.space, (regions = new Map()));
      let byDevice = regions.get(h.region);
      if (!byDevice) regions.set(h.region, (byDevice = new Map()));
      byDevice.set(device, hints);
      return true;
    }
    return false;
  }

  #live(): [string, Device][] {
    const on = this.#connected();
    return [...this.#devices].filter(([d]) => on.has(d));
  }

  /** The Spaces on screen on a connected device. */
  viewing(): string[] {
    return [...new Set(this.#live().flatMap(([, d]) => (d.space ? [d.space] : [])))];
  }

  /**
   * Whether the person is writing in this Space now, from a device showing it: the pen is down,
   * or lifted only a moment ago. Undefined when no connected device is showing it.
   */
  writing(space: string): boolean | undefined {
    const here = this.#live().filter(([, d]) => d.space === space);
    if (!here.length) return undefined;
    const now = Date.now();
    return here.some(([, d]) => d.pen || now - d.penUpAt < BETWEEN_STROKES_MS);
  }

  /** Every connected device's latest recognized lines for one watched Region. */
  hints(space: string, region: string): Hint[] {
    const on = this.#connected();
    return [...(this.#hints.get(space)?.get(region) ?? [])].filter(([d]) => on.has(d)).flatMap(([, h]) => h);
  }
}
