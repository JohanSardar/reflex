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
import { logPath } from "../host/rpc.ts";

const KNOWN: Record<string, string> = { "claude-code": "Claude Code", "codex-mcp-client": "Codex", codex: "Codex" };

export async function runMcp() {
  const started = Date.now();
  const log = (event: string, data: Record<string, unknown> = {}) =>
    appendFileSync(logPath("mcp"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, t_s: Math.round((Date.now() - started) / 100) / 10, event, ...data }) + "\n");
  const host = await Client.open(`mcp:${process.pid}`);
  host.onClose = () => {
    log("host_closed");
    process.exit(1);
  };

  const server = new Server({ name: "reflex", version: "0.1.0" }, { capabilities: { tools: {} }, instructions });
  const who = () => {
    if (process.env.REFLEX_AGENT_NAME) return { name: process.env.REFLEX_AGENT_NAME };
    const c = server.getClientVersion();
    const name = KNOWN[c?.name ?? ""] ?? c?.name ?? "MCP client";
    return { name: `${name} · ${basename(process.cwd())}`.slice(0, 80) };
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
    try {
      const r = await host.call(tool, req.params.arguments ?? {}, who(), {
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
    host.close();
    process.exit(0);
  });
  log("mcp_started", { cwd: process.cwd(), env_agent: process.env.REFLEX_AGENT_NAME ?? null });
}
