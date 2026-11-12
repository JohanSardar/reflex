// Reflex's web viewer (apps/web) behind the viewer profile's driver requests: the
// real page in headless Chrome, read through the DevTools protocol. The page is
// served by the host under test's own address (the viewer API serves it too).
//
//   node tests/conformance/run.ts viewer --impl "node tests/conformance/impl/web-viewer.ts"
//
// CHROME may name the browser; the default is Google Chrome's usual place on macOS,
// then `google-chrome` and `chromium` on the PATH.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../lib/driver.ts";
import { sleep } from "../lib/host.ts";

function chromePath(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const c of ["google-chrome", "chromium", "chromium-browser"]) if (spawnSync("which", [c]).status === 0) return c;
  throw new Error("No Chrome found: set CHROME to a Chrome or Chromium binary.");
}

const profile = mkdtempSync(join(tmpdir(), "reflex-conf-chrome-"));
const chrome = spawn(chromePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

/** One page, over the DevTools protocol. */
class Page {
  #ws: WebSocket;
  #n = 0;
  #waiting = new Map<number, (r: { result?: any; error?: { message: string } }) => void>();
  readonly close: () => Promise<void>;
  constructor(ws: WebSocket, close: () => Promise<void>) {
    this.#ws = ws;
    this.close = close;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      // The page's own errors and console go to stderr, which the runner shows when a check fails.
      if (m.method === "Runtime.exceptionThrown") process.stderr.write(`page error: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}\n`);
      if (m.method === "Runtime.consoleAPICalled") process.stderr.write(`page console.${m.params.type}: ${m.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" ")}\n`);
      this.#waiting.get(m.id)?.(m);
      this.#waiting.delete(m.id);
    };
  }
  static async open(): Promise<Page> {
    const file = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(100);
    const port = readFileSync(file, "utf8").split("\n")[0];
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as { id: string; webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const p = new Page(ws, async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    });
    await p.call("Runtime.enable");
    return p;
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#n;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T>(expr: string): Promise<T> {
    const r = await this.call("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value as T;
  }
}

let page: Page | null = null;

serve({
  async open({ url, key, space }) {
    // A fresh tab each time, as when the person opens the address the host printed.
    await page?.close();
    page = await Page.open();
    await page.call("Page.navigate", { url: `${url}/?space=${encodeURIComponent(space)}#k=${encodeURIComponent(key)}` });
  },
  async drawn() {
    if (!page) throw new Error("open first");
    return { ids: await page.eval<string[]>(`[...new Set([...document.querySelectorAll("#canvas [data-id]")].map((n) => n.getAttribute("data-id")))]`) };
  },
  async status() {
    if (!page) throw new Error("open first");
    const cls = await page.eval<string>(`document.getElementById("status")?.className ?? ""`);
    const text = await page.eval<string>(`document.getElementById("status")?.textContent ?? ""`);
    const status = /offline/.test(cls) && /Key not accepted/.test(text) ? "bad_key" : (cls.split(" ").find((c) => ["live", "connecting", "offline"].includes(c)) ?? cls);
    return { status };
  },
  close() {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  },
});
