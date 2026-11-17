// Only live encrypted device forwarding; no log, assets, OAuth or cloud agents.
import { DurableObject } from "cloudflare:workers";
import type { Sock, SockState } from "../domain/ports.ts";
import { Room } from "../domain/room.ts";
import { RELAY_PROTOCOL, ROOM_ID } from "../domain/wire.ts";

interface Env {
  ROOM: DurableObjectNamespace<RoomDO>;
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health")
      return new Response(
        `Reflex relay (${RELAY_PROTOCOL}). It forwards end-to-end encrypted frames between paired devices and keeps nothing.\n`,
      );
    if (url.pathname !== "/v0/connect") return new Response("Not found", { status: 404 });
    const room = url.searchParams.get("room") ?? "";
    if (!ROOM_ID.test(room) || req.headers.get("upgrade") !== "websocket")
      return new Response("a WebSocket to a room is expected", { status: 400 });
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
export class RoomDO extends DurableObject<Env> {
  #room: Room | null = null;
  /** The socket being closed: getWebSockets() still lists it, and each sock() is a new object, so the room must not count it. */
  #closing: WebSocket | null = null;

  #get(id: string): Room {
    this.#room ??= new Room(
      id,
      () =>
        this.ctx
          .getWebSockets()
          .filter((ws) => ws !== this.#closing)
          .map((ws) => sock(ws)),
      (m) => console.log(`room: ${m}`),
    );
    return this.#room;
  }

  override async fetch(req: Request): Promise<Response> {
    const id = new URL(req.url).searchParams.get("room") ?? ""; // checked against ROOM_ID before it got here
    this.ctx.storage.kv.put("room", id);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // The client's address, for the room's per-address limits (Cloudflare sets this header; clients can't).
    this.#get(id).open(sock(server), req.headers.get("cf-connecting-ip") ?? "");
    return new Response(null, { status: 101, webSocket: client });
  }

  #id(): string {
    return this.ctx.storage.kv.get<string>("room") ?? "";
  }

  override async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    await this.#get(this.#id()).message(sock(ws), typeof msg === "string" ? msg : new Uint8Array(msg));
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.#closing = ws;
    try {
      this.#get(this.#id()).closed(sock(ws));
    } finally {
      this.#closing = null;
    }
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
      return (ws.deserializeAttachment() as SockState | null) ?? { nonce: "", watch: [] };
    },
    set state(s) {
      ws.serializeAttachment(s);
    },
  };
}
