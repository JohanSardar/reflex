# Architecture

Reflex carries the person's iPad input to a local coding agent. The agent receives Sends and answers in Claude Code or Codex. It has no canvas mutation capability.

## Mac Link

One Link runs per profile. Its private local sockets require profile credentials. Agents supply stable credentials; a signed catalog records the person's approval, denial or revocation. The first approving iPad pairs through a short-lived, single-use code. Further approval authority comes from an approving iPad. Setup and background autostart remain available.

The Link connects paired devices over LAN, Apple peer-to-peer Wi-Fi when available, and optional Relay forwarding. Each path performs the same authenticated end-to-end handshake. Path selection and reconnect repair remain in the sync coordinator.

## Temporary compatibility bridge

Today's iPad freezes Sends inside a kernel-backed document. Its journal, document sync, assets and durable Inbox remain so this iPad still delivers Sends. The generated Rust validation table needed by the kernel now lives inside `kernel/core/src/`, outside the removed protocol package.

The read-only Send projection and fallback renderer remain for old device Sends. No agent operation changes the document. Behaviors are neither executed nor watched on the Mac.

T25 owns the native durable Send table, iPad outbox and replacement ingestion at both ends. Its session messages are `send` and `send_ack`; the coordinator's generic session callback remains available. Whoever merges second rebases.

## Delivery

The host checks approval for calls and push targets. `wait_for_user` reads the Inbox and acknowledges a previous Send with `after`. Claude Code channel push and signed webhooks share the existing dispatcher, receipts and retry/fallback behavior. The MCP App viewer is removed. Responses belong in the coding agent's own session.

## Relay

`/v0/connect?room=<room>` authenticates device keys, publishes watched-device presence and forwards encrypted frames. It stores no document log or assets and runs no OAuth or cloud agents. The forwarding wire remains compatible with existing paired clients.

Node and Cloudflare share the Room implementation. The Cloudflare migration retires LogDO and AuthDO, deleting their stored data when applied. Deployment requires explicit approval; this change does not deploy. Today's deployed Relay can still forward connections from the reduced Link.

## Removed surfaces

Canvas writing tools, execution, undo, Recipes, Behaviors, Regions, Embeds, model import and math authoring are absent from the agent API. Shared Spaces/invites, author kit, web viewer, protocol package and its conformance/scenario suite are removed. Historical documentation is preserved on `archive/canvas-v0`.
