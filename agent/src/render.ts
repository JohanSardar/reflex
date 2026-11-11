// `look` renders through this interface, on the Link with no iPad attached:
// scene Elements are drawn as SVG and rasterized with resvg. Pictures the
// person added are drawn from the asset store, Ink follows its pressure, and
// Markdown keeps its headings and lists.
import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import type { Bounds } from "./store.ts";

// Scanning every system font costs about a second per render, so load only the faces the SVG names
// when they are where macOS or a common Linux keeps them, and fall back to the full scan otherwise.
const FONT_FILES = [
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf",
].filter((f) => existsSync(f));
const FONT = FONT_FILES.length
  ? { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: FONT_FILES[0].includes("dejavu") ? "DejaVu Sans" : "Helvetica" }
  : { loadSystemFonts: true, defaultFontFamily: "Helvetica" };

export type SceneElement = Record<string, any> & { id: string; type: string; bounds: Bounds };
export type RenderRequest = {
  elements: SceneElement[];
  /** Raw Ink points by Element ID: [x, y, t, pressure]. */
  strokes: Record<string, number[][]>;
  bounds: Bounds;
  width: number;
  /** The bytes behind an `asset:<hash>` image source, when this Link has them. */
  asset?: (hash: string) => Buffer | undefined;
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

/**
 * An arrowhead at `pts[tip]`, pointing away from `pts[from]`, as a plain polygon. It also pulls the
 * line's end back under the head so the line doesn't poke through its tip. SVG markers aren't used:
 * resvg panics (and takes the process down) on a marker placed outside the image.
 */
function arrowHead(pts: [number, number][], tip: number, from: number, color: string): string {
  const [tx, ty] = pts[tip];
  const [fx, fy] = pts[from] ?? pts[tip];
  const len = Math.hypot(tx - fx, ty - fy);
  if (!(len > 0)) return "";
  const [ux, uy] = [(tx - fx) / len, (ty - fy) / len];
  const [l, hw] = [16, 7];
  const [bx, by] = [tx - ux * l, ty - uy * l];
  const back = Math.min(len, l / 2);
  pts[tip] = [tx - ux * back, ty - uy * back];
  return `<polygon points="${tx},${ty} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}" fill="${color}"/>`;
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

const IMAGE_MIME = (b: Buffer) =>
  b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b.subarray(0, 4).toString() === "GIF8" ? "image/gif" : b.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined;

/** Markdown as lines of SVG text: headings larger and bold, list items with bullets, emphasis marks dropped. */
function markdownBlock(md: string, b: Bounds, size: number, color: string): string {
  const out: string[] = [];
  let y = b[1] + 6;
  for (const raw of md.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    const li = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(raw);
    const fs = h ? Math.round(size * (h[1].length === 1 ? 1.6 : h[1].length === 2 ? 1.35 : 1.15)) : size;
    const text = (h ? h[2] : li ? `• ${li[1]}` : raw).replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const x = b[0] + 6 + (li ? 12 : 0);
    for (const l of wrap(text, b[2] - 12 - (li ? 12 : 0), fs)) {
      y += fs * 1.25;
      if (y > b[1] + b[3] + fs) break;
      out.push(`<text x="${x}" y="${y - fs * 0.3}" font-family="Helvetica, Arial, sans-serif" font-size="${fs}"${h ? ' font-weight="bold"' : ""} fill="${color}">${esc(l)}</text>`);
    }
    if (!raw.trim()) y += size * 0.4;
  }
  return out.join("");
}

/** A stroke whose width follows its pressure, as short segments. */
function inkSvg(pts: number[][], color: string, width: number): string {
  if (pts.length < 2 || !pts.some((p) => typeof p[3] === "number" && p[3] > 0)) {
    return `<polyline points="${pts.map((p) => `${p[0]},${p[1]}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const segs: string[] = [];
  for (let i = 1; i < pts.length; i++) {
    const p = ((pts[i - 1][3] ?? 0.5) + (pts[i][3] ?? 0.5)) / 2;
    const w = Math.max(0.6, width * (0.4 + 1.2 * Math.min(1, Math.max(0, p))));
    segs.push(`<line x1="${pts[i - 1][0]}" y1="${pts[i - 1][1]}" x2="${pts[i][0]}" y2="${pts[i][1]}" stroke-width="${w.toFixed(2)}"/>`);
  }
  return `<g stroke="${color}" stroke-linecap="round" fill="none">${segs.join("")}</g>`;
}

function elementSvg(e: SceneElement, byId: Map<string, SceneElement>, strokes: RenderRequest["strokes"], asset?: RenderRequest["asset"]): string {
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
      if (e.markdown) return markdownBlock(String(e.text ?? ""), b, SIZES[e.size] ?? 18, color);
      return textBlock(e.text ?? "", b, SIZES[e.size] ?? 18, color, e.align === "middle");
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
      const heads: string[] = [];
      const line_ = pts.map((p) => [...p] as [number, number]);
      if (arrow === "end" || arrow === "both") heads.push(arrowHead(line_, line_.length - 1, line_.length - 2, color));
      if (arrow === "start" || arrow === "both") heads.push(arrowHead(line_, 0, 1, color));
      const line =
        `<polyline points="${line_.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"${dash(e.stroke)}/>` + heads.join("");
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
      return inkSvg(pts, COLORS[e.color] ?? COLORS.red, e.width ?? 3);
    }
    case "frame":
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="none" stroke="${COLORS.grey}" stroke-width="1.5" rx="6"/>` + (e.title ? `<text x="${b[0]}" y="${b[1] - 8}" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="${COLORS.grey}">${esc(e.title)}</text>` : "");
    case "region": {
      const btn = e.send_button ? `<rect x="${b[0] + b[2] - 150}" y="${b[1] + b[3] - 44}" width="140" height="34" rx="17" fill="${COLORS.blue}"/><text x="${b[0] + b[2] - 80}" y="${b[1] + b[3] - 22}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#ffffff">${esc(e.send_button)}</text>` : "";
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="${TINT.blue}" fill-opacity="0.35" stroke="${COLORS.blue}" stroke-dasharray="8 6" rx="8"/>` + (e.title ? textBlock(e.title, b, 15, COLORS.blue, false) : "") + btn;
    }
    case "image": {
      const hash = typeof e.src === "string" && e.src.startsWith("asset:") ? e.src.slice(6) : undefined;
      const bytes = hash ? asset?.(hash) : undefined;
      const mime = bytes && IMAGE_MIME(bytes);
      if (bytes && mime) return `<image x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${bytes.toString("base64")}"/>`;
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="#f4f4f6" stroke="${COLORS.grey}" stroke-dasharray="6 4"/>` + textBlock(`image${e.alt ? `: ${e.alt}` : ""}`, b, 15, COLORS.grey, true);
    }
    case "file": {
      const kb = typeof e.size === "number" ? (e.size >= 1e6 ? `${(e.size / 1e6).toFixed(1)} MB` : e.size >= 1e3 ? `${Math.round(e.size / 1e3)} KB` : `${e.size} bytes`) : "";
      const ext = String(e.name ?? "").split(".").pop()?.toUpperCase().slice(0, 4) ?? "";
      return (
        `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" rx="10" fill="#ffffff" stroke="${COLORS.grey}" stroke-width="1.5"/>` +
        `<rect x="${b[0] + 12}" y="${b[1] + 12}" width="40" height="${Math.max(20, Math.min(52, b[3] - 24))}" rx="4" fill="${TINT.blue}" stroke="${COLORS.blue}"/>` +
        `<text x="${b[0] + 32}" y="${b[1] + 12 + Math.max(20, Math.min(52, b[3] - 24)) / 2 + 4}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="${COLORS.blue}">${esc(ext)}</text>` +
        textBlock([e.name ?? "file", [e.mime, kb].filter(Boolean).join(", ")].filter(Boolean).join("\n"), [b[0] + 56, b[1], b[2] - 60, b[3]], 15, COLORS.black, false)
      );
    }
    case "embed":
    default: {
      const label = e.type === "embed" ? `embed: ${e.template ?? e.url ?? "html"}` : `${e.type}`;
      return `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="#f4f4f6" stroke="${COLORS.grey}" stroke-dasharray="6 4"/>` + textBlock(label, b, 15, COLORS.grey, true);
    }
  }
}

/** Draw order: containers first, then shapes and text, then connectors, then Ink on top. */
const LAYER: Record<string, number> = { region: 0, frame: 1, image: 2, embed: 2, file: 2, connector: 4, ink: 5 };

export class SvgRenderer implements Renderer {
  render({ elements, strokes, bounds, width, asset }: RenderRequest) {
    const [x, y, w, h] = bounds;
    const pxW = Math.max(1, Math.min(4096, Math.round(width)));
    const pxH = Math.max(1, Math.min(4096, Math.round((pxW * h) / Math.max(1, w))));
    const byId = new Map(elements.map((e) => [e.id, e]));
    const body = [...elements]
      .sort((a, b) => (LAYER[a.type] ?? 3) - (LAYER[b.type] ?? 3))
      .map((e) => elementSvg(e, byId, strokes, asset))
      .join("\n");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${pxW}" height="${pxH}">
<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fbfbfa"/>
${body}
</svg>`;
    const png = new Resvg(svg, { fitTo: { mode: "width", value: pxW }, font: FONT }).render().asPng();
    return { png: Buffer.from(png), px: [pxW, pxH] as [number, number] };
  }
}
