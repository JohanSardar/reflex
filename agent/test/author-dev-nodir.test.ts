// `reflex dev <path>` where the folder in the path does not exist yet: a typo'd
// folder (`guides/` for `guide/`) is one of the easy ways to get the path wrong,
// and the load error's own fix text promises "the playground reloads when you
// save". So the playground must start, show the load error, and pick the
// extension up when the file (and its folder) appear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "../src/author/create.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("reflex dev starts when the extension's folder does not exist, and reloads when it appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-dev-nodir-"));
  const template = create("guide", "hot", join(dir, "made"));
  const wanted = join(dir, "guides", "hot.md"); // `guides/` was never made: the path is one folder off
  const cli = join(import.meta.dirname, "..", "bin", "reflex.mjs");
  const child = spawn(process.execPath, [cli, "dev", wanted, "--no-open", "--port", "0", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (err += String(b)));
  try {
    let url: string | undefined;
    for (let i = 0; i < 50 && !url && child.exitCode === null; i++) {
      url = /(http:\/\/127\.0\.0\.1:\d+\/#k=[\w-]+)/.exec(out)?.[1];
      if (!url) await sleep(100);
    }
    assert.ok(url, `reflex dev never reached the playground (exit ${child.exitCode}) with a missing folder: ${(err || out).trim().slice(0, 400)}`);

    const key = /k=([^&"]+)/.exec(url)![1];
    const api = url.split("/#")[0];
    const state = async () =>
      (await (await fetch(`${api}/api/dev/state`, { headers: { "x-reflex-key": key } })).json()) as {
        extension: { name: string } | null;
        load_error: { msg: string } | null;
      };
    const before = await state();
    assert.ok(before.load_error, "the missing extension did not show as a load error, so this is not the case being tested");

    mkdirSync(join(dir, "guides"), { recursive: true });
    writeFileSync(wanted, readFileSync(template.path, "utf8"));
    let fixed = before;
    for (let i = 0; i < 60 && fixed.load_error; i++) {
      await sleep(100);
      fixed = await state();
    }
    assert.equal(fixed.load_error, null, `the playground never loaded the file the author saved: ${JSON.stringify(fixed.load_error)}`);
    assert.equal(fixed.extension?.name, "hot");
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
