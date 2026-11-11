// The Claude Code channel adapter: the first push Send Adapter (SPEC §9).
//
// Claude Code channels (a research preview) let a stdio MCP server start a new
// turn in a running session: the server declares `experimental["claude/channel"]`
// and sends `notifications/claude/channel`. Here that server is `reflex mcp
// --channel`. It opens a push target on its connection to the Link (a `listen`
// frame, link/agent-host.ts), and this adapter sends each Send Bundle down that
// connection; the surface turns it into the notification (agent/src/surfaces/mcp.ts)
// and answers once it is written to Claude Code's pipe. The session replies with
// Reflex tools, so the callback is `mcp`.
import type { Listener } from "../../agent/src/host/server.ts";
import type { Push, PushAdapter, PushOutcome, PushTarget } from "./contract.ts";

export class ClaudeChannel implements PushAdapter {
  readonly name = "claude-channel";
  readonly config = {
    type: "object",
    required: ["harness"],
    properties: {
      harness: { type: "string", description: "The harness that opened the channel, from its MCP clientInfo." },
      version: { type: "string" },
      protocol: { type: "string", description: "The MCP protocol version the session negotiated." },
      pid: { type: "integer", description: "The `reflex mcp` process holding the channel." },
    },
    additionalProperties: false,
  };
  #live = new Map<string, { listener: Listener; since: number }>();

  /** A surface's channel connection is live for `target` until it closes. */
  attach(target: PushTarget, listener: Listener, onClose: () => void) {
    const entry = { listener, since: Date.now() };
    this.#live.set(target.id, entry);
    void listener.closed.then(() => {
      if (this.#live.get(target.id) === entry) this.#live.delete(target.id);
      onClose();
    });
  }

  liveSince(target: PushTarget) {
    return this.#live.get(target.id)?.since;
  }

  async deliver(target: PushTarget, push: Push): Promise<PushOutcome> {
    const live = this.#live.get(target.id);
    if (!live) return { ok: false, reason: "the session's channel is closed" };
    const r = await live.listener.push(push.bundle, push.images);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "the session did not take it" };
  }
}
