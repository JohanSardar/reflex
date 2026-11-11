# Reflex Relay

The hosted service that lets devices and Agents outside your local network reach your Spaces (SPEC §3, §13; ARCHITECTURE §2, §6, §8.4; ADR-0004). It does three things:

- **Routes** end-to-end encrypted frames between one person's devices (a Link and an iPad, or two Links), so they sync over the internet when they aren't on the same network. The devices run the same handshake as on the LAN; the Relay never sees a key or a change.
- **Keeps each Space as an encrypted log** it can't read: every change, sealed with a Space key that only your devices hold, plus the crops your Sends refer to, sealed the same way.
- **Gives cloud Agents remote MCP over OAuth.** When you approve one from your Link, your Link issues a scoped, expiring grant for one Space. Only under that grant does the Relay decrypt the Space, materialize it, and run the same `kernel` and `agent` code as the Link. When the grant ends, so does that.

The same code runs on Cloudflare (a Worker with Durable Objects and R2) and on Node (self-hosted).

```sh
npm install && sh kernel/wasm/build.sh

# Cloudflare, locally (T9 never deploys; that's T14)
cd relay/cloudflare && ../../node_modules/.bin/wrangler dev -c wrangler.toml --port 8787

# or self-hosted on Node
node relay/node/bin/reflex-relay.ts --port 8787 --dir ~/.reflex/relay

# point a Link at it (remembered; --relay off forgets it)
reflex link --relay ws://localhost:8787
```

Behind TLS, use `wss://` for the Link and pass `--origin https://relay.example.com` to the Node Relay (or set `ORIGIN` on the Worker) so the OAuth metadata names the public URL.

## A cloud Agent

1. The Agent's MCP client connects to `https://<relay>/mcp`, gets a 401 pointing at the OAuth metadata, registers itself, and opens the sign-in page.
2. The page shows a code like `K7QD-2MXP`. Type it into the terminal running `reflex link`. The Link says who is asking, and asks which Space and for how long (default 1 hour, at most 30 days). Nothing else can grant one: not the admin RPC, not a command.
3. The Link signs a grant for that Space and sends it, with the Space key, to the Relay. The page continues, the client gets an access token, and every MCP call from then on runs in a cloud session on that one Space.
4. `reflex link relay` lists grants; `reflex link relay revoke <grant>` ends one at once. The Link also stops taking in anything that grant writes, whether or not the Relay heard.

The Agent writes as its own Agent ID (`a_rc…`), through the kernel's checks, like any Agent. The Link takes its changes in only through the kernel's checked receive, only as that Agent, and only while the grant is live.

| Path | What it is |
|---|---|
| `domain/wire.ts` | the wire format (`reflex-relay/v0`): rooms, frames, requests, grants |
| `domain/seal.ts` | Space-key derivations and sealing (AES-256-GCM, HMAC-SHA256), Ed25519 checks |
| `domain/room.ts` | a room: device hellos, presence, frame routing, requests passed on to logs |
| `domain/log.ts` | a Space's log: sealed entries, the log token, grants, access tokens, assets, stats |
| `domain/session.ts` | the cloud session: the kernel and the Agent layer on one granted Space, served as remote MCP |
| `domain/oauth.ts` | OAuth 2.1: metadata, dynamic registration, the sign-in page, PKCE, tokens |
| `domain/http.ts` | the HTTP routes |
| `domain/ports.ts` | what the core needs from a platform (SQL, a bucket, sockets, the other pieces) |
| `cloudflare/` | the Worker and its Durable Objects (`RoomDO`, `LogDO`, `AuthDO`), R2, and the build step |
| `node/` | the self-hosted Relay (`node:sqlite`, a folder, `ws`) |

The Link's side is `link/transports/relay.ts` (the transport) and `link/relay/` (keys, the log, grants).

## Guarantees

- **The Relay can't read your Spaces.** Entries and assets are sealed with keys derived from the Space key (`domain/seal.ts`), which stays on your devices. The log is named by a value derived from that key, so the Relay doesn't learn Space names either. It does see who connects, when, from where, and how big things are.
- **Only key holders write a log.** The first write sets the log's token (derived from the Space key); the Relay keeps only its hash, and every later read or write must present it.
- **Devices prove who they are.** A device joins a room by signing the Relay's challenge with its device key. The Relay forwards frames only to a device that accepts the sender, and stamps each frame with the sender's real device ID. The end-to-end handshake inside still decides trust, as on the LAN.
- **Grants are signed, scoped and expiring.** One Space, one key epoch, at most 30 days, signed by the device that issued it. The Space key arrives with the grant and is kept as is only until the token exchange (at most 10 minutes); then it is wrapped under the access token, which the Relay keeps only as a hash. Revoking or expiring a grant deletes its tokens, its session state and the session in memory.
- **Revocation can't make anyone forget.** A cloud Agent necessarily sees the Space it was granted, and the service running it could keep what it saw (ADR-0004).
- **Durable before visible.** An Agent change in a cloud session is sealed and appended to the log before the call returns. The Link journals what it takes in before anything sees it.
- **Recovers.** On every reconnect each side catches up from where it was: devices rerun anti-entropy over their new path, the Link reads the log from its last entry, and a cloud session replays the log from its newest snapshot. A Relay that lost entries is noticed (its log is shorter than what the Link read) and gets the whole Space again.

## Memory: a real Space in a Durable Object

A cloud session loads the Space's newest snapshot directly (the Link writes the whole Space as a snapshot when it first pushes, and again after 4 MB of changes), then reads the log after it 32 entries at a time. Measured under `wrangler dev` (WASM linear memory, which only grows):

| Space | Elements | Snapshot | WASM memory |
|---|---|---|---|
| a plan (`plan`) | 9 | 3.5 KB | 1.4 MB |
| 1,000 strokes of 80 points | 1,000 | 0.46 MB | 39 MB |
| `big` | 3,500 (70 Sends) | 5.5 MB | 232 MB |

Automerge's whole-document load peaks at about three times what the same Space takes when built change by change. A Space of up to roughly 2,000 strokes fits in a Worker. A bigger one does not: the session refuses it with `507` and a message pointing to a self-hosted Relay, and doesn't try again until the Space has a new snapshot. If it died while loading, it is refused next time instead of taking the Durable Object down on every call. `SESSION_MEMORY_LIMIT` sets the budget (default 96 MB of the isolate's 128). The Node Relay has no limit. Per ADR-0004, if real Spaces outgrow a Worker, cloud execution moves to a separate service and the Durable Object stays the router and log. `GET /v0/log/<log>/stats` with a grant's token reports the session's own numbers and digest.

## Not here yet

- Only Links write the log. The iPad syncs through the Relay (routing, end to end) but doesn't read or write the log itself, so its changes reach the log through a Link.
- Two Links of one person share Space keys over their end-to-end session; if both had made a key for the same Space before they first met, both keep the one whose log sorts first, and the other log is left behind.
- Both Links push what they hold, so a log can hold the same change twice. Duplicates are harmless.
- Space titles and sizes (the Link's `space_meta`) aren't in the log; a cloud session uses the defaults.
- A Space whose snapshot is over 15 MB can't go in one entry.
- Key rotation, invites and other people's devices come with shared Spaces (T22). Deploying to relay.eilmer.si is T14.
