// DOM renderers for the native Element types (ARCHITECTURE §2, the `web`
// unit). Each Element is one absolutely placed node in world coordinates;
// connectors and Ink are drawn in one SVG on top. A camera transform maps the
// world onto the screen. Nodes are reused while an Element is unchanged, so an
// Embed's iframe keeps running across updates.
//
// Everything an Agent wrote is set as text or attributes, never parsed as
// HTML: Agent output is data, not instructions (SPEC §2).

export type Bounds = [number, number, number, number];
export type El = Record<string, any> & { id: string; type: string; bounds: Bounds };

export const COLORS: Record<string, string> = {
  black: "#1d1d1f",
  grey: "#8e8e93",
  white: "#ffffff",
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#f5c400",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  violet: "#6e56cf",
  pink: "#d6409f",
};
const TINT: Record<string, string> = {
  black: "#e8e8ea",
  grey: "#f0f0f2",
  white: "#ffffff",
  red: "#ffe5e5",
  orange: "#ffefe0",
  yellow: "#fff8c5",
  green: "#e2f6ea",
  teal: "#dff6f2",
  blue: "#e1f0ff",
  violet: "#eeeaff",
  pink: "#fde8f3",
};
const SIZES: Record<string, number> = { s: 14, m: 18, l: 24, xl: 34 };
/** Draw order: containers first, then content, then connectors, then Ink on top. */
const LAYER: Record<string, number> = { region: 0, frame: 1, image: 2, embed: 2, file: 2, connector: 4, ink: 5 };
const SVG = "http://www.w3.org/2000/svg";

const h = (tag: string, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const s = (tag: string, attrs: Record<string, string | number>) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const center = (b: Bounds): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];
/** Where the line from a box's center towards p leaves the box. */
function edge(b: Bounds, p: [number, number]): [number, number] {
  const [cx, cy] = center(b);
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sc = Math.min(dx === 0 ? Infinity : b[2] / 2 / Math.abs(dx), dy === 0 ? Infinity : b[3] / 2 / Math.abs(dy));
  return [cx + dx * sc, cy + dy * sc];
}

/** Markdown, minimally and safely: headings, paragraphs, bullets, **bold** and `code`. */
function markdown(text: string, into: HTMLElement) {
  for (const line of text.split("\n")) {
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const row = h(head ? `md-h${head[1].length}` : bullet ? "md-li" : "md-p");
    const body = head ? head[2] : bullet ? bullet[1] : line;
    for (const part of body.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.startsWith("**")) row.append(h("b", undefined, part.slice(2, -2)));
      else if (part.startsWith("`")) row.append(h("code", undefined, part.slice(1, -1)));
      else row.append(document.createTextNode(part));
    }
    if (!body) row.append(document.createTextNode(" "));
    into.append(row);
  }
}

function shapeSvg(shape: string, w: number, ht: number, fill: string, stroke: string, dash: string) {
  const svg = s("svg", { width: w, height: ht, viewBox: `-2 -2 ${w + 4} ${ht + 4}`, class: "shape-svg" });
  const a = { fill, stroke, "stroke-width": 2.5, ...(dash ? { "stroke-dasharray": dash } : {}) };
  const q = w / 4;
  const node =
    shape === "ellipse"
      ? s("ellipse", { cx: w / 2, cy: ht / 2, rx: w / 2, ry: ht / 2, ...a })
      : shape === "diamond"
        ? s("polygon", { points: `${w / 2},0 ${w},${ht / 2} ${w / 2},${ht} 0,${ht / 2}`, ...a })
        : shape === "triangle"
          ? s("polygon", { points: `${w / 2},0 ${w},${ht} 0,${ht}`, ...a })
          : shape === "hexagon"
            ? s("polygon", { points: `${q},0 ${w - q},0 ${w},${ht / 2} ${w - q},${ht} ${q},${ht} 0,${ht / 2}`, ...a })
            : s("rect", { x: 0, y: 0, width: w, height: ht, rx: shape === "rounded" ? Math.min(18, ht / 3) : 3, ...a });
  svg.append(node);
  return svg;
}
const dashOf = (stroke?: string) => (stroke === "dashed" ? "10 6" : stroke === "dotted" ? "2 5" : "");

export interface ViewHooks {
  /** An Embed's live content: an iframe the caller builds, or undefined for a placeholder. */
  embed?: (e: El) => HTMLElement | undefined;
  /** An object URL for an asset's bytes. */
  asset?: (hash: string) => Promise<string | undefined>;
}

export class SceneView {
  readonly root: HTMLElement;
  readonly world: HTMLElement;
  readonly overlay: SVGSVGElement;
  camera = { x: 0, y: 0, zoom: 1 };
  #nodes = new Map<string, { sig: string; node: HTMLElement }>();
  #hooks: ViewHooks;
  elements: El[] = [];

  constructor(root: HTMLElement, hooks: ViewHooks = {}) {
    this.root = root;
    this.#hooks = hooks;
    this.world = h("div", "world");
    this.overlay = s("svg", { class: "overlay", width: 1, height: 1 }) as SVGSVGElement;
    this.world.append(this.overlay);
    root.append(this.world);
    this.#pan();
  }

  /** Draws a scene: Elements in full detail and Ink points by Element ID. */
  update(elements: El[], strokes: Record<string, number[][]>) {
    this.elements = elements;
    const byId = new Map(elements.map((e) => [e.id, e]));
    const seen = new Set<string>();
    const sorted = [...elements].sort((a, b) => (LAYER[a.type] ?? 3) - (LAYER[b.type] ?? 3));
    sorted.forEach((e, i) => {
      if (e.type === "connector" || e.type === "ink") return;
      seen.add(e.id);
      const sig = JSON.stringify(e);
      let have = this.#nodes.get(e.id);
      if (!have || have.sig !== sig) {
        const node = this.#node(e);
        if (have) have.node.replaceWith(node);
        else this.world.insertBefore(node, this.overlay);
        have = { sig, node };
        this.#nodes.set(e.id, have);
      }
      have.node.style.zIndex = String(i);
    });
    for (const [id, n] of this.#nodes) if (!seen.has(id)) (n.node.remove(), this.#nodes.delete(id));

    // Connectors and Ink: redrawn each time, they are cheap.
    this.overlay.replaceChildren();
    for (const e of sorted) {
      if (e.type === "connector") this.#connector(e, byId);
      if (e.type === "ink") this.#ink(e, strokes[e.id]);
    }
  }

  #node(e: El): HTMLElement {
    const [x, y, w, ht] = e.bounds;
    const n = h("div", `el el-${e.type}`);
    n.dataset.id = e.id;
    Object.assign(n.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${ht}px` });
    const color = COLORS[e.color] ?? COLORS.black;
    switch (e.type) {
      case "shape": {
        const fill = e.fill === "solid" ? (COLORS[e.color] ?? COLORS.blue) : e.fill === "tint" ? (TINT[e.color] ?? TINT.blue) : "#ffffff";
        n.append(shapeSvg(e.shape ?? "rect", w, ht, fill, color, dashOf(e.stroke)));
        if (e.text) {
          const t = h("div", "label center", e.text);
          if (e.fill === "solid") t.style.color = "#fff";
          n.append(t);
        }
        break;
      }
      case "note":
        n.style.background = TINT[e.color] ?? TINT.yellow;
        n.style.borderColor = COLORS[e.color] ?? COLORS.yellow;
        n.append(h("div", "label", e.text ?? ""));
        break;
      case "text": {
        const t = h("div", `label size-${e.size ?? "m"}`);
        t.style.color = color;
        t.style.fontSize = `${SIZES[e.size] ?? 18}px`;
        if (e.align === "middle") t.classList.add("center");
        if (e.markdown) markdown(String(e.text ?? ""), t);
        else t.textContent = e.text ?? "";
        n.append(t);
        break;
      }
      case "math": {
        const t = h("div", "label math", e.latex ?? "");
        t.style.color = color;
        t.style.fontSize = `${SIZES[e.size] ?? 22}px`;
        n.append(t);
        break;
      }
      case "frame":
        if (e.title) n.append(h("div", "frame-title", e.title));
        break;
      case "region":
        if (e.title) n.append(h("div", "region-title", e.title));
        if (e.send_button) n.append(h("div", "region-send", e.send_button));
        break;
      case "image": {
        const src = String(e.src ?? "");
        if (src.startsWith("asset:") && this.#hooks.asset) {
          const img = h("img") as HTMLImageElement;
          img.alt = e.alt ?? "";
          void this.#hooks.asset(src.slice(6)).then((u) => (u ? (img.src = u) : img.replaceWith(h("div", "placeholder", `image: ${e.alt ?? "not here yet"}`))));
          n.append(img);
        } else n.append(h("div", "placeholder", `image${e.alt ? `: ${e.alt}` : ""}`));
        break;
      }
      case "file":
        n.append(h("div", "file-name", e.name ?? "file"), h("div", "file-meta", [e.mime, e.size ? `${Math.round(e.size / 1024)} KB` : ""].filter(Boolean).join(" · ")));
        break;
      case "embed": {
        const live = this.#hooks.embed?.(e);
        n.append(live ?? h("div", "placeholder", `embed: ${e.template ?? e.url ?? "html"}`));
        break;
      }
      default:
        n.append(h("div", "placeholder", e.type));
    }
    return n;
  }

  #connector(e: El, byId: Map<string, El>) {
    const color = COLORS[e.color] ?? COLORS.black;
    const from = e.from && byId.get(e.from);
    const to = e.to && byId.get(e.to);
    const b = e.bounds;
    const pts: [number, number][] =
      from && to ? [edge(from.bounds, center(to.bounds)), edge(to.bounds, center(from.bounds))] : Array.isArray(e.points) ? e.points : [[b[0], b[1]], [b[0] + b[2], b[1] + b[3]]];
    const g = s("g", { "data-id": e.id });
    g.append(s("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: color, "stroke-width": 2.5, ...(dashOf(e.stroke) ? { "stroke-dasharray": dashOf(e.stroke) } : {}) }));
    const head = (tip: [number, number], back: [number, number]) => {
      const len = Math.hypot(tip[0] - back[0], tip[1] - back[1]);
      if (!(len > 0)) return;
      const [ux, uy] = [(tip[0] - back[0]) / len, (tip[1] - back[1]) / len];
      const [bx, by] = [tip[0] - ux * 16, tip[1] - uy * 16];
      g.append(s("polygon", { points: `${tip[0]},${tip[1]} ${bx - uy * 7},${by + ux * 7} ${bx + uy * 7},${by - ux * 7}`, fill: color }));
    };
    const arrow = e.arrow ?? "end";
    if (pts.length >= 2) {
      if (arrow === "end" || arrow === "both") head(pts[pts.length - 1], pts[pts.length - 2]);
      if (arrow === "start" || arrow === "both") head(pts[0], pts[1]);
    }
    if (e.text && pts.length >= 2) {
      const a = pts[Math.floor((pts.length - 1) / 2)];
      const z = pts[Math.ceil((pts.length - 1) / 2)];
      const [mx, my] = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
      const w = String(e.text).length * 8 + 12;
      g.append(s("rect", { x: mx - w / 2, y: my - 12, width: w, height: 22, fill: "#fff", rx: 4 }));
      const t = s("text", { x: mx, y: my + 4, "text-anchor": "middle", class: "conn-label" });
      t.textContent = e.text;
      g.append(t);
    }
    this.overlay.append(g);
  }

  #ink(e: El, pts?: number[][]) {
    if (!pts?.length) return;
    this.overlay.append(
      s("polyline", {
        "data-id": e.id,
        points: pts.map((p) => `${p[0]},${p[1]}`).join(" "),
        fill: "none",
        stroke: COLORS[e.color] ?? COLORS.red,
        "stroke-width": e.width ?? 3,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        ...(e.tool === "highlighter" ? { "stroke-opacity": 0.35 } : {}),
      }),
    );
  }

  // ---------- camera ----------

  #pan() {
    let drag: { x: number; y: number; cx: number; cy: number } | undefined;
    this.root.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = this.root.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) {
        const [wx, wy] = this.toWorld(ev.clientX, ev.clientY);
        const zoom = Math.min(4, Math.max(0.1, this.camera.zoom * Math.exp(-ev.deltaY / 300)));
        this.camera = { zoom, x: wx - (ev.clientX - r.left) / zoom, y: wy - (ev.clientY - r.top) / zoom };
      } else this.camera = { ...this.camera, x: this.camera.x + ev.deltaX / this.camera.zoom, y: this.camera.y + ev.deltaY / this.camera.zoom };
      this.apply();
    }, { passive: false });
    this.root.addEventListener("pointerdown", (ev) => {
      if (!this.panning(ev)) return;
      drag = { x: ev.clientX, y: ev.clientY, cx: this.camera.x, cy: this.camera.y };
      this.root.setPointerCapture(ev.pointerId);
    });
    this.root.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      this.camera = { ...this.camera, x: drag.cx - (ev.clientX - drag.x) / this.camera.zoom, y: drag.cy - (ev.clientY - drag.y) / this.camera.zoom };
      this.apply();
    });
    const end = () => (drag = undefined);
    this.root.addEventListener("pointerup", end);
    this.root.addEventListener("pointercancel", end);
  }

  /** Whether a pointer press pans the camera. The dev playground draws instead when its pen is on. */
  panning: (ev: PointerEvent) => boolean = () => true;

  apply() {
    const { x, y, zoom } = this.camera;
    this.world.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
  }

  /** Fits the camera to bounds, with a margin. */
  fit(b: Bounds) {
    const r = this.root.getBoundingClientRect();
    const zoom = Math.min(2, Math.max(0.1, Math.min((r.width - 80) / Math.max(1, b[2]), (r.height - 80) / Math.max(1, b[3]))));
    this.camera = { zoom, x: b[0] + b[2] / 2 - r.width / 2 / zoom, y: b[1] + b[3] / 2 - r.height / 2 / zoom };
    this.apply();
  }

  toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.root.getBoundingClientRect();
    return [this.camera.x + (clientX - r.left) / this.camera.zoom, this.camera.y + (clientY - r.top) / this.camera.zoom];
  }

  /** The world bounds on screen now. */
  visible(): Bounds {
    const r = this.root.getBoundingClientRect();
    return [Math.round(this.camera.x), Math.round(this.camera.y), Math.round(r.width / this.camera.zoom), Math.round(r.height / this.camera.zoom)];
  }

  /** Forgets the drawn nodes of Elements that match, so the next update builds them again. */
  invalidate(match: (e: El) => boolean) {
    for (const e of this.elements) {
      const n = this.#nodes.get(e.id);
      if (n && match(e)) n.sig = "";
    }
  }

  /** The DOM node drawing an Element, if it has one. */
  nodeOf(id: string): HTMLElement | undefined {
    return this.#nodes.get(id)?.node;
  }
}

/** The bounds around a list of Elements. */
export function extent(elements: El[]): Bounds | undefined {
  if (!elements.length) return undefined;
  const x0 = Math.min(...elements.map((e) => e.bounds[0]));
  const y0 = Math.min(...elements.map((e) => e.bounds[1]));
  const x1 = Math.max(...elements.map((e) => e.bounds[0] + e.bounds[2]));
  const y1 = Math.max(...elements.map((e) => e.bounds[1] + e.bounds[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}
