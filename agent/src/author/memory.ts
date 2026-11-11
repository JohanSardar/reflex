// In-memory Spaces and Inbox for the author kit: `reflex dev` and `reflex test`
// run the real capability table on these, with no Link and nothing on disk.
import { randomBytes } from "node:crypto";
import { Space } from "@reflex/kernel/node";
import type { Bounds, Delivery, FrozenSend, Inbox, SpaceEntry, SpaceStore, WaitFilter, WriteOrigin } from "../store.ts";

type Entry = SpaceEntry & { agents: Set<string> };

export class MemorySpaces implements SpaceStore {
  #spaces = new Map<string, Entry>();
  #actor = randomBytes(16).toString("hex");
  #inbox: MemoryInbox;
  #listeners: ((space: string) => void)[] = [];

  constructor(inbox: MemoryInbox) {
    this.#inbox = inbox;
  }

  /** Called after every write, with the Space it changed. */
  onChange(fn: (space: string) => void) {
    this.#listeners.push(fn);
  }

  get(name: string) {
    return this.#spaces.get(name);
  }

  create(name: string, o: { kind?: "space" | "library"; title?: string; size?: SpaceEntry["size"]; width?: number }) {
    const have = this.#spaces.get(name);
    if (have) return have;
    const kind = o.kind ?? "space";
    const viewport: Bounds = [0, 0, 1366, 1024];
    const e: Entry = { name, kind, ...(o.title ? { title: o.title } : {}), size: o.size ?? "infinite", ...(o.width ? { width: o.width } : {}), viewport, space: Space.create(name, kind, this.#actor), agents: new Set() };
    this.#spaces.set(name, e);
    for (const l of this.#listeners) l(name);
    return e;
  }

  list() {
    return [...this.#spaces.values()];
  }

  write<T>(entry: SpaceEntry, origin: WriteOrigin, fn: (s: Space) => T): T {
    const out = fn(entry.space);
    if (origin === "send") {
      const sends: string[] = JSON.parse(entry.space.scene(JSON.stringify({ detail: "full", ids: [] }))).sends ?? [];
      for (const s of sends) this.#inbox.index(entry.name, s, () => JSON.parse(entry.space.send(s)), [...(this.#spaces.get(entry.name)?.agents ?? [])]);
    }
    for (const l of this.#listeners) l(entry.name);
    return out;
  }

  attach(entry: SpaceEntry, agent: string) {
    this.#spaces.get(entry.name)?.agents.add(agent);
  }

  /** Sets the person's viewport, which open_space and Sends use. */
  setViewport(name: string, viewport: Bounds) {
    const e = this.#spaces.get(name);
    if (e) this.#spaces.set(name, { ...e, viewport });
  }
}

type Item = { space: string; send: string; frozen: () => FrozenSend; state: Map<string, "ready" | "delivered" | "acknowledged"> };

export class MemoryInbox implements Inbox {
  #items: Item[] = [];
  #waiters = new Set<() => void>();

  index(space: string, send: string, frozen: () => FrozenSend, agents: string[]) {
    if (this.#items.some((i) => i.send === send)) return;
    this.#items.push({ space, send, frozen, state: new Map(agents.map((a) => [a, "ready"])) });
    for (const w of this.#waiters) w();
  }

  take(agent: string, f: WaitFilter): Delivery | undefined {
    for (const i of this.#items) {
      const st = i.state.get(agent);
      if (!st || st === "acknowledged" || (f.space && f.space !== i.space)) continue;
      const send = i.frozen();
      if (f.region && send.region !== f.region) continue;
      if (f.element && !(send.kind === "tap" && send.element === f.element)) continue;
      i.state.set(agent, "delivered");
      return { send, redelivered: st === "delivered" };
    }
    return undefined;
  }

  ack(agent: string, send: string) {
    const i = this.#items.find((x) => x.send === send);
    if (!i?.state.has(agent)) return false;
    i.state.set(agent, "acknowledged");
    return true;
  }

  pending(agent: string, space?: string) {
    return this.#items.filter((i) => (!space || i.space === space) && i.state.has(agent) && i.state.get(agent) !== "acknowledged").length;
  }

  recipients(send: string) {
    return [...(this.#items.find((i) => i.send === send)?.state.keys() ?? [])];
  }

  arrival(_agent: string, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.#waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
