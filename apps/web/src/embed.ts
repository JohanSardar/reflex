// HTML Embeds on the web (SPEC §5, ARCHITECTURE §5): each one runs in a
// sandboxed iframe with an opaque origin (no allow-same-origin), a Content
// Security Policy that only lets it load from its allowlist and the approved
// CDNs, and the `reflex` bridge as its only way to the rest of Reflex. It can
// never read other Elements or Spaces.

export type Template = { kind: string; name: string; template: unknown; allow?: string[]; params?: unknown };
export type EmbedEvent = { element: string; t: string; [k: string]: unknown };

export const DEFAULT_ALLOW = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh"];

// The bridge, as the Embed sees it. Calls that change something are posted to the page around it.
const BRIDGE = `(() => {
  const PROPS = __PROPS__;
  let state = __STATE__;
  let resolver = null;
  const post = (m) => parent.postMessage(Object.assign({ __reflex: 1 }, m), "*");
  window.reflex = {
    element: {
      props: () => PROPS,
      state: () => state,
      setState: (patch) => { state = Object.assign({}, state, patch); post({ t: "setState", patch }); },
    },
    notify: (payload) => post({ t: "notify", payload }),
    emit: (name, payload) => post({ t: "emit", name, payload }),
    panel: { open: (spec) => post({ t: "panel", spec }) },
    anchors: { register: (r) => { resolver = r; post({ t: "anchors" }); } },
  };
  addEventListener("message", async (e) => {
    const m = e.data;
    if (!m || m.__reflex !== 2 || m.t !== "resolve") return;
    let anchor = null;
    try { anchor = resolver ? await resolver.resolve(m.region) : null; } catch (err) { anchor = { error: String(err) }; }
    post({ t: "resolved", id: m.id, anchor });
  });
})();`;

const safeJson = (v: unknown) => JSON.stringify(v ?? {}).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The document an Embed runs: CSP first, then the bridge, then the template. */
export function embedDocument(html: string, o: { props: unknown; state: unknown; allow: string[] }): string {
  const hosts = [...new Set([...o.allow, ...DEFAULT_ALLOW])].filter((h) => /^[a-z0-9.-]{1,253}$/.test(h)).map((h) => `https://${h}`);
  const src = hosts.join(" ");
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${src}`,
    `style-src 'unsafe-inline' ${src}`,
    `img-src data: blob: ${src}`,
    `font-src data: ${src}`,
    `connect-src ${src} ${hosts.map((h) => h.replace("https://", "wss://")).join(" ")}`,
    "frame-src 'none'",
    "form-action 'none'",
  ].join("; ");
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${BRIDGE.replace("__PROPS__", safeJson(o.props)).replace("__STATE__", safeJson(o.state))}</script>`;
  // Inside <head> when the template has one, so the CSP applies before anything loads.
  const at = /<head[^>]*>/i.exec(html);
  if (at) return html.slice(0, at.index + at[0].length) + head + html.slice(at.index + at[0].length);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

/** Every live Embed frame, by Element ID, and what it registered. */
export class Embeds {
  #frames = new Map<string, { frame: HTMLIFrameElement; anchors: boolean }>();
  #pending = new Map<string, (a: unknown) => void>();
  #listeners: ((e: EmbedEvent) => void)[] = [];
  templates = new Map<string, Template>();

  constructor() {
    addEventListener("message", (ev) => {
      const m = ev.data as Record<string, unknown> | null;
      if (!m || m.__reflex !== 1) return;
      const entry = [...this.#frames.entries()].find(([, f]) => f.frame.contentWindow === ev.source);
      if (!entry) return; // only the frames we made, never another window
      const [element, f] = entry;
      if (m.t === "anchors") f.anchors = true;
      if (m.t === "resolved") {
        this.#pending.get(String(m.id))?.(m.anchor);
        this.#pending.delete(String(m.id));
        return;
      }
      for (const l of this.#listeners) l({ ...m, element, t: String(m.t) });
    });
  }

  on(fn: (e: EmbedEvent) => void) {
    this.#listeners.push(fn);
  }

  /** An iframe for an embed Element, or undefined when there is nothing to run. */
  frame(e: Record<string, any>): HTMLElement | undefined {
    let html: string | undefined;
    let allow: string[] = e.allow ?? [];
    if (typeof e.html === "string") html = e.html;
    else if (typeof e.template === "string") {
      const t = this.templates.get(e.template);
      if (t && typeof t.template === "string") {
        html = t.template;
        allow = [...allow, ...(t.allow ?? [])];
      }
    }
    if (html === undefined && !(typeof e.url === "string" && e.url.startsWith("https://"))) return undefined;
    const frame = document.createElement("iframe");
    frame.className = "embed-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("credentialless", "");
    if (html !== undefined) frame.srcdoc = embedDocument(html, { props: { ...(e.params ?? {}), ...(e.data ? { data: e.data } : {}) }, state: e.state ?? {}, allow });
    else frame.src = e.url;
    this.#frames.set(e.id, { frame, anchors: false });
    return frame;
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
    if (!f?.anchors || !f.frame.contentWindow) return Promise.resolve(null);
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
