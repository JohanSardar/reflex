// The web viewer's link to its host (the Link, or `reflex dev`): one long
// fetch that streams the host's events as newline-delimited JSON, and a POST
// for each sync reply. Each Space is a full kernel replica here, kept in step
// by the kernel's own sync protocol. The host refuses any change from a
// viewer, so these replicas only ever receive.
import { kernel, randomHex, type Space } from "./kernel.ts";

export type Person = { id: string; name: string };
export type HostEvent =
  | { t: "hello"; person: Person; names: Record<string, string>; spaces: { id: string; kind: string }[] }
  | { t: "sync"; space: string; msg: string }
  | { t: "ping" }
  | { t: "reload"; reason?: string }
  | { t: string; [k: string]: unknown };

/** `bad_key`: the host refused the viewer key (a Link restart makes a new one); retrying won't help. */
export type Status = "connecting" | "live" | "offline" | "bad_key";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Connection {
  readonly key: string;
  readonly peer = randomHex(8);
  readonly replicas = new Map<string, { kind: string; space: Space }>();
  person: Person = { id: "", name: "" };
  names: Record<string, string> = {};
  status: Status = "connecting";
  #listeners: ((e: { space?: string; event: HostEvent }) => void)[] = [];
  #statusListeners: ((s: Status) => void)[] = [];
  #actor = randomHex(16);
  #queue: Promise<unknown> = Promise.resolve();

  constructor(key: string) {
    this.key = key;
  }

  on(fn: (e: { space?: string; event: HostEvent }) => void) {
    this.#listeners.push(fn);
  }
  onStatus(fn: (s: Status) => void) {
    this.#statusListeners.push(fn);
  }
  #setStatus(s: Status) {
    this.status = s;
    for (const l of this.#statusListeners) l(s);
  }

  /** Calls one of the host's /api routes with the viewer key. */
  async api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(path, { ...init, headers: { ...(init.headers ?? {}), "x-reflex-key": this.key } });
  }

  /** Connects, and reconnects with backoff for as long as the page is open. */
  async run(): Promise<void> {
    const { Space } = await kernel();
    let wait = 500;
    for (;;) {
      this.#setStatus("connecting");
      try {
        const res = await this.api(`/api/events?peer=${this.peer}`);
        if (res.status === 401) {
          this.#setStatus("bad_key");
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        // A new stream is a new sync conversation: the host reset its side, so reset ours.
        for (const r of this.replicas.values()) r.space.resetSync("host");
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) this.#handle(JSON.parse(line) as HostEvent, Space);
          }
          wait = 500;
        }
      } catch {
        // Offline: try again below.
      }
      this.#setStatus("offline");
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 8000);
    }
  }

  #handle(e: HostEvent, Space: { create(space: string, kind: string, actorHex: string): Space }) {
    if (e.t === "hello") {
      const h = e as Extract<HostEvent, { t: "hello" }>;
      this.person = h.person;
      this.names = h.names;
      for (const s of h.spaces) if (!this.replicas.has(s.id)) this.replicas.set(s.id, { kind: s.kind, space: Space.create(s.id, s.kind, this.#actor) });
      this.#setStatus("live");
      for (const l of this.#listeners) l({ event: e });
      return;
    }
    if (e.t === "sync") {
      const s = e as Extract<HostEvent, { t: "sync" }>;
      const r = this.replicas.get(s.space);
      if (!r) return;
      r.space.receiveSyncMessage("host", b64(s.msg));
      const reply = r.space.syncMessage("host");
      // Replies go out in order, one at a time, as the sync protocol expects.
      if (reply) this.#queue = this.#queue.then(() => this.api(`/api/sync?peer=${this.peer}&space=${encodeURIComponent(s.space)}`, { method: "POST", body: reply as Uint8Array<ArrayBuffer> }).catch(() => {}));
      for (const l of this.#listeners) l({ space: s.space, event: e });
      return;
    }
    for (const l of this.#listeners) l({ event: e });
  }
}
