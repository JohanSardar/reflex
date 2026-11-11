// OAuth 2.1 for remote MCP (SPEC §13; claude.ai connectors need it): the
// authorization server and protected-resource metadata, dynamic client
// registration, and the authorization-code flow with PKCE (S256 only).
//
// OAuth never approves an Agent by itself (ARCHITECTURE §6). The authorize
// page shows a short code. The person types it into the terminal running
// their Reflex Link, picks a Space and how long, and the Link issues a signed
// grant through the Relay (relay/domain/log.ts). Only then does the page go
// on to the client with an authorization code, which the client exchanges
// for an access token bound to that one grant.
import type { AuthApi, Hubs, Sql } from "./ports.ts";
import { b64url, random, sha256hex } from "./seal.ts";
import { sha256 } from "@noble/hashes/sha2.js";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
     challenge TEXT NOT NULL, state TEXT, scope TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL,
     log TEXT, gid TEXT, auth_code_hash TEXT, grant_expires INTEGER)`,
];

const PENDING_MS = 10 * 60_000;
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

interface Client {
  client_id: string;
  client_name: string;
  client_uri?: string;
  redirect_uris: string[];
}

const okRedirect = (u: string): boolean => {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    // An app's own scheme (a desktop or mobile client).
    return !["javascript:", "data:", "file:", "blob:", "vbscript:"].includes(url.protocol);
  } catch {
    return false;
  }
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const oauthError = (error: string, description: string, status = 400): Response => Response.json({ error, error_description: description }, { status });

export function userCode(): string {
  const r = random(8);
  const s = Array.from(r, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const normalizeCode = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

export class Auth implements AuthApi {
  #sql: Sql;
  #hubs: Hubs;
  #log: (m: string) => void;

  constructor(sql: Sql, hubs: Hubs, log: (m: string) => void = () => {}) {
    this.#sql = sql;
    this.#hubs = hubs;
    this.#log = log;
    for (const s of SCHEMA) sql.run(s);
  }

  #client(id: string): Client | undefined {
    const r = this.#sql.all<{ body: string }>("SELECT body FROM clients WHERE id = ?", id)[0];
    return r ? JSON.parse(r.body) : undefined;
  }

  async lookup(code: string): Promise<{ client: string; client_uri: string | null; scope: string }> {
    const p = this.#sql.all<{ client_id: string; scope: string; status: string; expires: number }>(
      "SELECT client_id, scope, status, expires FROM pending WHERE user_code = ?",
      normalizeCode(code),
    )[0];
    if (!p || p.status !== "waiting" || p.expires <= Date.now()) throw new Error("No sign-in is waiting for that code. It may have expired; start again from the Agent.");
    const c = this.#client(p.client_id);
    return { client: c?.client_name ?? "An MCP client", client_uri: c?.client_uri ?? null, scope: p.scope };
  }

  async approve(code: string, log: string, gid: string, expires: number): Promise<void> {
    const c = normalizeCode(code);
    const p = this.#sql.all<{ status: string; expires: number }>("SELECT status, expires FROM pending WHERE user_code = ?", c)[0];
    if (!p || p.status !== "waiting" || p.expires <= Date.now()) throw new Error("No sign-in is waiting for that code.");
    this.#sql.run("UPDATE pending SET status = 'approved', log = ?, gid = ?, grant_expires = ? WHERE user_code = ?", log, gid, expires, c);
    this.#log(`sign-in ${c} approved for grant ${gid}`);
  }

  async fetch(req: Request, origin: string): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration")
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["space"],
      });
    if (p.startsWith("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["space"], bearer_methods_supported: ["header"] });
    if (p === "/oauth/register" && req.method === "POST") return this.#register(req);
    if (p === "/oauth/authorize" && req.method === "GET") return this.#authorize(url, origin);
    if (p.startsWith("/oauth/pending/")) return this.#pending(p.slice("/oauth/pending/".length), url);
    if (p === "/oauth/token" && req.method === "POST") return this.#token(req);
    return new Response("not found", { status: 404 });
  }

  async #register(req: Request): Promise<Response> {
    let m: Record<string, unknown>;
    try {
      m = await req.json();
    } catch {
      return oauthError("invalid_client_metadata", "The body must be JSON.");
    }
    const redirect_uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.map(String) : [];
    if (!redirect_uris.length || !redirect_uris.every(okRedirect)) return oauthError("invalid_redirect_uri", "Each redirect URI must be https, a loopback http address, or an app's own scheme.");
    const client: Client = {
      client_id: "c_" + b64url(random(12)),
      client_name: String(m.client_name ?? "An MCP client").slice(0, 80),
      ...(typeof m.client_uri === "string" ? { client_uri: m.client_uri.slice(0, 200) } : {}),
      redirect_uris,
    };
    this.#sql.run("INSERT INTO clients (id, body, at) VALUES (?, ?, ?)", client.client_id, JSON.stringify(client), Date.now());
    return Response.json(
      { ...client, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] },
      { status: 201 },
    );
  }

  #authorize(url: URL, origin: string): Response {
    const q = url.searchParams;
    const client = this.#client(q.get("client_id") ?? "");
    const redirect = q.get("redirect_uri") ?? "";
    if (!client) return new Response("Unknown client. Register it first.", { status: 400 });
    if (!client.redirect_uris.includes(redirect)) return new Response("That redirect URI is not registered for this client.", { status: 400 });
    const back = (error: string, d: string): Response => {
      const u = new URL(redirect);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", d);
      if (q.get("state")) u.searchParams.set("state", q.get("state")!);
      return Response.redirect(u.toString(), 302);
    };
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code.");
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "")) return back("invalid_request", "PKCE with S256 is required.");
    const id = b64url(random(24));
    const code = userCode();
    this.#sql.run(
      "INSERT INTO pending (id, user_code, client_id, redirect_uri, challenge, state, scope, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')",
      id,
      code,
      client.client_id,
      redirect,
      q.get("code_challenge"),
      q.get("state"),
      q.get("scope") ?? "space",
      Date.now() + PENDING_MS,
    );
    return new Response(page(client.client_name, code, `${origin}/oauth/pending/${id}`), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
    });
  }

  /** The authorize page asks here until the person answers; `?go=1` follows the redirect without script. */
  #pending(id: string, url: URL): Response {
    const p = this.#sql.all<{ status: string; expires: number; redirect_uri: string; state: string | null; user_code: string }>(
      "SELECT status, expires, redirect_uri, state, user_code FROM pending WHERE id = ?",
      id,
    )[0];
    if (!p) return Response.json({ status: "unknown" }, { status: 404 });
    if (p.status === "waiting" && p.expires <= Date.now()) return Response.json({ status: "expired" });
    if (p.status !== "approved") return Response.json({ status: p.status });
    // The page collects the authorization code once.
    const code = b64url(random(32));
    this.#sql.run("UPDATE pending SET status = 'redirected', auth_code_hash = ?, expires = ? WHERE id = ?", sha256hex(code), Date.now() + 60_000, id);
    const u = new URL(p.redirect_uri);
    u.searchParams.set("code", code);
    if (p.state) u.searchParams.set("state", p.state);
    if (url.searchParams.get("go")) return Response.redirect(u.toString(), 302);
    return Response.json({ status: "approved", redirect: u.toString() });
  }

  async #token(req: Request): Promise<Response> {
    const f = new URLSearchParams(await req.text());
    if (f.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type", "Only authorization_code.");
    const code = f.get("code") ?? "";
    const p = this.#sql.all<{ id: string; client_id: string; redirect_uri: string; challenge: string; expires: number; log: string; gid: string; user_code: string; grant_expires: number }>(
      "SELECT id, client_id, redirect_uri, challenge, expires, log, gid, user_code, grant_expires FROM pending WHERE auth_code_hash = ? AND status = 'redirected'",
      sha256hex(code),
    )[0];
    if (!p || p.expires <= Date.now()) return oauthError("invalid_grant", "That authorization code is unknown, used or expired.");
    // Single use, whatever happens next.
    this.#sql.run("UPDATE pending SET status = 'used', auth_code_hash = NULL WHERE id = ?", p.id);
    if (f.get("client_id") !== p.client_id || f.get("redirect_uri") !== p.redirect_uri) return oauthError("invalid_grant", "client_id or redirect_uri does not match.");
    const verifier = f.get("code_verifier") ?? "";
    if (b64url(sha256(new TextEncoder().encode(verifier))) !== p.challenge) return oauthError("invalid_grant", "The PKCE verifier does not match.");
    try {
      const { token, expires } = await this.#hubs.log(p.log).mint(p.gid, p.user_code);
      return Response.json(
        { access_token: token, token_type: "Bearer", expires_in: Math.max(1, Math.floor((expires - Date.now()) / 1000)), scope: "space" },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (e) {
      return oauthError("invalid_grant", (e as Error).message);
    }
  }
}

function page(client: string, code: string, poll: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Reflex</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#e3e3e0}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--fg:#f5f5f7;--muted:#a1a1a6;--card:#1f1f21;--line:#333}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:30rem;margin:16px;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:14px}
h1{font-size:1.25rem;margin:0 0 .5rem}.code{font:600 2.2rem ui-monospace,Menlo,monospace;letter-spacing:.12em;margin:1rem 0;text-align:center}
p{margin:.5rem 0}.muted{color:var(--muted);font-size:.9rem}code{font-family:ui-monospace,Menlo,monospace}
</style></head><body><main>
<h1>${esc(client)} wants to use one of your Spaces</h1>
<p>Type this code into the terminal running <code>reflex link</code>:</p>
<div class="code" id="code">${esc(code)}</div>
<p>There you choose which Space it gets and for how long. Nothing is shared until you do.</p>
<p class="muted" id="status">Waiting for your Link… (the code works for 10 minutes)</p>
<noscript><p><a href="${esc(poll)}?go=1">Continue once you've approved it</a></p></noscript>
</main><script>
const s=document.getElementById("status");
async function tick(){try{const r=await fetch(${JSON.stringify(poll)});const j=await r.json();
if(j.status==="approved"){s.textContent="Approved. Returning to ${esc(client).replace(/"/g, "")}…";location.href=j.redirect;return}
if(j.status==="expired"||j.status==="unknown"){s.textContent="This code expired. Start again from the Agent.";return}}catch(e){}
setTimeout(tick,1500)}tick();
</script></body></html>`;
}
