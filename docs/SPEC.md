# Reflex specification

The person marks, speaks or writes on their iPad and presses Send. A paired Mac delivers that Send to an approved Claude Code or Codex receiver. The agent sees words, marks and screen and answers in its own session. It cannot write on the canvas.

## Setup and trust

`reflex setup` prepares the checkout, connects the selected harness and starts the Link. Scan a short-lived pairing code on the iPad. `reflex pair` makes another code. Pairing does not bypass approval. Allow/Deny appears on approving iPads, including after reconnect. Before an approving iPad exists, the Link terminal can approve. Commands can deny or revoke, but cannot approve agents.

## Delivery

Approved agents receive Sends with `wait_for_user`, Claude Code channel pushes or signed webhooks. Wait up to 3600 seconds, filter by source document or poll with timeout zero. Acknowledge a previous Send with `after`. Delivery state persists across restarts; failed pushes remain available for a later wait. Revoked agents lose access.

Today's iPad still sends through its synced kernel document and assets. T24 retains that path. T25 owns the native Send producer, outbox, durable receiver and acknowledgement protocol. Existing paired devices remain connected while these changes land.

## Connectivity

The Link uses local networking and optional Apple peer-to-peer Wi-Fi. The Relay remains an optional way for paired devices to reach each other off the same network. It forwards end-to-end encrypted frames. The Mac remains the trusted receiver; the Relay has no encrypted document log, shared Space, OAuth grant or cloud agent.

## Scope

No agent canvas drawing, editing, undo, Recipes, Behaviors, Regions, Embeds, 3D or math authoring. No shared Spaces/invites, web viewer, author kit, protocol package, conformance suite or scenario gallery. Earlier work is preserved on GitLab branch `archive/canvas-v0`.

The iPad app is T25's scope. This change does not edit its files. The kernel and legacy Send projection remain until T25 removes them.
