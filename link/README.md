# Reflex Link (`link/`)

The Mac's background service. It pairs with the iPad, receives its Sends over an end-to-end encrypted connection,
keeps them in a local SQLite Inbox, asks the person before an agent may read them, and delivers them to approved
agents through `wait_for_user`, Claude Code channels or signed webhooks. One Link runs per user profile. `reflex mcp`
starts it in the background when it isn't running.

```sh
node agent/bin/reflex.mjs setup              # register Reflex with your harnesses and start the Link
node agent/bin/reflex.mjs pair               # a fresh 6-digit code to type on the iPad
node agent/bin/reflex.mjs link status
node agent/bin/reflex.mjs link agents        # who may read your Sends
node agent/bin/reflex.mjs link revoke <agent>
node agent/bin/reflex.mjs link stop
```

## How it fits together

**Pairing.** An agent's `connect` asks the Link for a 6-digit code, and the person types it on the iPad. The iPad
finds the Link nearby (Bonjour on the same Wi-Fi, or Apple peer-to-peer Wi-Fi) or, when it isn't nearby, through the
Relay's pairing room. Both sides prove they know the code without sending it, one digit per round nearby and with
CPace through the Relay (`pairing/handshake.ts` explains both), and then trust each other's device keys. A code
lasts 10 minutes, works once, and stops working after 5 wrong tries. Typing it also approves the agent that asked
for it.

**Approval.** Only the person approves an agent: on an iPad that may approve, or in the Link's terminal before any
iPad can. The admin socket never grants approval. Each local socket asks for a per-profile credential.

**Sends.** The iPad sends one immutable Send and the images it refers to. The Link checks the sender, validates the
Send, and commits it and its Inbox entries in one SQLite transaction before it acknowledges. A retry with the same
Send ID doesn't deliver twice.

**Paths.** A paired iPad can be reached over several paths at once: LAN, peer-to-peer Wi-Fi and the Relay. Frames
take the fastest live path. `--relay off` turns the Relay off, and `--relay <ws-url>` picks another one.

| Path            | What it is                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link.ts`       | The `Link` class: puts storage, pairing, sync, transports and the Agent layer together behind two local sockets.                                                                                                |
| `agent-host.ts` | The Agent layer (`agent/`) running on the Link's storage: who a caller is, approval, push targets.                                                                                                              |
| `home.ts`       | The Link's home folder: its identity, credentials, database and assets.                                                                                                                                         |
| `pairing/`      | Device keys and encrypted frames (`crypto.ts`), the handshake (`handshake.ts`), CPace (`cpace.ts`), codes and offers (`offer.ts`), and the signed catalog of paired devices and approved agents (`catalog.ts`). |
| `sync/`         | `coordinator.ts` runs each paired device's sessions and messages; `paths.ts` picks the fastest path.                                                                                                            |
| `storage/`      | SQLite (`db.ts`), Sends (`sends.ts`), the Inbox (`inbox.ts`) and content-addressed assets (`assets.ts`).                                                                                                        |
| `transports/`   | LAN, peer-to-peer (with the Swift helper in `p2p/`), Relay, and fault injection for testing. A transport only carries frames; it never authenticates.                                                           |
| `adapters/`     | Push delivery: the contract, the dispatcher with retries, and the webhook, Claude Code channel and MCP surface adapters.                                                                                        |
| `rpc/client.ts` | The client the `reflex link …` commands use.                                                                                                                                                                    |
| `bin/`          | `reflex link` and `reflex setup`/`pair`, and how setup edits Claude Code's and Codex's configs.                                                                                                                 |
| `test/`         | Tests that run the real Link: stopping with an agent connected, asking again after a revoke, the terminal's approval queue.                                                                                     |

## Logs and errors

The Link logs one line per event to its terminal, or to `link.log` in its home folder when `reflex mcp` started it.
The same refusal from the same place is logged once every 10 minutes, with a count, so a stuck peer doesn't fill the
log. Local RPC errors come back as `{ reason, message, fix }` (`LinkError`), so the CLI and agents can say what to do.

## Developing

From the repository root: `npm ci`, then `npm run check` runs every check CI runs on a PR, and `npm test` runs only
the tests. `npm run build:p2p` builds the peer-to-peer helper (it needs Swift). Without the helper the Link still
pairs over LAN and the Relay. The Link runs from source with Node's type stripping, so only erasable TypeScript is
allowed (`erasableSyntaxOnly`).
