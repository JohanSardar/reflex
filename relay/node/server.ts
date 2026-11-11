// The self-hosted Relay on Node: the same core as the Cloudflare one
// (relay/domain/), on node:sqlite (one database per log, like one Durable
// Object per log), a folder for sealed assets, and `ws` for WebSockets.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import { Space } from "@reflex/kernel/node";
import { SvgRenderer } from "../../agent/src/render.ts";
import { route } from "../domain/http.ts";
import { SpaceLog } from "../domain/log.ts";
import { Auth } from "../domain/oauth.ts";
import type { Bucket, Hubs, Sock, SockState, Sql } from "../domain/ports.ts";
import { Room } from "../domain/room.ts";
import { hex, random } from "../domain/seal.ts";
import { LOG_ID, ROOM_ID } from "../domain/wire.ts";

function sqlite(path: string): Sql {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  return {
    all: <T>(q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as T[],
    run: (q: string, ...p: unknown[]) => void db.prepare(q).run(...(p as never[])),
  };
}

function folder(root: string): Bucket {
  const path = (key: string) => join(root, ...key.split("/"));
  return {
    async put(key, bytes) {
      const p = path(key);
      mkdirSync(join(p, ".."), { recursive: true });
      const tmp = `${p}.${hex(random(4))}.tmp`;
      writeFileSync(tmp, bytes, { mode: 0o600, flush: true });
      renameSync(tmp, p);
    },
    async get(key) {
      try {
        return new Uint8Array(readFileSync(path(key)));
      } catch {
        return null;
      }
    },
    async has(key) {
      return existsSync(path(key));
    },
  };
}

export interface RelayOptions {
  dir: string;
  port: number;
  host?: string;
  /** The public origin, if the relay sits behind a proxy (e.g. https://relay.example.com). */
  origin?: string;
  log?: (m: string) => void;
}

export async function startRelay(o: RelayOptions): Promise<{ port: number; close(): Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`relay: ${m}`));
  mkdirSync(join(o.dir, "logs"), { recursive: true, mode: 0o700 });
  const bucket = folder(join(o.dir, "assets"));
  const logs = new Map<string, SpaceLog>();
  const rooms = new Map<string, { room: Room; socks: Set<Sock> }>();
  const timers = new Map<string, NodeJS.Timeout>();
  const renderer = new SvgRenderer();

  const hubs: Hubs = {
    log: (id) => logOf(id),
    auth: () => auth,
    room: (id) => ({ notify: async (l, last) => rooms.get(id)?.room.notify(l, last) }),
  };
  const logOf = (id: string): SpaceLog => {
    if (!LOG_ID.test(id)) throw new Error("not a log ID");
    let l = logs.get(id);
    if (!l) {
      l = new SpaceLog({
        id,
        sql: sqlite(join(o.dir, "logs", `${id}.sqlite`)),
        bucket,
        hubs,
        kernel: { create: (s, k, a) => Space.create(s, k, a) },
        renderer: () => renderer,
        log,
        wakeAt: (at) => {
          clearTimeout(timers.get(id));
          const t = setTimeout(() => l!.expire(), Math.min(2 ** 31 - 1, Math.max(0, at - Date.now()) + 50));
          t.unref();
          timers.set(id, t);
        },
      });
      logs.set(id, l);
      l.expire();
    }
    return l;
  };
  const auth = new Auth(sqlite(join(o.dir, "auth.sqlite")), hubs, log);
  // Logs on disk keep their grants' expiry timers across restarts.
  for (const f of readdirSync(join(o.dir, "logs"))) if (/^[0-9a-f]{64}\.sqlite$/.test(f)) logOf(f.slice(0, 64));

  const roomOf = (id: string) => {
    let r = rooms.get(id);
    if (!r) {
      const socks = new Set<Sock>();
      r = { room: new Room(id, () => [...socks], hubs, log), socks };
      rooms.set(id, r);
    }
    return r;
  };

  const server = createServer((req, res) => void serve(req, res));
  const originOf = (req: IncomingMessage) => o.origin ?? `http://${req.headers.host ?? `localhost:${o.port}`}`;

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = originOf(req);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream);
    const request = new Request(new URL(req.url ?? "/", origin), { method: req.method, headers, body, signal: abort.signal, duplex: "half" } as RequestInit);
    let response: Response;
    try {
      response = await route(request, { auth: (r, origin) => auth.fetch(r, origin), log: (id, r, path, origin) => logOf(id).fetch(r, path, origin) }, origin);
    } catch (e) {
      log(`error on ${req.method} ${req.url}: ${(e as Error).stack}`);
      response = Response.json({ error: "internal" }, { status: 500 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return void res.end();
    Readable.fromWeb(response.body as never).on("error", () => res.destroy()).pipe(res);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", originOf(req));
    const id = url.searchParams.get("room") ?? "";
    if (url.pathname !== "/v0/connect" || !ROOM_ID.test(id)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const r = roomOf(id);
      let state: SockState = { nonce: "", watch: [], logs: [] };
      const sock: Sock = {
        send: (d) => ws.readyState === ws.OPEN && ws.send(d),
        close: (code, reason) => ws.close(code, reason),
        get state() {
          return state;
        },
        set state(s) {
          state = s;
        },
      };
      r.socks.add(sock);
      ws.on("message", (data: Buffer, binary: boolean) => void r.room.message(sock, binary ? new Uint8Array(data) : data.toString("utf8")));
      ws.on("close", () => {
        r.socks.delete(sock);
        r.room.closed(sock);
      });
      ws.on("error", () => {});
      r.room.open(sock);
    });
  });

  await new Promise<void>((resolve) => server.listen(o.port, o.host ?? "0.0.0.0", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  log(`listening on :${port}, data in ${o.dir}`);
  return {
    port,
    close: async () => {
      for (const t of timers.values()) clearTimeout(t);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
