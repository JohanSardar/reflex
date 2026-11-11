// `reflex dev [<path>]`: the playground (ARCHITECTURE §5). The web viewer on
// an in-memory Space with hot reload and three panes: what the Agent reads,
// what a Send produces when you draw with the mouse, and live lints and
// Anchors. "Save example" turns the last Send into a conformance example that
// `reflex test` replays. It needs no iPad, no Xcode and no Link.
import { existsSync, mkdirSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import type { Space } from "@reflex/kernel/node";
import { json, serveWeb, type WebSource } from "../web/server.ts";
import { load } from "../extensions/files.ts";
import { Sandbox, SPACE } from "./sandbox.ts";

export async function dev(o: { path?: string; port: number; open: boolean; log: (s: string) => void }) {
  let box!: Sandbox;
  let loadError: { msg: string; fix: string } | undefined;
  const listeners: ((space: string) => void)[] = [];

  const build = async () => {
    let loaded;
    loadError = undefined;
    try {
      loaded = o.path ? load(o.path) : undefined;
    } catch (e) {
      loadError = { msg: (e as Error).message, fix: (e as { fix?: string }).fix ?? "Fix the file; the playground reloads when you save." };
    }
    const next = new Sandbox(loaded);
    next.spaces.onChange((space) => {
      if (box === next) for (const l of listeners) l(space);
    });
    box = next;
    await next.start();
  };
  await build();

  const source: WebSource = {
    person: { id: "p_dev", name: "You" },
    names: () => ({ a_dev: "Dev Agent", p_dev: "You" }),
    spaces: () => box.spaces.list().map((e) => ({ id: e.name, kind: e.kind })),
    read: <T,>(space: string, fn: (s: Space) => T) => fn(box.spaces.get(space)!.space),
    receive: (space, peer, bytes) => JSON.parse(box.spaces.get(space)!.space.receiveSyncMessageChecked(peer, bytes, JSON.stringify({ people: [] }))),
    onChange: (fn) => listeners.push(fn),
  };

  const state = () => ({
    space: SPACE,
    extension: box.loaded ? { kind: box.loaded.ext.kind, name: box.loaded.ext.name, path: box.loaded.path, files: box.loaded.files } : null,
    load_error: loadError ?? null,
    checks: box.checks,
    lints: box.lints,
    params: box.params,
    reads: box.reads,
    last: box.last ?? null,
    examples: box.loaded && existsSync(box.loaded.examples) ? readdirSync(box.loaded.examples).filter((f) => f.endsWith(".json")) : [],
  });

  const web = await serveWeb({
    source,
    port: o.port,
    page: "dev.html",
    log: () => {},
    extra: async (req, res, url, body) => {
      const p = url.pathname;
      if (!p.startsWith("/api/dev/")) return false;
      const input = req.method === "POST" ? JSON.parse((await body()).toString("utf8") || "{}") : {};
      if (p === "/api/dev/state") return json(res, 200, state()), true;
      if (p === "/api/dev/stroke") {
        const pts = (input.points ?? []).filter((q: unknown) => Array.isArray(q) && q.length >= 2).map((q: number[]) => [Math.round(q[0]), Math.round(q[1])]);
        if (pts.length < 2) return json(res, 400, { ok: false, reason: "invalid_input", errors: [{ code: "invalid_input", msg: "A stroke needs at least two points.", fix: "Draw a longer stroke." }] }), true;
        return json(res, 200, box.stroke(pts)), true;
      }
      if (p === "/api/dev/send") return json(res, 200, await box.send({ said: input.said || undefined, anchors: input.anchors })), true;
      if (p === "/api/dev/example") {
        const ex = box.example();
        if (!ex || !box.loaded) return json(res, 400, { ok: false, reason: "invalid_input", errors: [{ code: "invalid_input", msg: box.loaded ? "Press Send first: an example is the last Send's Marks." : "Start reflex dev with an extension's path to save examples for it.", fix: "Draw, press Send, then Save example." }] }), true;
        const dir = box.loaded.examples;
        mkdirSync(dir, { recursive: true });
        const prefix = box.loaded.ext.kind === "guide" || box.loaded.ext.kind === "recipe" ? `${box.loaded.ext.name}-` : "";
        let n = 1;
        while (existsSync(join(dir, `${prefix}${n}.json`))) n++;
        const file = join(dir, `${prefix}${n}.json`);
        writeFileSync(file, JSON.stringify(ex, null, 2) + "\n");
        o.log(`saved example ${relative(process.cwd(), file)}`);
        return json(res, 200, { ok: true, file }), true;
      }
      if (p === "/api/dev/reset") {
        await build();
        web.broadcast({ t: "reload", reason: "reset" });
        return json(res, 200, { ok: true }), true;
      }
      return false;
    },
  });

  // Hot reload: rebuild on every save of the extension's files, and tell the page.
  const watchers: FSWatcher[] = [];
  if (o.path) {
    let timer: NodeJS.Timeout | undefined;
    // Watched even when the extension doesn't load yet, so saving the fix reloads it.
    // The nearest folder that exists, so a path whose folder isn't made yet still reloads once it is.
    let dir = box.loaded?.dir ?? (existsSync(o.path) && statSync(o.path).isDirectory() ? resolve(o.path) : dirname(resolve(o.path)));
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    const w = watch(dir, { recursive: true }, (_e, f) => {
      if (f && box.loaded && join(dir, String(f)).startsWith(box.loaded.examples)) return; // saving an example isn't an edit
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await build();
        o.log(`reloaded ${f ?? ""}: ${loadError ? loadError.msg : `${box.checks.filter((c) => c.level === "error").length} errors, ${box.checks.filter((c) => c.level === "warning").length} warnings`}`);
        web.broadcast({ t: "reload", reason: String(f ?? "change") });
      }, 120);
    });
    watchers.push(w);
  }

  o.log(`reflex dev${box.loaded ? ` · ${box.loaded.ext.kind} ${box.loaded.ext.name}` : ""}${loadError ? ` · ${loadError.msg}` : ""}`);
  o.log(web.url);
  if (o.open) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", web.url] : [web.url];
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  return {
    url: web.url,
    close: async () => {
      for (const w of watchers) w.close();
      await web.close();
    },
  };
}
