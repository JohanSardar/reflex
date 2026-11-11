// The MCP App Send Adapter's server side (SPEC §9; the MCP Apps extension,
// `io.modelcontextprotocol/ui`, 2026-01-26).
//
// Every Reflex MCP server (`reflex mcp` and the Relay's /mcp) offers one view,
// `ui://reflex/space`, tied to `open_space`. A chat host that supports MCP
// Apps (Claude, ChatGPT, the reference host) renders it when the Agent opens a
// Space. The view:
//   - shows the Space: it calls `look` through the host and redraws it after
//     each Send and every 20 s while it is on screen;
//   - holds `wait_for_user` through the host, so a Send the person presses on
//     their iPad reaches it (the Inbox decides who gets it, once);
//   - posts each Send to the chat with `ui/message`, which the host turns into a
//     new user turn, with the Bundle as text and its crops as images. Once the
//     host took it, the Agent has it in its conversation, so the view's next
//     wait acknowledges it (`after`). A Send the host refuses stays pending for
//     the Agent, and the view stops taking Sends.
// It never draws or writes: the person draws on their devices. The tools are
// the usual eleven; nothing is added for the view.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VIEW_HTML } from "./app-view.ts";

export const APP_EXTENSION = "io.modelcontextprotocol/ui";
export const APP_URI = "ui://reflex/space";
export const APP_MIME = "text/html;profile=mcp-app";

/** The `_meta` a tool carries in tools/list: `open_space` names the view. */
export function toolMeta(tool: string): Record<string, unknown> | undefined {
  return tool === "open_space" ? { ui: { resourceUri: APP_URI }, "ui/resourceUri": APP_URI } : undefined;
}

/** Whether the client said it renders MCP Apps views. */
export function hostShowsApps(capabilities: unknown): boolean {
  const ext = (capabilities as { extensions?: Record<string, { mimeTypes?: string[] }> } | undefined)?.extensions?.[APP_EXTENSION];
  return Boolean(ext) && (!ext!.mimeTypes || ext!.mimeTypes.includes(APP_MIME));
}

/** Serves the view as a resource. The server must declare `capabilities.resources`. */
export function serveApp(server: Server) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: APP_URI, name: "space", title: "Reflex Space", description: "The Space the Agent opened, live, with the person's Sends posted to the chat.", mimeType: APP_MIME }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== APP_URI) throw new Error(`No resource ${req.params.uri}. Reflex has one: ${APP_URI}.`);
    // No network: the view reaches Reflex only through its host's tools/call, and shows images as data: URLs.
    return { contents: [{ uri: APP_URI, mimeType: APP_MIME, text: VIEW_HTML, _meta: { ui: { prefersBorder: true } } }] };
  });
}
