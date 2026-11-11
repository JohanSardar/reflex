// The MCP surface: a stdio server that forwards every tool call to the host.
// It also writes a log of what the harness does on the wire (the protocol
// version it asks for, progress tokens, cancellations, a pipe that closes
// mid-call), which is how docs/harness-notes.md was written.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

// With --channel, a Claude Code session also gets Sends pushed as new turns (a Claude Code channel,
// docs/harness-notes.md): `notifications/claude/channel` with the Send Bundle as its content.
const CHANNEL = "claude/channel";
const CHANNEL_HARNESSES = new Set(["Claude Code"]);
const CHANNEL_INSTRUCTIONS = `

Sends are also pushed to you: when the person presses Send while you are not in wait_for_user, the Send Bundle arrives on its own as a <channel source="reflex" ...> message. Treat it exactly like a Bundle wait_for_user returned, and follow its next: answer with apply(in_reply_to), or acknowledge it with wait_for_user(after, timeout_s: 0), then end your turn. Its images are PNG files: read the paths in images[].file. You don't need to sit in wait_for_user to hear from the person.`;

/**
 * Whether the Claude Code session that started this server turned channels on. Claude Code drops channel
 * notifications from a server that isn't in its --channels (or --dangerously-load-development-channels) list
 * without telling the server, so a push there would never reach the session. The flags are looked for on the
 * parent's command line and a few ancestors' (a wrapper such as npx may sit in between); when the command
 * lines can't be read, the channel is assumed on.
 */
function sessionHasChannels(): { on: boolean; why: string } {
  const flag = /\s--(channels|dangerously-load-development-channels)[\s=]/;
  let pid = process.ppid;
  try {
    for (let depth = 0; depth < 4 && pid > 1; depth++) {
      const line = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
      const m = /^(\d+)\s+(.*)$/s.exec(line);
      if (!m) break;
      if (flag.test(` ${m[2]} `)) return { on: true, why: "the session was started with a channels flag" };
      pid = Number(m[1]);
    }
  } catch {
    return { on: true, why: "the session's command line could not be read" };
  }
  return { on: false, why: "the session was started without --channels or --dangerously-load-development-channels" };
}

export async function runMcp(o: { channel?: boolean } = {}) {
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

  const server = new Server(
    { name: "reflex", version: "0.1.0" },
    { capabilities: { tools: {}, ...(o.channel ? { experimental: { [CHANNEL]: {} } } : {}) }, instructions: instructions + (o.channel ? CHANNEL_INSTRUCTIONS : "") },
  );
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
      // A file the person added that isn't text: its bytes as an embedded resource (text is already in the JSON).
      for (const f of r.files ?? []) {
        const entry = (r.json.files ?? []).find((x: any) => x.id === f.id);
        if (entry?.text === undefined) content.push({ type: "resource", resource: { uri: `reflex://${r.json.space}/files/${f.id}`, mimeType: f.mime, blob: f.data } });
      }
      const pending = r.json.pending_sends ?? r.json.pending_after;
      if (pending > 0 && tool !== "wait_for_user") content.push({ type: "text", text: `📥 ${pending} pending Send${pending === 1 ? "" : "s"}. Read with wait_for_user(timeout_s: 0).` });
      return { content, isError: r.isError };
    } catch (e) {
      log("call_failed", { tool, error: String((e as Error).message) });
      throw e;
    }
  });

  const transport = new StdioServerTransport();
  let asked = ""; // the protocol version the harness asked for in initialize
  await server.connect(transport);
  // Log every message the harness sends, before the SDK handles it.
  const handle = transport.onmessage!;
  transport.onmessage = (msg: any) => {
    const p = msg.params ?? {};
    if (msg.method === "initialize") asked = String(p.protocolVersion ?? "");
    log("recv", {
      method: msg.method ?? "(response)",
      id: msg.id ?? null,
      ...(msg.method === "initialize" ? { protocolVersion: p.protocolVersion, clientInfo: p.clientInfo, capabilities: p.capabilities } : {}),
      ...(msg.method === "tools/call" ? { tool: p.name, meta: p._meta ?? null } : {}),
      ...(msg.method === "notifications/cancelled" ? { cancelled: p } : {}),
    });
    handle(msg);
  };
  server.oninitialized = () => {
    log("initialized", { negotiated: (transport as any)._protocolVersion ?? null, client: server.getClientVersion(), capabilities: server.getClientCapabilities() });
    if (!o.channel) return;
    const harness = KNOWN[server.getClientVersion()?.name ?? ""] ?? server.getClientVersion()?.name ?? "MCP client";
    // Only Claude Code has channels. Elsewhere Sends reach the Agent the guaranteed way, through wait_for_user.
    if (!CHANNEL_HARNESSES.has(harness)) return log("channel_unsupported", { harness });
    const session = sessionHasChannels();
    if (!session.on) return log("channel_off", { harness, why: session.why });
    void openChannel(harness);
  };

  // The channel: a second connection to the Link that holds a push target for this Agent. The Link pushes
  // each new Send that no wait_for_user took; it becomes a channel notification, which Claude Code turns into
  // a new turn. If the Link isn't running or restarts, it reconnects.
  async function openChannel(harness: string) {
    for (;;) {
      let c: Client | undefined;
      let wait = 3000;
      try {
        c = await Client.open(`mcp-channel:${process.pid}`);
        const closed = new Promise<void>((r) => (c!.onClose = r));
        const config = { harness, version: server.getClientVersion()?.version ?? "", protocol: asked, pid: process.pid };
        const { target, agent } = await c.listen(who(), "claude-channel", config, push);
        log("channel_open", { target, agent });
        await closed;
        log("channel_closed");
      } catch (e) {
        const error = String((e as Error).message);
        log("channel_failed", { error });
        c?.close();
        // The person turned this Agent away: don't keep asking them.
        if (/^(rate_limited|not_approved)/.test(error)) wait = 60_000;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  async function push(p: { json: Record<string, any>; images: string[]; deadline: number }) {
    const bundle = p.json;
    if (!process.stdout.writable) return { ok: false, reason: "the session's pipe is closed" };
    // Channel content is text, so the crops go to files the session can read, as on the CLI.
    const dir = join(tmpdir(), "reflex");
    mkdirSync(dir, { recursive: true });
    p.images.forEach((b64, i) => {
      const file = join(dir, `${bundle.send}-${i + 1}.png`);
      writeFileSync(file, Buffer.from(b64, "base64"));
      const entry = bundle.images?.[i];
      if (entry) entry.file = file;
    });
    const meta: Record<string, string> = { space: String(bundle.space), send: String(bundle.send), kind: String(bundle.kind) };
    if (bundle.from?.name) meta.from = String(bundle.from.name);
    // Writing the images took time; past the deadline the Link has given up on this push, so it must not land.
    if (Date.now() > p.deadline) return { ok: false, reason: "arrived after its deadline" };
    await server.notification({ method: "notifications/claude/channel", params: { content: JSON.stringify(bundle), meta } });
    log("channel_push", { send: bundle.send, space: bundle.space, kind: bundle.kind, bytes: JSON.stringify(bundle).length, images: p.images.length });
    return { ok: true };
  }
  process.stdin.on("end", () => {
    log("stdin_closed");
    void host?.then((c) => c.close(), () => {});
    process.exit(0);
  });
  log("mcp_started", { cwd: process.cwd(), env_agent: process.env.REFLEX_AGENT_NAME ?? null, channel: Boolean(o.channel) });
}
