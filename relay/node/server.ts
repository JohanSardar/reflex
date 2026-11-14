// Stateless, authenticated frame forwarding for paired devices.
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Sock, SockState } from "../domain/ports.ts";
import { Room } from "../domain/room.ts";
import { ROOM_ID } from "../domain/wire.ts";
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

  const server = createServer((_req, res) => { res.writeHead(404); res.end("Not found"); });
  const originOf = (req: IncomingMessage) => o.origin ?? `http://${req.headers.host ?? `localhost:${o.port}`}`;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", originOf(req));
    const id = url.searchParams.get("room") ?? "";
    if (url.pathname !== "/v0/connect" || !ROOM_ID.test(id)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const r = roomOf(id);
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
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
