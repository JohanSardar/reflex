// The `reflex dev` playground as its real client sees it: the HTTP API the
// browser page calls. Two things the playground promises: the pane shows what
// the stand-in Agent reads (including the extension being authored), and it
// reloads when the author saves (`load_error`'s own fix text says so).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "../src/author/create.ts";
import { dev } from "../src/author/dev.ts";

type Dev = Awaited<ReturnType<typeof dev>>;

async function state(d: Dev) {
  const r = await fetch(`${d.url.split("/#")[0]}/api/dev/state`, { headers: { "x-reflex-key": /k=([^&]+)/.exec(d.url)![1] } });
  assert.equal(r.status, 200, `GET /api/dev/state answered ${r.status}`);
  return (await r.json()) as {
    extension: { kind: string; name: string } | null;
    load_error: { msg: string; fix: string } | null;
    reads: { call: string; args: Record<string, unknown>; result: Record<string, any> }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("reflex dev shows the stand-in Agent the Guide it is authoring", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-dev-guide-"));
  const made = create("guide", "my-guide", dir);
  let d: Dev | undefined;
  try {
    d = await dev({ path: made.path, port: 0, open: false, log: () => {} });
    const s = await state(d);
    const read = s.reads.find((r) => r.call === "read_me" && r.args.topic === "my-guide");
    assert.ok(read, "the stand-in Agent never called read_me('my-guide'), so the pane cannot show the Guide");
    assert.equal(read.result.source, "extension", `read_me('my-guide') did not return the Guide under authoring: ${JSON.stringify(read.result).slice(0, 300)}`);
    assert.match(String(read.result.text ?? ""), /## Layout/, "read_me('my-guide') returned no Guide text");
  } finally {
    await d?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reflex dev reloads a recipe after the author fixes a load error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-dev-reload-"));
  const made = create("recipe", "hot", dir);
  const good = readFileSync(made.path, "utf8");
  // An author mid-edit: the template block is gone for a moment, so it does not load.
  writeFileSync(made.path, "---\nkind: recipe\nname: hot\nsummary: mid-edit\n---\n# hot\n");
  let d: Dev | undefined;
  try {
    d = await dev({ path: made.path, port: 0, open: false, log: () => {} });
    const broken = await state(d);
    assert.ok(broken.load_error, "the broken recipe did not report a load error, so this is not the case being tested");
    writeFileSync(made.path, good);
    let fixed = broken;
    for (let i = 0; i < 40 && fixed.load_error; i++) {
      await sleep(100);
      fixed = await state(d);
    }
    assert.equal(fixed.load_error, null, `the playground never reloaded the fixed recipe: ${JSON.stringify(fixed.load_error)}; its fix text promises "the playground reloads when you save"`);
    assert.equal(fixed.extension?.name, "hot");
  } finally {
    await d?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
