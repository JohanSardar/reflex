// The driver: how the runner talks to an implementation under test. The
// implementation is a command; it reads one JSON request per line on stdin,
// {"id": n, "do": "<what>", ...}, and writes one JSON answer per line on stdout,
// {"id": n, "ok": true, ...} or {"id": n, "ok": false, "error": "..."}. Anything
// else it prints goes to stderr. Each profile's README section lists its requests.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface Driver {
  call<T = Record<string, unknown>>(what: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
  log: string[];
}

export function driver(command: string, env: Record<string, string> = {}): Driver {
  const child: ChildProcess = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const log: string[] = [];
  let n = 0;
  let dead: Error | null = null;
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let m: { id?: number; ok?: boolean; error?: string };
    try {
      m = JSON.parse(line);
    } catch {
      log.push(`stdout (not JSON): ${line}`);
      return;
    }
    const w = waiting.get(Number(m.id));
    if (!w) return void log.push(`stdout (no request ${m.id}): ${line}`);
    waiting.delete(Number(m.id));
    if (m.ok === false) w.reject(new Error(m.error ?? "the implementation said no"));
    else w.resolve(m);
  });
  createInterface({ input: child.stderr! }).on("line", (l) => log.push(l));
  child.on("exit", (code) => {
    dead = new Error(`the implementation exited (${code}): ${log.slice(-5).join(" | ")}`);
    for (const w of waiting.values()) w.reject(dead);
    waiting.clear();
  });
  return {
    log,
    call(what, args = {}, timeoutMs = 30_000) {
      if (dead) return Promise.reject(dead);
      const id = ++n;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`no answer to '${what}' within ${timeoutMs} ms`));
        }, timeoutMs);
        waiting.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        child.stdin!.write(JSON.stringify({ id, do: what, ...args }) + "\n");
      });
    },
    async close() {
      if (dead) return;
      child.stdin!.end();
      await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
      if (!dead) child.kill("SIGKILL");
    },
  };
}

/** The other end: what an implementation written in TypeScript uses to answer the runner. */
export function serve(handlers: Record<string, (req: Record<string, any>) => unknown>): void {
  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue.then(async () => {
      const req = JSON.parse(line);
      const h = handlers[req.do];
      try {
        if (!h) throw new Error(`no request '${req.do}'`);
        const r = (await h(req)) ?? {};
        process.stdout.write(JSON.stringify({ id: req.id, ok: true, ...(r as object) }) + "\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: (e as Error).message }) + "\n");
      }
    });
  });
  rl.on("close", () => void queue.then(() => handlers.close?.({})).finally(() => process.exit(0)));
}
