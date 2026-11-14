// The local Send receiver's MCP contract. There is no canvas writing API.
export const TOOLS = ["wait_for_user"] as const;
export type Tool = (typeof TOOLS)[number];
export const instructions = "Receive the person's marks, words and screen from their paired iPad. Use wait_for_user to receive a Send, then answer in your own session. Acknowledge it with after on your next wait. You cannot write to the canvas.";
export const description = (_tool: Tool) => "Wait for a Send from the paired iPad. after acknowledges a previous Send. timeout_s: 0 checks the Inbox immediately.";
export const inputSchema = (_tool: Tool) => ({ type: "object" as const, properties: { space: { type: "string" }, after: { type: "string" }, timeout_s: { type: "number", minimum: 0, maximum: 3600 } }, additionalProperties: false });
export type ProtocolError = { code: string; msg: string; fix: string };
