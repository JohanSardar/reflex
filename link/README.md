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

The iPad sends an immutable `send` envelope and its referenced image assets over the paired encrypted connection. The Link checks the authenticated iPad's identity and validates the envelope, verifies images, and commits the Send and Inbox recipients in one SQLite transaction before replying `send_ack`. Retries with the same Send ID do not create another delivery.

Sends live in `native_sends`; the existing Inbox and per-agent receipts remain. Approved agents receive new Sends. Sends made before an agent is approved are adopted by the first approved receiver. `wait_for_user(after: ...)` acknowledges delivery; Claude Code channel and webhook pushes share the same bundle builder, including mark geometry, raw strokes, timed words and the iPad's screen crops.

No Rust kernel, Automerge replica, document synchronization, live ink/presence stream, shared Spaces, agent scene, or cloud log is used. Existing database tables remain intact for archival recovery; the new runtime never loads their old document bytes. Check with `npm run typecheck`.
