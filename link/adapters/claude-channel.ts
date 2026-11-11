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
import { SurfaceAdapter } from "./surface.ts";

export class ClaudeChannel extends SurfaceAdapter {
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
}
