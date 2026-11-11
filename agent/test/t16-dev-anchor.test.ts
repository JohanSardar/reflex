// T16: an Anchor an Embed answered for a Mark has to reach the Agent, in `reflex dev` too.
//
// The playground page asks each Embed what the stroke drawn on it points at and posts
// `{element, strokes: <index>, anchor, bounds}` to `/api/dev/send` (apps/web/src/dev.ts).
// The kernel joins an answer to the Mark by the stroke IDs it names
// (kernel/core/src/marks.rs, `embed_anchors` → the Mark's `target`), so an answer with no
// stroke IDs is dropped: the Agent gets a Mark that names nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dev } from "../src/author/dev.ts";

test("reflex dev's Send keeps the Anchor the Embed answered for the Mark drawn on it", async () => {
  let d: Awaited<ReturnType<typeof dev>> | undefined;
  try {
    d = await dev({ path: new URL("../../extensions/embeds/chart", import.meta.url).pathname, port: 0, open: false, log: () => {} });
    const base = d.url.split("/#")[0];
    const key = /k=([^&]+)/.exec(d.url)![1];
    const call = async (p: string, body?: unknown) => {
      const r = await fetch(`${base}${p}`, { method: body === undefined ? "GET" : "POST", headers: { "x-reflex-key": key, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(r.status, 200, `POST ${p} answered ${r.status}`);
      return r.json();
    };
    // The person circles a bar of the chart with the mouse (one closed stroke).
    const pts: number[][] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i * Math.PI * 2) / 40;
      pts.push([Math.round(70 + 18 * Math.cos(a)), Math.round(140 + 40 * Math.sin(a))]);
    }
    await call("/api/dev/stroke", { points: pts });
    // What the page posts once the Embed answered (dev.ts: anchors.push({element, strokes: i, anchor, bounds})).
    await call("/api/dev/send", { said: "", anchors: [{ element: "a_dev:embed-1", strokes: 0, anchor: { kind: "data", rows: ["2024-Q1"], label: "bar 2024-Q1" }, bounds: [52, 100, 36, 80] }] });
    const s = (await call("/api/dev/state")) as any;
    const mark = s.last?.bundle?.marks?.[0];
    assert.ok(mark, `the Send has no Marks: ${JSON.stringify(s.last?.bundle)}`);
    assert.deepEqual(mark.target, { kind: "data", rows: ["2024-Q1"], label: "bar 2024-Q1" }, `the Mark carries no target, so the Agent cannot tell what the person circled: ${JSON.stringify(mark)}`);
  } finally {
    await d?.close();
  }
});
