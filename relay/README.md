# Reflex Relay (`relay/`)

A forwarding service for an iPad and a Mac that can't reach each other directly. Devices meet in a _room_. The Relay
checks each device's signed challenge, tells devices which of the ones they watch are online, and forwards frames that
are end-to-end encrypted between them. It can't read them and keeps nothing. Pairing and agent approval stay on the
Link (`link/`).

It also hosts the _pairing room_, where a Link with a live 6-digit code waits for an iPad that isn't nearby. It caps
sockets per address (and in the pairing room in all), rate-limits pairing tries and control messages, and closes a
socket that doesn't say hello within 10 s.

```sh
reflex relay --tunnel                    # a Relay of your own plus a free Cloudflare quick tunnel
node relay/node/bin/reflex-relay.ts --help
npm run dev -w @reflex/relay             # the Cloudflare Worker locally (wrangler dev)
```

| Path          | What it is                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`     | Everything a Relay does, shared by both hosts: the wire (`wire.ts`, `/v0/connect?room=<32 hex>`), challenge signatures (`seal.ts`), rooms (`room.ts`) and what a room needs from its host (`ports.ts`). |
| `node/`       | A Relay in one Node process (`server.ts`) and its command (`bin/reflex-relay.ts`). WebSockets stay in memory.                                                                                           |
| `cloudflare/` | The deployed Relay: a Worker with one Durable Object per room and hibernatable WebSockets.                                                                                                              |

The wire is versioned (`reflex-relay/v0`, in `domain/wire.ts`): a change older Links and iPads can't follow needs a
new version. Paths other than the room WebSocket answer with a line saying what this is (`/`, `/health`) or 404.

## Deploying

The Cloudflare Relay at reflex.eilmer.si is deployed by hand, and only with the owner's explicit approval. The
`v2-forward-only` migration in `cloudflare/wrangler.toml` deletes the retired LogDO and AuthDO data when it is
applied. Never touch the relay.eilmer.si DNS.

## Developing

From the repository root: `npm ci`, then `npm run check` runs every check CI runs on a PR. `relay/domain` must run
on both Node and Cloudflare Workers, so it imports neither `node:` modules nor `cloudflare:` ones.
