// `look` renders through this interface. The basic renderer here draws scene
// Elements as SVG and rasterizes them with resvg; the full headless renderer
// (shared with the native look) is T8.
import { Resvg } from "@resvg/resvg-js";
import type { Bounds } from "./store.ts";

export type SceneElement = Record<string, any> & { id: string; type: string; bounds: Bounds };
export type RenderRequest = {
  elements: SceneElement[];
  /** Raw Ink points by Element ID: [x, y, t, pressure]. */
  strokes: Record<string, number[][]>;
  bounds: Bounds;
  width: number;
};
export interface Renderer {
  render(req: RenderRequest): { png: Buffer; px: [number, number] };
}

const COLORS: Record<string, string> = {
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap by an approximate glyph width. */
function wrap(text: string, width: number, size: number): string[] {
  const max = Math.max(4, Math.floor(width / (size * 0.56)));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if ((line + " " + word).trim().length > max && line) {
        out.push(line);
        line = word;
      } else line = (line + " " + word).trim();
    }
    out.push(line);
  }
  return out;
}

function textBlock(text: string, b: Bounds, size: number, color: string, center: boolean): string {
  const lines = wrap(text, b[2] - 12, size);
  const lh = size * 1.25;
  const top = center ? b[1] + b[3] / 2 - (lines.length * lh) / 2 + size * 0.85 : b[1] + 6 + size * 0.9;
  const x = center ? b[0] + b[2] / 2 : b[0] + 6;
  return lines
    .map((l, i) => `<text x="${x}" y="${top + i * lh}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="${color}"${center ? ' text-anchor="middle"' : ""}>${esc(l)}</text>`)
    .join("");
}

const center = (b: Bounds): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/** Where the line from a box's center towards p leaves the box. */
function edge(b: Bounds, p: [number, number]): [number, number] {
  const [cx, cy] = center(b);
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Infinity : b[2] / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b[3] / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

function dash(stroke: string | undefined) {
  return stroke === "dashed" ? ' stroke-dasharray="10 6"' : stroke === "dotted" ? ' stroke-dasharray="2 5"' : "";
}

function shapePath(shape: string, b: Bounds, attrs: string): string {
  const [x, y, w, h] = b;
  switch (shape) {
    case "ellipse":
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"${attrs}/>`;
    case "diamond":
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"${attrs}/>`;
    case "triangle":
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}"${attrs}/>`;
    case "hexagon": {
      const q = w / 4;
      return `<polygon points="${x + q},${y} ${x + w - q},${y} ${x + w},${y + h / 2} ${x + w - q},${y + h} ${x + q},${y + h} ${x},${y + h / 2}"${attrs}/>`;
    }
    case "rounded":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(18, h / 3)}"${attrs}/>`;
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"${attrs}/>`;
  }
}

function elementSvg(e: SceneElement, byId: Map<string, SceneElement>, strokes: RenderRequest["strokes"]): string {
  const b = e.bounds;
  const color = COLORS[e.color] ?? COLORS.black;
  switch (e.type) {
    case "shape": {
      const fill = e.fill === "solid" ? (COLORS[e.color] ?? COLORS.blue) : e.fill === "tint" ? (TINT[e.color] ?? TINT.blue) : "#ffffff";
      const ink = e.fill === "solid" ? "#ffffff" : COLORS.black;
      return shapePath(e.shape, b, ` fill="${fill}" stroke="${color}" stroke-width="2.5"${dash(e.stroke)}`) + (e.text ? textBlock(e.text, b, 18, ink, true) : "");
    }
    case "note":
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="${TINT[e.color] ?? TINT.yellow}" stroke="${COLORS[e.color] ?? COLORS.yellow}" stroke-width="1.5"/>` + textBlock(e.text ?? "", b, 17, COLORS.black, false);
    case "text": {
      const text = e.markdown ? String(e.text).replace(/^#+\s*/gm, "").replace(/\*\*/g, "") : e.text;
      return textBlock(text ?? "", b, SIZES[e.size] ?? 18, color, e.align === "middle");
    }
    case "math":
      return `<text x="${b[0] + 4}" y="${b[1] + b[3] / 2 + 7}" font-family="Times New Roman, serif" font-style="italic" font-size="${SIZES[e.size] ?? 22}" fill="${color}">${esc(e.latex ?? "")}</text>`;
    case "connector": {
      let pts: [number, number][];
      const from = e.from && byId.get(e.from);
      const to = e.to && byId.get(e.to);
      if (from && to) pts = [edge(from.bounds, center(to.bounds)), edge(to.bounds, center(from.bounds))];
      else if (Array.isArray(e.points)) pts = e.points;
      else pts = [[b[0], b[1]], [b[0] + b[2], b[1] + b[3]]];
      const arrow = e.arrow ?? "end";
      const markers = `${arrow === "end" || arrow === "both" ? ' marker-end="url(#arrow)"' : ""}${arrow === "start" || arrow === "both" ? ' marker-start="url(#arrow)"' : ""}`;
      const line = `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"${dash(e.stroke)}${markers}/>`;
      if (!e.text) return line;
      const mid = pts[Math.floor((pts.length - 1) / 2)];
      const end = pts[Math.ceil((pts.length - 1) / 2)];
      const [mx, my] = [(mid[0] + end[0]) / 2, (mid[1] + end[1]) / 2];
      const w = e.text.length * 8 + 12;
      return line + `<rect x="${mx - w / 2}" y="${my - 12}" width="${w}" height="22" fill="#ffffff"/><text x="${mx}" y="${my + 4}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="${COLORS.black}">${esc(e.text)}</text>`;
    }
    case "ink": {
      const pts = strokes[e.id];
      if (!pts?.length) return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="none" stroke="${COLORS.red}" stroke-dasharray="3 3"/>`;
      return `<polyline points="${pts.map((p) => `${p[0]},${p[1]}`).join(" ")}" fill="none" stroke="${COLORS[e.color] ?? COLORS.red}" stroke-width="${e.width ?? 3}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case "frame":
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="none" stroke="${COLORS.grey}" stroke-width="1.5" rx="6"/>` + (e.title ? `<text x="${b[0]}" y="${b[1] - 8}" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="${COLORS.grey}">${esc(e.title)}</text>` : "");
    case "region": {
      const btn = e.send_button ? `<rect x="${b[0] + b[2] - 150}" y="${b[1] + b[3] - 44}" width="140" height="34" rx="17" fill="${COLORS.blue}"/><text x="${b[0] + b[2] - 80}" y="${b[1] + b[3] - 22}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#ffffff">${esc(e.send_button)}</text>` : "";
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="${TINT.blue}" fill-opacity="0.35" stroke="${COLORS.blue}" stroke-dasharray="8 6" rx="8"/>` + (e.title ? textBlock(e.title, b, 15, COLORS.blue, false) : "") + btn;
    }
    case "image":
    case "embed":
    case "file":
    default: {
      const label = e.type === "image" ? `image${e.alt ? `: ${e.alt}` : ""}` : e.type === "embed" ? `embed: ${e.template ?? e.url ?? "html"}` : e.type === "file" ? `file: ${e.name}` : `${e.type}`;
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="#f4f4f6" stroke="${COLORS.grey}" stroke-dasharray="6 4"/>` + textBlock(label, b, 15, COLORS.grey, true);
    }
  }
}

/** Draw order: containers first, then shapes and text, then connectors, then Ink on top. */
const LAYER: Record<string, number> = { region: 0, frame: 1, image: 2, embed: 2, file: 2, connector: 4, ink: 5 };

export class SvgRenderer implements Renderer {
  render({ elements, strokes, bounds, width }: RenderRequest) {
    const [x, y, w, h] = bounds;
    const pxW = Math.max(1, Math.min(4096, Math.round(width)));
    const pxH = Math.max(1, Math.min(4096, Math.round((pxW * h) / Math.max(1, w))));
    const byId = new Map(elements.map((e) => [e.id, e]));
    const body = [...elements]
      .sort((a, b) => (LAYER[a.type] ?? 3) - (LAYER[b.type] ?? 3))
      .map((e) => elementSvg(e, byId, strokes))
      .join("\n");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${pxW}" height="${pxH}">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLORS.black}"/></marker></defs>
<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fbfbfa"/>
${body}
</svg>`;
    const png = new Resvg(svg, { fitTo: { mode: "width", value: pxW }, font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();
    return { png: Buffer.from(png), px: [pxW, pxH] as [number, number] };
  }
}
