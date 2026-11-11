// The MCP App adapter: Sends reach a chat host (Claude Desktop, claude.ai,
// ChatGPT) through Reflex's `ui://reflex/space` view (agent/src/surfaces/app.ts).
//
// A view can't be pushed to: it reaches its server only through its host, by
// calling tools. So the view holds wait_for_user through the host, and turns
// each Send it gets into a new chat turn with `ui/message`. A Send that
// arrives while no wait is held (the view is between waits, or busy posting
// the last one) is pushed here: `reflex mcp` opens this target when its host
// declares MCP Apps support, keeps the pushed Bundle for up to the push
// deadline, and answers the view's next wait_for_user with it. If no wait
// comes in time, the push fails and the Send stays in the Inbox. A cloud
// session on the Relay has no Link in the way; there the view's
// wait_for_user reads the session's own Inbox.
import { SurfaceAdapter } from "./surface.ts";

export class McpApp extends SurfaceAdapter {
  readonly name = "mcp-app";
  readonly config = {
    type: "object",
    required: ["host"],
    properties: {
      host: { type: "string", description: "The chat host showing the view, from its MCP clientInfo." },
      version: { type: "string" },
      protocol: { type: "string", description: "The MCP protocol version the session negotiated." },
      pid: { type: "integer", description: "The `reflex mcp` process serving the view." },
    },
    additionalProperties: false,
  };
}
