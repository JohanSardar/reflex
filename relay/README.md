# Reflex Relay

A live forwarding service for paired iPads and Macs that cannot reach each other directly. It authenticates signed device challenges, publishes watched-device presence and forwards end-to-end encrypted frames. The Mac Link still performs pairing and agent approval.

The wire endpoint `/v0/connect?room=<32 hex>` is unchanged, so the reduced Link works through today's deployed Relay. No document log, cloud asset storage, OAuth sign-in or cloud agent runtime remains.

```sh
node relay/node/bin/reflex-relay.ts --help
npm run dev -w @reflex/relay
```

Node keeps WebSockets in memory; Cloudflare uses hibernatable RoomDO sockets. Other HTTP routes return 404. Check with `npm run typecheck` from the root.

Cloudflare's `v2-forward-only` migration deletes retired LogDO/AuthDO data when applied. Applying it and redeploying reflex.eilmer.si requires explicit approval. This change is source-only. Never touch relay.eilmer.si DNS.
