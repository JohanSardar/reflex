// T20: an Embed Template's Anchor answer travels to the Agent as the Mark's `target`
// (kernel/core/src/marks.rs `embed_anchors` → `target`, protocol/schema/send-bundle.schema.json
// `mark.target` → `common.schema.json#/$defs/anchor`). The new templates in extensions/embeds
// answer with the fields their guides tell the Agent to read (document: paragraphs, sentences,
// quote, text, gesture: "strike"|"underline"), so the Bundle the Agent gets has to be a valid one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { dev } from "../src/author/dev.ts";

const schema = JSON.parse(readFileSync(new URL("../../protocol/generated/send-bundle.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

test("a Send from the document Embed is a valid Send Bundle", async () => {
  let d: Awaited<ReturnType<typeof dev>> | undefined;
  try {
    d = await dev({ path: new URL("../../extensions/embeds/document", import.meta.url).pathname, port: 0, open: false, log: () => {} });
    const base = d.url.split("/#")[0];
    const key = /k=([^&]+)/.exec(d.url)![1];
    const call = async (p: string, body?: unknown) => {
      const r = await fetch(`${base}${p}`, { method: body === undefined ? "GET" : "POST", headers: { "x-reflex-key": key, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(r.status, 200, `POST ${p} answered ${r.status}`);
      return r.json();
    };
    // The person underlines a sentence in the document (one flat stroke), and the Embed answers
    // what it is on exactly as extensions/embeds/document/index.html's `resolve` does.
    await call("/api/dev/stroke", { points: [[80, 120], [300, 120]] });
    const anchor = {
      kind: "text",
      paragraphs: ["p1"],
      sentences: ["p1.s1"],
      quote: "We trained every model for 40 epochs.",
      text: "We trained every model for 40 epochs.",
      gesture: "underline",
      label: "underlined p1.s1",
    };
    await call("/api/dev/send", { said: "", anchors: [{ element: "a_dev:embed-1", strokes: 0, anchor, bounds: [78, 110, 224, 20] }] });
    const s = (await call("/api/dev/state")) as any;
    const bundle = s.last?.bundle;
    assert.ok(bundle?.marks?.[0]?.target, `the Send has no Mark target: ${JSON.stringify(bundle?.marks)}`);
    assert.equal(bundle.marks[0].target.gesture, "underline", "the Mark's target is the Embed's answer");
    assert.ok(
      validate(bundle),
      `the Bundle the Agent gets is not a valid Send Bundle: ${ajv.errorsText(validate.errors)} (target ${JSON.stringify(bundle.marks[0].target)})`,
    );
  } finally {
    await d?.close();
  }
});
