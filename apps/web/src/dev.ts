// The `reflex dev` playground: the web viewer on the dev server's in-memory
// Space, plus three panes. Draw with the mouse (dev mode only), press Send,
// and see the Send Bundle the Agent would get, with each Embed's Anchors.
import { Connection } from "./conn.ts";
import { LiveSpace } from "./live.ts";
import type { Bounds } from "./render.ts";

const key = new URLSearchParams(location.hash.slice(1)).get("k") ?? sessionStorage.getItem("reflex-key") ?? "";
if (key) sessionStorage.setItem("reflex-key", key);
history.replaceState(null, "", location.pathname);

const $ = (id: string) => document.getElementById(id)!;
const conn = new Connection(key);
const canvas = $("canvas");
const live = new LiveSpace(conn, canvas);
live.show("dev");

type Problem = { level: string; code: string; msg: string; fix: string; where?: string };
type DevState = {
  extension: { kind: string; name: string; path: string } | null;
  load_error: { msg: string; fix: string } | null;
  checks: Problem[];
  lints: { id?: string; code: string; msg: string; fix: string }[];
  params: unknown;
  reads: { call: string; args: unknown; result: Record<string, unknown> }[];
  last: (Send & { strokes: number[][][] }) | null;
  examples: string[];
};
type Send = { bundle: Record<string, any>; images: string[]; anchors: { mark?: string; element: string; anchor: unknown }[]; adapter?: { result: unknown; requests: unknown[]; logs: string[]; error?: string } };

const el = (tag: string, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const pre = (v: unknown) => el("pre", undefined, typeof v === "string" ? v : JSON.stringify(v, null, 2));
const toast = (msg: string) => {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  setTimeout(() => t.classList.remove("on"), 2600);
};
const api = async (path: string, body?: unknown) => {
  const r = await conn.api(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.errors?.[0]?.msg ?? j.reason ?? `HTTP ${r.status}`);
  return j;
};

// ---------- panes ----------

for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button"))
  b.onclick = () => {
    for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
    for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === `pane-${b.dataset.pane}`);
  };
const showPane = (name: string) => document.querySelector<HTMLButtonElement>(`.tabs button[data-pane="${name}"]`)?.click();

function problem(p: { level?: string; code: string; msg: string; fix: string; where?: string; id?: string }) {
  const n = el("div", `problem ${p.level ?? "warning"}`);
  n.append(el("div", undefined, `${p.code}${p.where ? ` (${p.where})` : p.id ? ` on ${p.id}` : ""}: ${p.msg}`), el("div", "fix", `Fix: ${p.fix}`));
  return n;
}

function renderReads(s: DevState) {
  const pane = $("pane-reads");
  pane.replaceChildren();
  if (s.load_error) pane.append(problem({ level: "error", code: "load_failed", msg: s.load_error.msg, fix: s.load_error.fix }));
  for (const r of s.reads) {
    pane.append(el("h3", undefined, `${r.call}(${r.call === "apply" ? "…" : JSON.stringify(r.args).slice(1, -1)})`));
    if (r.call === "read_me" && typeof r.result.text === "string") pane.append(pre(r.result.text));
    else pane.append(pre(r.call === "apply" ? { args: r.args, result: r.result } : r.result));
  }
}

function renderLints(s: DevState, last: Send | null) {
  const pane = $("pane-lints");
  pane.replaceChildren(el("h3", undefined, s.extension ? `Contract checks: ${s.extension.kind} ${s.extension.name}` : "Contract checks"));
  if (!s.extension) pane.append(el("p", "muted", "Start reflex dev with an extension's path (reflex dev ./my-recipe.md) to check it here."));
  else if (!s.checks.length) pane.append(problem({ level: "ok", code: "ok", msg: "Every check passes.", fix: "Nothing to fix." }));
  for (const p of s.checks) pane.append(problem(p));
  pane.append(el("h3", undefined, "Lints on the Space"));
  if (!s.lints.length) pane.append(el("p", "muted", "No lints."));
  for (const l of s.lints) pane.append(problem({ level: "warning", ...l }));
  pane.append(el("h3", undefined, "Anchors"));
  const embeds = live.view.elements.filter((e) => e.type === "embed");
  if (!embeds.length) pane.append(el("p", "muted", "No Embeds on the Space."));
  for (const e of embeds) pane.append(el("p", undefined, `${e.id}: ${live.embeds.hasAnchors(e.id) ? "registered an Anchor resolver" : "registered no Anchors yet (Marks on it report pixels only)"}`));
  if (last?.anchors.length) {
    pane.append(el("p", undefined, "From the last Send:"));
    pane.append(pre(last.anchors));
  }
  const errors = s.checks.filter((c) => c.level === "error").length;
  $("checks").textContent = s.extension ? `${errors} error${errors === 1 ? "" : "s"}, ${s.checks.length - errors} warning${s.checks.length - errors === 1 ? "" : "s"} · ${s.examples.length} saved example${s.examples.length === 1 ? "" : "s"}` : "";
}

function renderSend(send: Send | null) {
  const pane = $("pane-send");
  pane.replaceChildren();
  if (!send) return pane.append(el("p", "muted", "Draw on the canvas with the mouse (Pen on), then press Send."));
  const b = send.bundle;
  if (b.ok === false || !b.kind) return pane.append(el("h3", undefined, "Nothing was delivered"), pre(b));
  pane.append(el("h3", undefined, `The Send Bundle (${b.marks?.length ?? 0} Mark${b.marks?.length === 1 ? "" : "s"})`), pre(b));
  send.images.forEach((png, i) => {
    pane.append(el("h3", undefined, `Image ${i + 1}: ${b.images?.[i]?.shows ?? ""}`));
    const img = el("img", "bundle-img") as HTMLImageElement;
    img.src = `data:image/png;base64,${png}`;
    pane.append(img);
  });
  if (send.adapter) pane.append(el("h3", undefined, "What the adapter would send"), pre(send.adapter));
}

let state: DevState | undefined;
async function refresh() {
  state = (await api("/api/dev/state")) as DevState;
  $("title").textContent = state.extension ? `${state.extension.kind} ${state.extension.name}` : "empty Space";
  renderReads(state);
  renderLints(state, state.last);
  renderSend(state.last);
}

// ---------- drawing with the mouse ----------

let pen = true;
let stroke: number[][] | undefined;
let wet: SVGPolylineElement | undefined;
const drawn: { points: number[][] }[] = [];
live.view.panning = () => !pen;
$("pen").onclick = () => {
  pen = !pen;
  $("pen").classList.toggle("on", pen);
  canvas.classList.toggle("pen", pen);
};
canvas.addEventListener("pointerdown", (ev) => {
  if (!pen || ev.button !== 0) return;
  stroke = [live.view.toWorld(ev.clientX, ev.clientY)];
  wet = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  Object.entries({ fill: "none", stroke: "#e5484d", "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }).forEach(([k, v]) => wet!.setAttribute(k, String(v)));
  live.view.overlay.append(wet);
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener("pointermove", (ev) => {
  if (!stroke || !wet) return;
  const p = live.view.toWorld(ev.clientX, ev.clientY);
  const q = stroke[stroke.length - 1];
  if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 3 / live.view.camera.zoom) return;
  stroke.push(p);
  wet.setAttribute("points", stroke.map((x) => x.join(",")).join(" "));
});
const finish = async () => {
  const s = stroke;
  stroke = undefined;
  if (!s || s.length < 2) return wet?.remove();
  drawn.push({ points: s });
  try {
    await api("/api/dev/stroke", { points: s });
  } catch (e) {
    toast((e as Error).message);
  }
};
canvas.addEventListener("pointerup", () => void finish());
canvas.addEventListener("pointercancel", () => void finish());

// ---------- Send ----------

const box = (pts: number[][]): Bounds => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(1, Math.max(...xs) - Math.min(...xs)), Math.max(1, Math.max(...ys) - Math.min(...ys))];
};
const overlaps = (a: Bounds, b: Bounds) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

$("send").onclick = async () => {
  // Ask every Embed a stroke touches what the stroke points at, in the Embed's own pixels.
  const anchors: { element: string; strokes: number; anchor: unknown; bounds: Bounds }[] = [];
  for (const [i, d] of drawn.entries()) {
    const b = box(d.points);
    for (const e of live.view.elements.filter((x) => x.type === "embed" && overlaps(x.bounds, b))) {
      const [ex, ey] = e.bounds;
      const local = { points: d.points.map(([x, y]) => [Math.round(x - ex), Math.round(y - ey)]), bounds: [Math.round(b[0] - ex), Math.round(b[1] - ey), Math.round(b[2]), Math.round(b[3])] as Bounds };
      const anchor = await live.embeds.resolve(e.id, local);
      anchors.push({ element: e.id, strokes: i, anchor, bounds: b });
    }
  }
  try {
    const said = ($("said") as HTMLInputElement).value.trim();
    const r = (await api("/api/dev/send", { said, anchors })) as Send;
    drawn.length = 0;
    renderSend(r);
    if (state) renderLints(state, r);
    showPane("send");
    toast(r.bundle.kind ? `Sent ${r.bundle.send}: ${r.bundle.marks.length} Mark${r.bundle.marks.length === 1 ? "" : "s"}` : "Nothing new to send");
    void refresh();
  } catch (e) {
    toast((e as Error).message);
  }
};
$("save").onclick = async () => {
  try {
    const r = await api("/api/dev/example", {});
    toast(`Saved ${r.file.split("/").slice(-2).join("/")}`);
    void refresh();
  } catch (e) {
    toast((e as Error).message);
  }
};
$("reset").onclick = () => void api("/api/dev/reset", {}).catch((e) => toast((e as Error).message));

// ---------- hot reload ----------

conn.onStatus((s) => {
  $("status").textContent = s === "live" ? "Live" : s === "connecting" ? "Connecting…" : s === "bad_key" ? "Key not accepted: reopen the address reflex dev printed" : "Offline, retrying";
  $("status").className = `status ${s === "bad_key" ? "offline" : s}`;
});
let first = true;
conn.on(({ event }) => {
  // A new Space after a reload or reset: start from a fresh page, so no old replica merges into it.
  if (event.t === "reload") location.reload();
  if (event.t === "hello" && first) {
    first = false;
    void refresh();
  }
});
live.onDraw(() => state && renderLints(state, state.last));
if (key) void conn.run();
else $("canvas").textContent = "Open the playground from the address reflex dev printed (it carries the key).";
