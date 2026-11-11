// The web viewer (SPEC §3): opens a Space from the Link and draws it, live.
// The Link prints this page's address, with its key, in its own terminal.
import { Connection } from "./conn.ts";
import { LiveSpace } from "./live.ts";

const key = new URLSearchParams(location.hash.slice(1)).get("k") ?? sessionStorage.getItem("reflex-key") ?? "";
if (key) {
  sessionStorage.setItem("reflex-key", key);
  history.replaceState(null, "", location.pathname + location.search); // keep the key out of the address bar
}

const $ = (id: string) => document.getElementById(id)!;
const conn = new Connection(key);
const live = new LiveSpace(conn, $("canvas"));
const list = $("spaces");
const status = $("status");

const want = () => new URLSearchParams(location.search).get("space");

function spaces() {
  const ids = [...conn.replicas.entries()].filter(([, r]) => r.kind === "space").map(([id]) => id);
  list.replaceChildren(
    ...ids.map((id) => {
      const b = document.createElement("button");
      b.textContent = id;
      b.className = id === live.space ? "space on" : "space";
      b.onclick = () => {
        history.replaceState(null, "", `?space=${encodeURIComponent(id)}`);
        open(id);
      };
      return b;
    }),
  );
  if (!ids.length) list.textContent = "No Spaces yet. An Agent creates one with open_space.";
  return ids;
}

function open(id: string) {
  live.show(id);
  drawHere();
  $("title").textContent = id;
  document.title = `${id} · Reflex`;
  spaces();
}

conn.onStatus((s) => {
  status.textContent = s === "live" ? "Live" : s === "connecting" ? "Connecting…" : key ? "Offline, retrying" : "No key";
  status.className = `status ${s}`;
});
conn.on(({ event }) => {
  if (event.t !== "hello") return;
  const ids = spaces();
  const id = want() && ids.includes(want()!) ? want()! : live.space || ids[0];
  if (id) open(id);
});
live.onDraw((els) => {
  $("count").textContent = `${els.length} Element${els.length === 1 ? "" : "s"}`;
  drawHere();
});

// Who else is here: each device in a Space, with its person's name, cursor and selection (link/here.ts).
// Short-lived: never part of the Space.
type Here = { device: string; space: string; person: { id: string; name: string }; name: string; cursor: [number, number] | null; selection: string[]; at: number };
const here = new Map<string, Here>();
const PALETTE = ["#7c3aed", "#0d9488", "#2563eb", "#ea580c", "#db2777", "#16a34a"];
const colorOf = (person: string) => PALETTE[[...person].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const layer = document.createElement("div");
layer.className = "cursors";
live.view.world.append(layer);

conn.on(({ event }) => {
  if (event.t !== "here") return;
  const e = event as unknown as Here & { gone?: boolean };
  if (e.gone) here.delete(e.device);
  else here.set(e.device, { ...e, at: Date.now() });
  drawHere();
});

function drawHere() {
  const now = [...here.values()].filter((h) => h.space === live.space);
  const people = new Map(now.map((h) => [h.person.id, h.person.name || h.person.id]));
  $("here").replaceChildren(
    ...[...people].map(([id, name]) => {
      const b = document.createElement("span");
      b.className = "who";
      b.style.background = colorOf(id);
      b.textContent = name;
      b.title = now.filter((h) => h.person.id === id).map((h) => h.name).join(", ");
      return b;
    }),
  );
  const byId = new Map(live.view.elements.map((e) => [e.id, e]));
  const zoom = live.view.camera.zoom || 1;
  layer.replaceChildren(
    ...now.flatMap((h) => {
      const color = colorOf(h.person.id);
      const out: HTMLElement[] = [];
      for (const id of h.selection) {
        const b = (byId.get(id) as { bounds?: number[] } | undefined)?.bounds;
        if (!b) continue;
        const r = document.createElement("div");
        r.className = "picked";
        Object.assign(r.style, { left: `${b[0] - 4}px`, top: `${b[1] - 4}px`, width: `${b[2] + 8}px`, height: `${b[3] + 8}px`, borderColor: color });
        out.push(r);
      }
      if (h.cursor) {
        const c = document.createElement("div");
        c.className = "cursor";
        // Constant size on screen, whatever the zoom.
        Object.assign(c.style, { left: `${h.cursor[0]}px`, top: `${h.cursor[1]}px`, transform: `scale(${1 / zoom})` });
        c.innerHTML = `<div class="dot" style="background:${color}"></div><div class="label" style="background:${color}"></div>`;
        (c.lastChild as HTMLElement).textContent = h.person.name || h.person.id;
        out.push(c);
      }
      return out;
    }),
  );
}

if (!key) {
  status.textContent = "No key";
  $("canvas").textContent = "Open the web viewer from the address the Link printed in its terminal (it carries the viewer key).";
} else void conn.run();
