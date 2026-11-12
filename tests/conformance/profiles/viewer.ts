// The viewer profile: a client that shows Spaces and changes none (SPEC §3, the web
// viewer; an Android or Vision Pro viewer the same way). The runner is the host: it
// serves the viewer API (protocol/spec/transports.md §7) with the 13 scenario Spaces,
// and the implementation connects to it.
//
// Driver requests:
//   open   {url, key, space}  connect to the viewer API at url with the viewer key, and show space
//   drawn  {space}            → {ids}: the Element IDs it draws for that Space now
//   status {}                 → {status}: live, connecting, offline or bad_key
import { serveWeb } from "../../../agent/src/web/server.ts";
import type { Driver } from "../lib/driver.ts";
import { AGENT, stored, T0 } from "../lib/fixtures.ts";
import { hostSpaces, until } from "../lib/host.ts";
import type { Report } from "../lib/report.ts";
import { invalidMessage } from "../lib/schemas.ts";

export async function run(d: Driver, report: Report): Promise<void> {
  const spaces = hostSpaces();
  const listeners: ((space: string) => void)[] = [];
  const refused: string[] = [];
  let posts = 0;
  const events: string[] = [];
  const web = await serveWeb({
    port: 0,
    page: "index.html",
    source: {
      person: { id: "p_4c1e9a7b2d30", name: "Ana" },
      names: () => ({ [AGENT]: "Claude", p_4c1e9a7b2d30: "Ana" }),
      spaces: () => [...spaces.keys()].map((id) => ({ id, kind: "space" })),
      read: (space, fn) => fn(spaces.get(space)!.space),
      receive: (space, peer, bytes) => {
        posts++;
        // The host takes nobody's changes from a viewer (protocol/spec/membership.md §4).
        const r = JSON.parse(spaces.get(space)!.space.receiveSyncMessageChecked(peer, bytes, JSON.stringify({ people: [] })));
        if (!r.ok) refused.push(`${space}: ${JSON.stringify(r.errors)}`);
        return r;
      },
      onChange: (fn) => listeners.push(fn),
    },
    log: (m) => events.push(m),
  });
  try {
    // Every event the host sends is a Protocol v1 viewer event.
    await report.run("the host's events are viewer events (schema check of the reference host)", async () => {
      const res = await fetch(`http://127.0.0.1:${web.port}/api/events?peer=schemacheck`, { headers: { "x-reflex-key": web.key } });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      const out: string[] = [];
      const end = Date.now() + 1500;
      while (Date.now() < end && buf.split("\n").length < spaces.size + 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
      }
      await reader.cancel();
      for (const line of buf.split("\n").filter(Boolean)) out.push(...invalidMessage("viewer", JSON.parse(line)));
      return out;
    });

    const url = `http://127.0.0.1:${web.port}`;
    for (const [id, { scenario }] of spaces) {
      await report.run(`shows ${scenario.file}`, async () => {
        await d.call("open", { url, key: web.key, space: id }, 60_000);
        const want = scenario.elements.map(stored);
        return until(20_000, async () => {
          const { ids } = await d.call<{ ids: string[] }>("drawn", { space: id });
          const missing = want.filter((w) => !ids.includes(w));
          return missing.length ? [`not drawn: ${missing.join(", ")} (drew ${ids.join(", ") || "nothing"})`] : [];
        });
      });
    }

    await report.run("draws a change made while it watches", async () => {
      const [id, { space }] = [...spaces][0];
      await d.call("open", { url, key: web.key, space: id });
      const r = JSON.parse(space.applyAgentBatch(AGENT, "live-1", JSON.stringify({ ops: [{ op: "add", id: "n-live", type: "note", text: "Added while you watch", at: { x: 900, y: 400 } }] }), T0 + 60_000));
      if (!r.ok) return [`the runner could not add the Element: ${JSON.stringify(r.errors)}`];
      for (const l of listeners) l(id);
      return until(10_000, async () => ((await d.call<{ ids: string[] }>("drawn", { space: id })).ids.includes(stored("n-live")) ? [] : ["the new Element was not drawn"]));
    });

    await report.run("answers the host's sync messages and changes nothing", async () => {
      const out: string[] = [];
      if (!posts) out.push("it never POSTed a sync reply to /api/sync");
      out.push(...refused.map((r) => `the host refused a change from the viewer: ${r}`));
      return out;
    });

    await report.run("stops on a refused viewer key", async () => {
      await d.call("open", { url, key: "not-the-key", space: [...spaces.keys()][0] });
      return until(10_000, async () => {
        const { status } = await d.call<{ status: string }>("status");
        return status === "bad_key" ? [] : [`status is ${status}, expected bad_key`];
      });
    });
  } finally {
    await web.close();
  }
}
