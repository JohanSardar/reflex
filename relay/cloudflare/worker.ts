// The Relay on Cloudflare: a Worker in front of three Durable Object classes,
// each holding one piece of relay/domain/:
//
//   RoomDO  one per room (a person's devices): hibernatable WebSockets, presence, frame routing
//   LogDO   one per Space log: sealed entries in DO SQLite, grants, and the cloud session (kernel + Agent layer)
//   AuthDO  one: OAuth clients and sign-ins
//
// Sealed assets are in R2. Run locally with `wrangler dev` (see README); this
// ticket never deploys it.
import { DurableObject } from "cloudflare:workers";
import { SvgRenderer } from "../../agent/src/render.ts";
import { route } from "../domain/http.ts";
import { SpaceLog } from "../domain/log.ts";
import { Auth } from "../domain/oauth.ts";
import type { AuthApi, Bucket, Hubs, LogApi, Sock, SockState, Sql } from "../domain/ports.ts";
import { Room } from "../domain/room.ts";
import { ROOM_ID } from "../domain/wire.ts";
import { kernel } from "./kernel.ts";
import { ready as rendererReady } from "./shims/resvg.ts";

interface Env {
  ROOM: DurableObjectNamespace<RoomDO>;
  LOG: DurableObjectNamespace<LogDO>;
  AUTH: DurableObjectNamespace<AuthDO>;
  ASSETS: R2Bucket;
  /** The public origin, if it differs from the request's. */
  ORIGIN?: string;
}

const LOG_METHODS = ["append", "read", "watch", "assetsHave", "issueGrant", "revokeGrant", "mint"] as const;

function hubs(env: Env): Hubs {
  return {
    log: (id) => {
      const stub = env.LOG.get(env.LOG.idFromName(id));
      return Object.fromEntries(LOG_METHODS.map((m) => [m, (...a: unknown[]) => stub.call(id, m, a)])) as unknown as LogApi;
    },
    auth: () => {
      const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
      return { lookup: (...a) => stub.call("lookup", a), approve: (...a) => stub.call("approve", a) } as AuthApi;
    },
    room: (id) => ({ notify: (log, last) => env.ROOM.get(env.ROOM.idFromName(id)).notify(id, log, last) }),
  };
}

function sql(storage: DurableObjectStorage): Sql {
  // DO SQLite takes ArrayBuffers for blobs.
  const args = (p: unknown[]) => p.map((x) => (x instanceof Uint8Array ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : x));
  return {
    all: <T>(q: string, ...p: unknown[]) => storage.sql.exec(q, ...args(p)).toArray() as T[],
    run: (q: string, ...p: unknown[]) => void storage.sql.exec(q, ...args(p)).toArray(),
  };
}

function r2(b: R2Bucket): Bucket {
  return {
    put: async (k, bytes) => void (await b.put(k, bytes)),
    get: async (k) => {
      const o = await b.get(k);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    has: async (k) => (await b.head(k)) !== null,
  };
}

const originOf = (req: Request, env: Env): string => env.ORIGIN ?? new URL(req.url).origin;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = originOf(req, env);
    if (url.pathname === "/v0/connect") {
      const room = url.searchParams.get("room") ?? "";
      if (!ROOM_ID.test(room) || req.headers.get("upgrade") !== "websocket") return new Response("a WebSocket to a room is expected", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(req);
    }
    return route(
      req,
      {
        auth: (r, o) => env.AUTH.get(env.AUTH.idFromName("auth")).fetch(withHeaders(r, { "x-reflex-origin": o })),
        log: (id, r, path, o) => env.LOG.get(env.LOG.idFromName(id)).fetch(withHeaders(r, { "x-reflex-log": id, "x-reflex-path": path.join("/"), "x-reflex-origin": o })),
      },
      origin,
    );
  },
} satisfies ExportedHandler<Env>;

function withHeaders(r: Request, h: Record<string, string>): Request {
  const req = new Request(r);
  for (const [k, v] of Object.entries(h)) req.headers.set(k, v);
  return req;
}

export class RoomDO extends DurableObject<Env> {
  #room: Room | null = null;

  #get(id: string): Room {
    this.#room ??= new Room(id, () => this.ctx.getWebSockets().map((ws) => sock(ws)), hubs(this.env), (m) => console.log(`room: ${m}`));
    return this.#room;
  }

  override async fetch(req: Request): Promise<Response> {
    const id = new URL(req.url).searchParams.get("room")!;
    this.ctx.storage.kv.put("room", id);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    this.#get(id).open(sock(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  #id(): string {
    return this.ctx.storage.kv.get<string>("room") ?? "";
  }

  override async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    await this.#get(this.#id()).message(sock(ws), typeof msg === "string" ? msg : new Uint8Array(msg));
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.#get(this.#id()).closed(sock(ws));
  }

  async notify(id: string, log: string, last: number): Promise<void> {
    this.#get(id).notify(log, last);
  }
}

/** A hibernatable WebSocket: its state lives in its attachment. */
function sock(ws: WebSocket): Sock {
  return {
    send: (d) => {
      try {
        ws.send(d);
      } catch {
        /* closing */
      }
    },
    close: (code, reason) => ws.close(code, reason),
    get state() {
      return (ws.deserializeAttachment() as SockState | null) ?? { nonce: "", watch: [], logs: [] };
    },
    set state(s) {
      ws.serializeAttachment(s);
    },
  };
}

export class LogDO extends DurableObject<Env> {
  #log: SpaceLog | null = null;

  #get(id: string): SpaceLog {
    if (this.#log) return this.#log;
    if (!this.ctx.storage.kv.get("log")) this.ctx.storage.kv.put("log", id);
    this.#log = new SpaceLog({
      id: this.ctx.storage.kv.get<string>("log") ?? id,
      sql: sql(this.ctx.storage),
      bucket: r2(this.env.ASSETS),
      hubs: hubs(this.env),
      kernel,
      renderer: () => new SvgRenderer(),
      log: (m) => console.log(`log: ${m}`),
      wakeAt: (at) => void this.ctx.storage.setAlarm(at),
    });
    return this.#log;
  }

  async call(id: string, method: (typeof LOG_METHODS)[number], args: unknown[]): Promise<unknown> {
    const log = this.#get(id) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return log[method](...args);
  }

  override async fetch(req: Request): Promise<Response> {
    await rendererReady();
    const id = req.headers.get("x-reflex-log")!;
    const path = (req.headers.get("x-reflex-path") ?? "").split("/").filter(Boolean);
    return this.#get(id).fetch(req, path, req.headers.get("x-reflex-origin") ?? new URL(req.url).origin);
  }

  override async alarm(): Promise<void> {
    const id = this.ctx.storage.kv.get<string>("log");
    if (id) this.#get(id).expire();
  }
}

export class AuthDO extends DurableObject<Env> {
  #auth: Auth | null = null;

  #get(): Auth {
    this.#auth ??= new Auth(sql(this.ctx.storage), hubs(this.env), (m) => console.log(`auth: ${m}`));
    return this.#auth;
  }

  async call(method: "lookup" | "approve", args: unknown[]): Promise<unknown> {
    const a = this.#get() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return a[method](...args);
  }

  override async fetch(req: Request): Promise<Response> {
    return this.#get().fetch(req, req.headers.get("x-reflex-origin") ?? new URL(req.url).origin);
  }
}
