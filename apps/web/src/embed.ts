// HTML Embeds on the web (SPEC §5, ARCHITECTURE §5): each one runs in a
// sandboxed iframe with an opaque origin (no allow-same-origin), a Content
// Security Policy that lets it load code only from its allowlist and the
// approved CDNs and reach the network only on its own allowlist, and the
// `reflex` bridge (bridge.js, shared with the iPad) as its only way to the rest
// of Reflex. It can never read other Elements or Spaces. What the sandbox stops
// is shown on the Embed.

export type Template = { kind: string; name: string; template: unknown; allow?: string[]; params?: unknown; source?: string };
export type EmbedEvent = { element: string; t: string; [k: string]: unknown };

/** Approved CDNs: an Embed may load scripts, styles, fonts and images from them. Not data (connect-src). */
export const DEFAULT_ALLOW = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh"];
/** An Embed that hasn't answered for this long is stopped. */
const STALL_MS = 5000;
/** Events (notify, emit, panel, tool calls) an Embed may send per 10 seconds. */
const EVENTS_PER_10S = 10;

const BRIDGE = await (await fetch(new URL("./bridge.js", import.meta.url))).text();

const safeJson = (v: unknown) => JSON.stringify(v ?? {}).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const hostOk = (h: string) => /^[a-z0-9.-]{1,253}$/.test(h);

/** The MCP server a 'ui://' resource belongs to: its authority. */
export const serverOf = (uri?: string) => (uri?.startsWith("ui://") ? uri.slice(5).split("/")[0] || undefined : undefined);

/** The document an Embed runs: CSP first, then the bridge, then the template. */
export function embedDocument(html: string, o: { props: unknown; state: unknown; allow: string[]; mcp?: { server: string } }): string {
  const own = [...new Set(o.allow)].filter(hostOk).map((h) => `https://${h}`);
  const code = [...new Set([...o.allow, ...DEFAULT_ALLOW])].filter(hostOk).map((h) => `https://${h}`).join(" ");
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${code}`,
    `style-src 'unsafe-inline' ${code}`,
    `img-src data: blob: ${code}`,
    `font-src data: ${code}`,
    `media-src data: blob: ${own.join(" ")}`,
    // No network by default: only the hosts this Embed was allowed.
    `connect-src ${own.length ? [...own, ...own.map((h) => h.replace("https://", "wss://"))].join(" ") : "'none'"}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const config = safeJson({ props: o.props ?? {}, state: o.state ?? {}, ...(o.mcp ? { mcp: o.mcp } : {}) });
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${BRIDGE.replaceAll("__REFLEX_CONFIG__", () => config)}</script>`;
  // Inside <head> when the template has one, so the CSP applies before anything loads.
  const at = /<head[^>]*>/i.exec(html);
  if (at) return html.slice(0, at.index + at[0].length) + head + html.slice(at.index + at[0].length);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

type Live = {
  frame: HTMLIFrameElement;
  box: HTMLElement;
  /** A fresh frame for this Embed, for a restart. */
  make: () => HTMLIFrameElement;
  anchors: boolean;
  beat: number;
  server?: string;
  events: number[];
  stopped?: boolean;
  restarts: number;
};

/** Every live Embed frame, by Element ID, and what it registered. */
export class Embeds {
  #frames = new Map<string, Live>();
  #pending = new Map<string, (a: unknown) => void>();
  #listeners: ((e: EmbedEvent) => void)[] = [];
  /** Embeds waiting to restart after a stall, and the one being restarted now. */
  #queue: string[] = [];
  #probe?: { id: string; until: number };
  templates = new Map<string, Template>();

  constructor() {
    addEventListener("message", (ev) => {
      const m = ev.data as Record<string, unknown> | null;
      if (!m || m.__reflex !== 1) return;
      const entry = [...this.#frames.entries()].find(([, f]) => f.frame.contentWindow === ev.source);
      if (!entry) return; // only the frames we made, never another window
      const [element, f] = entry;
      if (f.stopped) return;
      f.beat = performance.now();
      switch (m.t) {
        case "beat":
        case "ready":
          return;
        case "anchors":
          f.anchors = true;
          return;
        case "resolved":
          this.#pending.get(String(m.id))?.(m.anchor);
          this.#pending.delete(String(m.id));
          return;
        case "blocked":
          return this.#note(f, `Blocked ${m.what}: ${m.detail}`);
        case "tool_call":
          // The web viewer reads and never writes, so it can't hand the call to an Agent.
          this.#note(f, `Blocked a call to ${f.server ?? "its server"}'s tool ${m.name}: Embeds can't call tools here`);
          f.frame.contentWindow?.postMessage({ __reflex: 2, t: "rpc", id: m.id, error: { code: -32000, message: `Reflex denied ${m.name}: the web viewer can't call ${f.server ?? "this server"}'s tools.` } }, "*");
          return;
      }
      if (["notify", "emit", "panel", "mcp_message"].includes(String(m.t))) {
        const now = performance.now();
        f.events = f.events.filter((t) => now - t < 10_000);
        if (f.events.length >= EVENTS_PER_10S) return this.#note(f, "Blocked events: more than 10 in 10 seconds");
        f.events.push(now);
      }
      for (const l of this.#listeners) l({ ...m, element, t: String(m.t) });
    });
    // The CPU limit: an Embed whose page stops answering is stopped, and says so.
    // A hidden tab runs the frames' timers rarely, so the limit counts only while it is shown.
    document.addEventListener("visibilitychange", () => {
      for (const f of this.#frames.values()) f.beat = performance.now() + 2000;
    });
    setInterval(() => this.#watch(), 1000);
  }

  // Sandboxed frames from one page can share a process, so one busy Embed freezes the
  // others with it, and only removing every frame in that process frees it. When
  // several stall together, all of them are removed and then restarted one at a time:
  // the one that stalls again on its own is the busy one, and stays stopped.
  #watch() {
    if (document.hidden) return;
    const now = performance.now();
    const stalled = [...this.#frames].filter(([, f]) => !f.stopped && f.frame.isConnected && now - f.beat >= STALL_MS);
    if (stalled.length) {
      const probe = this.#probe && this.#frames.get(this.#probe.id);
      const culprit = stalled.length === 1 ? stalled[0][0] : probe && !probe.stopped && now - probe.beat >= STALL_MS ? this.#probe!.id : undefined;
      this.#probe = undefined;
      for (const [id, f] of stalled) {
        f.frame.remove();
        if (id === culprit || f.restarts >= 2) {
          f.stopped = true;
          this.#note(f, "Stopped: it kept the processor busy and stopped answering");
        } else if (!this.#queue.includes(id)) {
          this.#queue.push(id);
          this.#note(f, "Paused: an Embed here kept the processor busy; restarting…");
        }
      }
      return;
    }
    if (this.#probe && now < this.#probe.until) return;
    this.#probe = undefined;
    const id = this.#queue.shift();
    const f = id === undefined ? undefined : this.#frames.get(id);
    if (!id || !f || !f.box.isConnected) return;
    f.restarts++;
    f.frame = f.make();
    f.anchors = false;
    f.beat = performance.now() + 2000;
    f.box.querySelector(".embed-note")?.remove();
    f.box.prepend(f.frame);
    // Long enough for a stall to show (STALL_MS without a beat) before the next one starts.
    this.#probe = { id, until: f.beat + 2 * STALL_MS };
  }

  #note(f: Live, text: string) {
    let n = f.box.querySelector(".embed-note");
    if (!n) {
      n = document.createElement("div");
      n.className = "embed-note";
      f.box.append(n);
    }
    n.textContent = text.slice(0, 300); // text, never markup
  }

  on(fn: (e: EmbedEvent) => void) {
    this.#listeners.push(fn);
  }

  /** An iframe (in a box that shows what the sandbox blocked) for an embed Element, or undefined when there is nothing to run. */
  frame(e: Record<string, any>): HTMLElement | undefined {
    let html: string | undefined;
    let allow: string[] = e.allow ?? [];
    let source: string | undefined = typeof e.url === "string" && e.url.startsWith("ui://") ? e.url : undefined;
    if (typeof e.html === "string") html = e.html;
    else if (typeof e.template === "string") {
      const t = this.templates.get(e.template);
      if (t && typeof t.template === "string") {
        html = t.template;
        allow = [...allow, ...(t.allow ?? [])];
        source ??= t.source;
      }
    }
    if (html === undefined && !(typeof e.url === "string" && e.url.startsWith("https://"))) return undefined;
    const box = document.createElement("div");
    box.className = "embed-box";
    const server = serverOf(source);
    const doc = html === undefined ? undefined : embedDocument(html, { props: { ...(e.params ?? {}), ...(e.data ? { data: e.data } : {}) }, state: e.state ?? {}, allow, ...(server ? { mcp: { server } } : {}) });
    const make = () => {
      const frame = document.createElement("iframe");
      frame.className = "embed-frame";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("credentialless", "");
      frame.setAttribute("allow", "");
      if (doc !== undefined) frame.srcdoc = doc;
      else frame.src = e.url;
      return frame;
    };
    const frame = make();
    box.append(frame);
    this.#queue = this.#queue.filter((q) => q !== e.id);
    this.#frames.set(e.id, { frame, box, make, anchors: false, beat: performance.now() + 10_000, ...(server ? { server } : {}), events: [], restarts: 0 });
    return box;
  }

  forget(id: string) {
    this.#frames.delete(id);
  }

  /** Whether an Embed registered an Anchor resolver. */
  hasAnchors(id: string) {
    return Boolean(this.#frames.get(id)?.anchors);
  }

  /**
   * Asks an Embed what a Mark points at. `region` is the Mark's geometry in the Embed's own
   * pixels. Resolves to the Embed's answer, or null when it has no resolver or doesn't answer.
   */
  resolve(id: string, region: { points: number[][]; bounds: [number, number, number, number] }, ms = 1500): Promise<unknown> {
    const f = this.#frames.get(id);
    if (!f?.anchors || f.stopped || !f.frame.contentWindow) return Promise.resolve(null);
    const rid = crypto.randomUUID();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#pending.delete(rid);
        resolve(null);
      }, ms);
      this.#pending.set(rid, (a) => {
        clearTimeout(t);
        resolve(a);
      });
      f.frame.contentWindow!.postMessage({ __reflex: 2, t: "resolve", id: rid, region }, "*");
    });
  }
}
