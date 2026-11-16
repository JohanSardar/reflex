// The local Send receiver's MCP contract. There is no canvas writing API.
export const TOOLS = ["connect", "wait_for_user"] as const;
export type Tool = (typeof TOOLS)[number];
export const instructions =
  "Receive the person's marks, words and screen from their iPad. The person reads only your reply text, never tool results. " +
  "When they ask to connect, pair or set up their iPad (or Reflex), call connect, then write its 6-digit code and tell_the_person in your reply, and only then call wait_for_user. " +
  "When wait_for_user returns a Send, do what it asks and write your answer in your reply, then call wait_for_user again with after set to that Send's ID, so you keep hearing from them without being asked. You cannot write to the canvas.";
export const description = (tool: Tool) =>
  tool === "connect"
    ? "Connect the person's iPad to this session. Returns a 6-digit code for them to type in Reflex on their iPad (or says it's connected already). Call it when they ask to connect, pair or set up their iPad."
    : "Wait for a Send from the paired iPad. after acknowledges a previous Send. timeout_s: 0 checks the Inbox immediately.";
export const inputSchema = (tool: Tool) =>
  tool === "connect"
    ? { type: "object" as const, properties: {}, additionalProperties: false }
    : { type: "object" as const, properties: { space: { type: "string" }, after: { type: "string" }, timeout_s: { type: "number", minimum: 0, maximum: 3600 } }, additionalProperties: false };
export type ProtocolError = { code: string; msg: string; fix: string };
