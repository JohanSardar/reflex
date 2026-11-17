// A self-hosted Relay: the same rooms as the Cloudflare one (relay/domain/room.ts), in one Node process.
// It keeps nothing on disk and forwards only sealed frames.
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Sock, SockState } from "../domain/ports.ts";
import { Room } from "../domain/room.ts";
import { RELAY_PROTOCOL, ROOM_ID } from "../domain/wire.ts";

export interface RelayOptions {
  dir?: string;
  port: number;
  host?: string;
  /** The public origin, if the relay sits behind a proxy (e.g. https://relay.example.com). */
  origin?: string;
  log?: (m: string) => void;
}

/** New connections a minute, and open ones, from one address across all rooms (croc allows 30 joins a minute). */
export const PER_ADDRESS = { perMinute: 60, open: 64 };

/**
 * Where a connection came from. Behind a proxy on this machine (Caddy, nginx, cloudflared) every connection
 * comes from loopback, so the proxy's header names the client; from anywhere else, headers are not trusted.
 */
function addressOf(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "";
  const loopback = remote === "::1" || remote.startsWith("127.") || remote === "::ffff:127.0.0.1";
  if (!loopback) return remote;
  const h = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.split(",")[0].trim();
  };
  return h("cf-connecting-ip") || h("x-forwarded-for") || h("x-real-ip") || remote;
}

export async function startRelay(o: RelayOptions): Promise<{ port: number; close(): Promise<void> }> {
  const log = o.log ?? ((m: string) => console.log(`relay: ${m}`));
  const rooms = new Map<string, { room: Room; socks: Set<Sock> }>();
  const roomOf = (id: string) => {
    let r = rooms.get(id);
    if (!r) {
      const socks = new Set<Sock>();
      r = { room: new Room(id, () => [...socks], log), socks };
      rooms.set(id, r);
    }
    return r;
  };
  const recent = new Map<string, number[]>();
  const open = new Map<string, number>();

  // Anything but a room's WebSocket: a line saying what this is, so `curl` shows a Relay is up.
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`Reflex relay (${RELAY_PROTOCOL}). It forwards end-to-end encrypted frames between paired devices and keeps nothing.\n`);
    }
    res.writeHead(404);
    res.end("Not found");
  });
  const originOf = (req: IncomingMessage) => o.origin ?? `http://${req.headers.host ?? `localhost:${o.port}`}`;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", originOf(req));
    const id = url.searchParams.get("room") ?? "";
    if (url.pathname !== "/v0/connect" || !ROOM_ID.test(id)) return socket.destroy();
    const address = addressOf(req);
    const now = Date.now();
    const times = (recent.get(address) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= PER_ADDRESS.perMinute || (open.get(address) ?? 0) >= PER_ADDRESS.open) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    recent.set(address, [...times, now]);
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const r = roomOf(id);
      open.set(address, (open.get(address) ?? 0) + 1);
      let state: SockState = { nonce: "", watch: [] };
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
        if (r.socks.size === 0) rooms.delete(id);
        const n = (open.get(address) ?? 1) - 1;
        if (n > 0) open.set(address, n);
        else open.delete(address);
      });
      ws.on("error", () => {});
      r.room.open(sock, address);
    });
  });
  // Sockets that never say hello are closed, and old rate records forgotten.
  const sweep = setInterval(() => {
    for (const r of rooms.values()) r.room.sweep();
    const now = Date.now();
    for (const [a, t] of recent) if (!t.some((x) => now - x < 60_000)) recent.delete(a);
  }, 2_000);
  sweep.unref();

  await new Promise<void>((resolve) => server.listen(o.port, o.host ?? "0.0.0.0", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  log(`listening on :${port} (ws://<this machine>:${port}; give devices wss:// through a TLS proxy to reach it from anywhere)`);
  return {
    port,
    close: async () => {
      clearInterval(sweep);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
