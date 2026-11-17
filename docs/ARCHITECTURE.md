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

`/v0/connect?room=<room>` authenticates device keys and forwards encrypted frames. It tells presence only between devices that watch each other, and delivers a frame only to a device that watches its sender. It stores no document log or assets and runs no OAuth or cloud agents. The forwarding wire remains compatible with existing paired clients.

Pairing from anywhere uses one fixed **pairing room**, `PAIRING_ROOM` in `relay/domain/wire.ts`; its name derives from no part of any code.
- While a typed code is live, the Link waits there under a throwaway relay identity.
- An iPad that finds no Mac nearby tries the code on each Link waiting there. The check is CPace over X25519 (`link/pairing/cpace.ts`, `Cpace.swift`), with the auth MACs as key confirmation.
- A wrong try counts against the code's 5. Names are blanked on relay paths; each side sends a sealed `who` once the session is up.
- After pairing, sessions use the person's room as before.
- A Link on its own relay (`REFLEX_RELAY`, or `--relay`, remembered) also waits on the default relay, only to answer `moved` with its relay's URL.

The Room caps sockets per room and per address, limits new pairing-room channels per socket and per address, rate-limits control messages, and closes sockets that don't say hello within 10 s. The Node server also limits connections per address. See docs/research/relay-croc-happy.md for how this compares with croc and Happy.

Node and Cloudflare share the Room implementation. The Cloudflare migration retires LogDO and AuthDO, deleting their stored data when applied. Deployment requires explicit approval; this change does not deploy. Today's deployed Relay can still forward connections from the reduced Link.

## Removed surfaces

Canvas writing tools, execution, undo, Recipes, Behaviors, Regions, Embeds, model import and math authoring are absent from the agent API. Shared Spaces/invites, author kit, web viewer, protocol package and its conformance/scenario suite are removed. Historical documentation is preserved on `archive/canvas-v0`.
