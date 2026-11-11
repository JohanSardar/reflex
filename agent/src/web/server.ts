// Serves the web viewer (apps/web) and keeps a browser's kernel replicas in
// sync with a host's Spaces. The Link uses it for the person's web viewer
// (link/web.ts); `reflex dev` uses it for the playground on an in-memory Space.
//
// The browser runs the same kernel (WASM) and holds a full replica of each
// Space, kept in step with the host's by the kernel's own sync protocol (one
// conversation per Space per browser tab), exactly as an iPad is. Only the
// transport differs: the host streams sync messages down one long fetch
// (newline-delimited JSON) and the browser posts its replies.
//
// Safety:
// - It listens on loopback only, and checks the Host header against DNS rebinding.
// - Every /api call carries the viewer key, which the host shows only to the person.
// - What a browser sends is checked by the kernel with no writers at all, so a
//   viewer can read everything and change nothing.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { extname, normalize, sep } from "node:path";
import type { Space } from "@reflex/kernel/node";

const WEB = new URL("../../../apps/web/", import.meta.url).pathname;
const KERNEL = new URL("../../../kernel/wasm/pkg/", import.meta.url).pathname;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export interface WebSource {
  person: { id: string; name: string };
  /** Display names by principal ID. */
  names(): Record<string, string>;
  spaces(): { id: string; kind: string }[];
  read<T>(space: string, fn: (s: Space) => T): T;
  /** Takes a browser's sync message for a Space. Must refuse every change in it. */
  receive(space: string, peer: string, bytes: Uint8Array): { ok: boolean; errors?: { msg: string }[] };
  onChange(fn: (space: string) => void): void;
  asset?(hash: string): Buffer | undefined;
  /** Who is in each Space right now (cursors, names, selections), sent to a viewer when it connects; later ones go by `broadcast`. */
  here?(): Record<string, unknown>[];
}

export type Extra = (req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<Buffer>) => Promise<boolean> | boolean;

export interface WebOptions {
  source: WebSource;
  port: number;
  /** Which page "/" serves. */
  page: "index.html" | "dev.html";
  /** Extra /api routes (the dev playground's), tried before the shared ones. */
  extra?: Extra;
  key?: string;
  log?: (msg: string) => void;
}

type Peer = { id: string; res: ServerResponse };

export const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, limit = 32 * 1024 * 1024) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

// Node warns once per process that type stripping is experimental; the viewer uses only erasable syntax.
let warned = false;
function strip(src: string) {
  if (!warned) {
    warned = true;
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    try {
      return stripTypeScriptTypes(src);
    } finally {
      process.emitWarning = emit;
    }
  }
  return stripTypeScriptTypes(src);
}

export async function serveWeb(o: WebOptions): Promise<{ server: Server; port: number; key: string; url: string; broadcast: (event: Record<string, unknown>) => void; close: () => Promise<void> }> {
  const key = o.key ?? randomBytes(18).toString("base64url");
  const peers = new Map<string, Peer>();
  const log = o.log ?? (() => {});
  let port = o.port;

  const write = (p: Peer, event: Record<string, unknown>) => {
    if (!p.res.writableEnded) p.res.write(JSON.stringify(event) + "\n");
  };
  const pump = (space: string, p: Peer) => {
    const msg = o.source.read(space, (s) => s.syncMessage(p.id));
    if (msg) write(p, { t: "sync", space, msg: Buffer.from(msg).toString("base64") });
  };
  const hello = () => ({ t: "hello", person: o.source.person, names: o.source.names(), spaces: o.source.spaces() });
  let known = new Set(o.source.spaces().map((s) => s.id));
  o.source.onChange((space) => {
    const now = o.source.spaces();
    if (now.length !== known.size || now.some((s) => !known.has(s.id))) {
      known = new Set(now.map((s) => s.id));
      for (const p of peers.values()) write(p, hello());
    }
    for (const p of peers.values()) pump(space, p);
  });

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers["x-reflex-key"] ?? ""));
    const want = Buffer.from(key);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const file = (res: ServerResponse, path: string) => {
    if (!existsSync(path)) return json(res, 404, { ok: false, reason: "not_found" });
    const ext = extname(path);
    let body: Buffer | string = readFileSync(path);
    if (ext === ".ts") body = strip(body.toString("utf8"));
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? "");
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { ok: false, reason: "bad_host" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      const p = url.pathname;
      if (!p.startsWith("/api/")) {
        if (req.method !== "GET") return json(res, 405, { ok: false, reason: "method" });
        if (p === "/") return file(res, WEB + o.page);
        if (p.startsWith("/kernel/")) {
          const name = p.slice("/kernel/".length);
          if (!/^reflex_kernel_wasm(_bg\.wasm|\.js)$/.test(name)) return json(res, 404, { ok: false, reason: "not_found" });
          return file(res, KERNEL + name);
        }
        const rel = normalize(decodeURIComponent(p)).replace(/^[/\\]+/, "");
        if (rel.split(sep).includes("..") || !/^(src\/[\w-]+\.(ts|js|css)|[\w-]+\.(css|svg))$/.test(rel)) return json(res, 404, { ok: false, reason: "not_found" });
        return file(res, WEB + rel);
      }
      if (!authorized(req)) return json(res, 401, { ok: false, reason: "bad_key", errors: [{ code: "bad_key", msg: "Wrong or missing viewer key.", fix: "Open the viewer from the link the Link printed." }] });
      const body = () => readBody(req);
      if (o.extra && (await o.extra(req, res, url, body))) return;

      if (p === "/api/events" && req.method === "GET") {
        const id = `web-${String(url.searchParams.get("peer") ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || randomBytes(6).toString("hex")}`;
        peers.get(id)?.res.end();
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
        const peer: Peer = { id, res };
        peers.set(id, peer);
        for (const s of o.source.spaces()) o.source.read(s.id, (sp) => sp.resetSync(id));
        write(peer, hello());
        for (const s of o.source.spaces()) pump(s.id, peer);
        for (const h of o.source.here?.() ?? []) write(peer, { t: "here", ...h });
        const ping = setInterval(() => write(peer, { t: "ping" }), 15_000);
        log(`web viewer ${id} connected`);
        req.on("close", () => {
          clearInterval(ping);
          if (peers.get(id) !== peer) return;
          peers.delete(id);
          for (const s of o.source.spaces()) o.source.read(s.id, (sp) => sp.resetSync(id));
          log(`web viewer ${id} left`);
        });
        return;
      }
      if (p === "/api/sync" && req.method === "POST") {
        const id = `web-${String(url.searchParams.get("peer") ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
        const space = String(url.searchParams.get("space") ?? "");
        const peer = peers.get(id);
        if (!peer) return json(res, 409, { ok: false, reason: "no_stream", errors: [{ code: "no_stream", msg: "Open /api/events first.", fix: "Reconnect." }] });
        if (!o.source.spaces().some((s) => s.id === space)) return json(res, 404, { ok: false, reason: "unknown_space" });
        const r = o.source.receive(space, id, new Uint8Array(await body()));
        if (!r.ok) {
          log(`refused changes to '${space}' from web viewer ${id}: ${(r.errors ?? []).map((e) => e.msg).join(" ")}`);
          return json(res, 403, { ok: false, reason: "read_only", errors: [{ code: "read_only", msg: "The web viewer can't change a Space.", fix: "Make changes on the iPad, or through an Agent." }] });
        }
        pump(space, peer);
        return json(res, 200, { ok: true });
      }
      if (p.startsWith("/api/asset/") && req.method === "GET") {
        const hash = p.slice("/api/asset/".length);
        const bytes = /^[0-9a-f]{64}$/.test(hash) ? o.source.asset?.(hash) : undefined;
        if (!bytes) return json(res, 404, { ok: false, reason: "not_found" });
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" });
        return res.end(bytes);
      }
      return json(res, 404, { ok: false, reason: "not_found" });
    } catch (e) {
      log(`web error: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) json(res, 500, { ok: false, reason: "internal", errors: [{ code: "internal", msg: (e as Error).message.slice(0, 400), fix: "Retry." }] });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const start = (want: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && want !== 0 ? start(0) : reject(e)));
      server.listen(want, "127.0.0.1", () => {
        const a = server.address();
        port = typeof a === "object" && a ? a.port : want;
        resolve();
      });
    };
    start(o.port);
  });
  return {
    server,
    port,
    key,
    url: `http://127.0.0.1:${port}/#k=${key}`,
    broadcast: (event) => {
      for (const p of peers.values()) write(p, event);
    },
    close: () =>
      new Promise<void>((r) => {
        for (const p of peers.values()) p.res.end();
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
