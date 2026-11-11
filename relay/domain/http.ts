// The Relay's HTTP surface, the same on Cloudflare and Node. WebSocket
// upgrades on `/v0/connect` are taken by the platform before this runs.
//
//   /.well-known/oauth-*, /oauth/*        OAuth (relay/domain/oauth.ts)
//   /mcp                                  remote MCP; the bearer token names its log
//   /v0/log/<log>/assets/<id>, /stats     sealed assets and numbers, with the log token
import { tokenLog, unauthorized } from "./log.ts";
import { LOG_ID } from "./wire.ts";

export interface Front {
  auth(req: Request, origin: string): Promise<Response>;
  log(id: string, req: Request, path: string[], origin: string): Promise<Response>;
}

export async function route(req: Request, front: Front, origin: string): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/") return new Response("Reflex Relay (reflex-relay/v0). Remote MCP is at /mcp.\n", { headers: { "content-type": "text/plain" } });
  if (parts[0] === ".well-known" || parts[0] === "oauth") return front.auth(req, origin);
  if (parts[0] === "mcp" && parts.length === 1) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const log = tokenLog(token);
    if (!log) return unauthorized(origin, "Sign in to use this Relay.");
    return front.log(log, req, ["mcp"], origin);
  }
  if (parts[0] === "v0" && parts[1] === "log" && LOG_ID.test(parts[2] ?? "")) return front.log(parts[2], req, parts.slice(3), origin);
  return new Response("not found", { status: 404 });
}
