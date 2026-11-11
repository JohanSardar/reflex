// The MCP surface: a stdio server that forwards every tool call to the host.
// It also writes a log of what the harness does on the wire (the protocol
// version it asks for, progress tokens, cancellations, a pipe that closes
// mid-call), which is how docs/harness-notes.md was written.
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, description, inputSchema, instructions } from "../protocol.ts";
import { Client } from "../host/client.ts";
import { credential, logPath, NoLink } from "../host/rpc.ts";

const KNOWN: Record<string, string> = { "claude-code": "Claude Code", "codex-mcp-client": "Codex", codex: "Codex" };
// Longest wait_for_user the surface holds, a little under the harness's default hard tool timeout, so a long
// wait ends in still_waiting instead of a harness error (docs/harness-notes.md). Codex cuts every call at 300 s
// and progress does not extend it; Claude Code's hard limit is far above wait_for_user's 3600 s maximum.
// REFLEX_MAX_WAIT_S overrides it, for a Codex whose tool_timeout_sec was raised.
const MAX_WAIT_S: Record<string, number> = { Codex: 280 };

export async function runMcp() {
  const started = Date.now();
  const log = (event: string, data: Record<string, unknown> = {}) =>
    appendFileSync(logPath("mcp"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, t_s: Math.round((Date.now() - started) / 100) / 10, event, ...data }) + "\n");
  // The Link is reached on the first call, and again after it restarts, so a harness can start before it.
  let host: Promise<Client> | undefined;
  const link = () =>
    (host ??= Client.open(`mcp:${process.pid}`).then(
      (c) => {
        c.onClose = () => {
          log("link_closed");
          host = undefined;
        };
        return c;
      },
      (e) => {
        host = undefined;
        throw e;
      },
    ));

  const server = new Server({ name: "reflex", version: "0.1.0" }, { capabilities: { tools: {} }, instructions });
  const who = () => {
    const c = server.getClientVersion();
    const name = process.env.REFLEX_AGENT_NAME ?? `${KNOWN[c?.name ?? ""] ?? c?.name ?? "MCP client"} · ${basename(process.cwd())}`.slice(0, 80);
    return { name, credential: credential(name) };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t, description: description(t), inputSchema: inputSchema(t) })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = req.params.name;
    const progressToken = req.params._meta?.progressToken;
    const callStarted = Date.now();
    let progressSent = 0;
    log("call_start", { tool, request: extra.requestId, progressToken: progressToken ?? null, args_bytes: JSON.stringify(req.params.arguments ?? {}).length });
    extra.signal.addEventListener("abort", () => log("call_aborted", { tool, request: extra.requestId, after_s: (Date.now() - callStarted) / 1000 }), { once: true });
    let args: Record<string, unknown> = req.params.arguments ?? {};
    const cap = Number(process.env.REFLEX_MAX_WAIT_S) || MAX_WAIT_S[KNOWN[server.getClientVersion()?.name ?? ""] ?? ""];
    if (tool === "wait_for_user" && cap && typeof args.timeout_s === "number" && args.timeout_s > cap) {
      log("wait_capped", { asked: args.timeout_s, cap });
      args = { ...args, timeout_s: cap };
    }
    try {
      let client: Client;
      try {
        client = await link();
      } catch (e) {
        if (!(e instanceof NoLink)) throw e;
        log("no_link", { tool, error: e.message });
        const json = { ok: false, reason: "unavailable", errors: [{ code: "unavailable", msg: e.message, fix: "Ask the person to start the Reflex Link (`reflex link`), then call again." }] };
        return { content: [{ type: "text", text: JSON.stringify(json) }], isError: true };
      }
      const r = await client.call(tool, args, who(), {
        signal: extra.signal,
        progress: (p) => {
          if (progressToken === undefined) return;
          progressSent++;
          void extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: p.elapsed_s, total: p.timeout_s, message: `Waiting for the person to press Send (${p.elapsed_s}s)` },
          });
        },
      });
      log("call_end", { tool, request: extra.requestId, s: (Date.now() - callStarted) / 1000, isError: r.isError, progressSent, status: r.json.status ?? r.json.kind ?? (r.json.ok === false ? r.json.reason : "ok") });
      const content: any[] = [{ type: "text", text: JSON.stringify(r.json) }];
      for (const data of r.images) content.push({ type: "image", data, mimeType: "image/png" });
      const pending = r.json.pending_sends ?? r.json.pending_after;
      if (pending > 0 && tool !== "wait_for_user") content.push({ type: "text", text: `📥 ${pending} pending Send${pending === 1 ? "" : "s"}. Read with wait_for_user(timeout_s: 0).` });
      return { content, isError: r.isError };
    } catch (e) {
      log("call_failed", { tool, error: String((e as Error).message) });
      throw e;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log every message the harness sends, before the SDK handles it.
  const handle = transport.onmessage!;
  transport.onmessage = (msg: any) => {
    const p = msg.params ?? {};
    log("recv", {
      method: msg.method ?? "(response)",
      id: msg.id ?? null,
      ...(msg.method === "initialize" ? { protocolVersion: p.protocolVersion, clientInfo: p.clientInfo, capabilities: p.capabilities } : {}),
      ...(msg.method === "tools/call" ? { tool: p.name, meta: p._meta ?? null } : {}),
      ...(msg.method === "notifications/cancelled" ? { cancelled: p } : {}),
    });
    handle(msg);
  };
  server.oninitialized = () => log("initialized", { negotiated: (transport as any)._protocolVersion ?? null, client: server.getClientVersion(), capabilities: server.getClientCapabilities() });
  process.stdin.on("end", () => {
    log("stdin_closed");
    void host?.then((c) => c.close(), () => {});
    process.exit(0);
  });
  log("mcp_started", { cwd: process.cwd(), env_agent: process.env.REFLEX_AGENT_NAME ?? null });
}
