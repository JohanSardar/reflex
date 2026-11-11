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
live.onDraw((els) => ($("count").textContent = `${els.length} Element${els.length === 1 ? "" : "s"}`));

if (!key) {
  status.textContent = "No key";
  $("canvas").textContent = "Open the web viewer from the address the Link printed in its terminal (it carries the viewer key).";
} else void conn.run();
