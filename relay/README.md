# Reflex Relay

A live forwarding service for paired iPads and Macs that cannot reach each other directly. It authenticates signed device challenges, publishes watched-device presence and forwards end-to-end encrypted frames. The Mac Link still performs pairing and agent approval.

The wire endpoint `/v0/connect?room=<32 hex>` is unchanged, so the reduced Link works through today's deployed Relay. No document log, cloud asset storage, OAuth sign-in or cloud agent runtime remains.

It also hosts the pairing room, where a Link with a live code waits for an iPad that isn't nearby (README, "The relay: pairing from anywhere"). It caps sockets per room and per address, rate-limits pairing tries and control messages, and closes sockets that don't say hello within 10 s.

```sh
reflex relay --tunnel                    # one command: a Relay plus a free Cloudflare quick tunnel
node relay/node/bin/reflex-relay.ts --help
npm run dev -w @reflex/relay
```

Node keeps WebSockets in memory; Cloudflare uses hibernatable RoomDO sockets. Other HTTP routes return 404. Check with `npm run typecheck` from the root.

Cloudflare's `v2-forward-only` migration deletes retired LogDO/AuthDO data when applied. Applying it and redeploying reflex.eilmer.si requires explicit approval. This change is source-only. Never touch relay.eilmer.si DNS.
