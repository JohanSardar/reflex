# Reflex Link

The per-profile Mac companion receives Sends from a paired iPad and delivers them to approved Claude Code or Codex receivers through `wait_for_user`, Claude Code channels or signed webhooks.

```sh
node agent/bin/reflex.mjs setup
node agent/bin/reflex.mjs pair
node agent/bin/reflex.mjs link status
node agent/bin/reflex.mjs link agents
node agent/bin/reflex.mjs link revoke <agent>
node agent/bin/reflex.mjs link stop
```

Pairing codes are expiring and single-use. Approval belongs to the person on an approving iPad, or the Link terminal before an approving iPad exists. The admin socket never grants approval. Profile credentials protect both local sockets.

LAN, optional Apple peer-to-peer Wi-Fi and Relay forwarding reach paired devices. `--relay off` disables the Relay; `--relay <ws-url>` selects one. No encrypted cloud log or cloud agent grants remain.

Today's kernel journal, document sync, asset transfer and Inbox remain until T25 replaces them. T25 owns `send`/`send_ack` ingestion; the coordinator keeps a generic session-message hook. Shared Spaces/invites, web viewer, Behaviors and watched Regions are removed. Check with `npm run typecheck`.
