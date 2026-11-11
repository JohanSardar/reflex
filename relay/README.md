# Reflex Relay

The hosted service that lets devices and Agents outside your local network reach your Spaces (SPEC §3, §13; ARCHITECTURE §2, §6, §8.4; ADR-0004). It does three things:

- **Routes** end-to-end encrypted frames between one person's devices (a Link and an iPad, or two Links), so they sync over the internet when they aren't on the same network. The devices run the same handshake as on the LAN; the Relay never sees a key or a change.
- **Keeps each Space as an encrypted log** it can't read: every change, sealed with a Space key that only your devices hold, plus the crops your Sends refer to, sealed the same way.
- **Gives cloud Agents remote MCP over OAuth.** When you approve one from your Link, your Link issues a scoped, expiring grant for one Space. Only under that grant does the Relay decrypt the Space, materialize it, and run the same `kernel` and `agent` code as the Link. When the grant ends, so does that.

The same code runs on Cloudflare (a Worker with Durable Objects and R2) and on Node (self-hosted).

The official Relay runs at `https://reflex.eilmer.si`, and a Link uses it unless you pick another:

```sh
reflex link                                    # syncs through wss://reflex.eilmer.si
reflex link --relay wss://relay.example.com    # your own Relay instead (remembered)
reflex link --relay off                        # no Relay, LAN only (remembered)
```

`REFLEX_RELAY` sets the default for a Link profile that hasn't chosen one. An iPad uses whatever Relay its Link tells it about.

## Running it locally

```sh
npm install && sh kernel/wasm/build.sh

# Cloudflare, locally
cd relay/cloudflare && ../../node_modules/.bin/wrangler dev   # on :8787; [dev] in wrangler.toml keeps local URLs local

# or self-hosted on Node
node relay/node/bin/reflex-relay.ts --port 8787 --dir ~/.reflex/relay

# point a Link at it
reflex link --relay ws://localhost:8787
```

## Deploying

`relay/cloudflare/wrangler.toml` is the official deployment: the Worker `reflex-relay`, its three Durable Object classes, the R2 bucket `reflex-relay-assets`, served only at the custom domain `reflex.eilmer.si` (no `workers.dev` address, so the OAuth metadata always names one origin). To redeploy, with `wrangler login` done for that account:

```sh
npm install && sh kernel/wasm/build.sh
cd relay/cloudflare && ../../node_modules/.bin/wrangler deploy
```

`wrangler deploy` runs `build.ts` first. The bundle is about 2.6 MB gzipped (Workers allow 3 MB on the Free plan). Durable Object state and R2 objects survive a redeploy; a change to a Durable Object class needs a new `[[migrations]]` entry.

The Relay holds no secrets: every key it checks belongs to a device or is derived from a Space key, and it keeps tokens only as hashes. If one is ever needed, set it with `wrangler secret put <NAME>`, never in `wrangler.toml` or the repo. Its settings are plain vars: `SESSION_MEMORY_LIMIT` (bytes, default 96 MB) and `ORIGIN` (only if the public origin differs from the request's).

Logs: `wrangler tail reflex-relay`, or Workers Observability in the dashboard.

### Your own Relay

- **On your Cloudflare account:** `wrangler r2 bucket create reflex-relay-assets`, change `routes` in `wrangler.toml` to a hostname on one of your zones (it must have no DNS record yet; Cloudflare makes one), and `wrangler deploy`. Without a domain, set `workers_dev = true` and drop `routes` to serve it at `reflex-relay.<you>.workers.dev`.
- **On Node:** `node relay/node/bin/reflex-relay.ts --port 8787 --dir <dir> --origin https://relay.example.com` behind a TLS proxy. It has no memory limit, so Spaces too big for a Worker work there.

Then `reflex link --relay wss://relay.example.com` on each of your Links.

## A cloud Agent

1. The Agent's MCP client connects to `https://<relay>/mcp`, gets a 401 pointing at the OAuth metadata, registers itself, and opens the sign-in page.
2. The page shows a code like `K7QD-2MXP`. Type it into the terminal running `reflex link`. The Link says who is asking, and asks which Space and for how long (default 1 hour, at most 30 days). Nothing else can grant one: not the admin RPC, not a command.
3. The Link signs a grant for that Space and sends it, with the Space key, to the Relay. The page continues, the client gets an access token, and every MCP call from then on runs in a cloud session on that one Space.
4. `reflex link relay` lists grants; `reflex link relay revoke <grant>` ends one at once. The Link also stops taking in anything that grant writes, whether or not the Relay heard.

In a chat host that renders MCP Apps (claude.ai, ChatGPT, the reference host), `open_space` also shows Reflex's view, `ui://reflex/space`: the Space, redrawn every 20 s and after each Send. The view holds `wait_for_user` on the session's Inbox through the host and posts each Send to the chat with `ui/message`, so the person's Send starts the Agent's next turn. Once the host took it, the view's next wait acknowledges it. The view only shows the Space; the person draws on their devices.

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

Automerge's whole-document load peaks at about three times what the same Space takes when built change by change. A Space of up to roughly 2,000 strokes fits in a Worker. A bigger one does not: the session refuses it with `507` and a message pointing to a self-hosted Relay, and doesn't try again until the Space has a new snapshot. If it died while loading, it is refused next time instead of taking the Durable Object down on every call. `SESSION_MEMORY_LIMIT` sets the budget (default 96 MB of the isolate's 128). On the deployed Worker, 3,500 strokes whose newest snapshot was small opened in 62 MB, and 8,000 strokes (a 2.6 MB snapshot) got the `507`. The Node Relay has no limit. Per ADR-0004, if real Spaces outgrow a Worker, cloud execution moves to a separate service and the Durable Object stays the router and log. `GET /v0/log/<log>/stats` with a grant's token reports the session's own numbers and digest.

## Shared Spaces

A Space shared with other people (ADR-0008, `link/sharing.ts`) has one key, made by the owner's Link and given to each member's Link inside their end-to-end session; removing someone makes a new key, so a new log the removed person can't name. Each member's Link joins the owner's person room and watches only the owner's Link. An invite is presented in its own room, `sha256("reflex-relay/v0 invite room " + secret)`, where the owner's Link watches `"*"` (any device) until the invite is used or expires; the handshake inside still needs the invite's secret.

## Not here yet

- Only Links write the log. The iPad syncs through the Relay (routing, end to end) but doesn't read or write the log itself, so its changes reach the log through a Link.
- Two Links of one person share Space keys over their end-to-end session; if both had made a key for the same Space before they first met, both keep the one whose log sorts first, and the other log is left behind.
- Both Links push what they hold, so a log can hold the same change twice. Duplicates are harmless.
- Space titles and sizes (the Link's `space_meta`) aren't in the log; a cloud session uses the defaults.
- A Space whose snapshot is over 15 MB can't go in one entry.
- iPads hold no Space keys, in a shared Space too: a member's iPad reaches the log through its Link.
