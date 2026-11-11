# Reflex Link

The process on your computer that keeps a copy of every Space, stores it durably, and syncs it with your other devices over the local network, or through a Reflex Relay when they aren't on one (ARCHITECTURE §1, §2, §6). Every Space operation goes through the Rust kernel (`@reflex/kernel/node`); the Link never edits Space data itself.

```sh
sh kernel/wasm/build.sh && npm install
reflex link                                 # start the Link: shows a pairing QR code and its text (or: node agent/bin/reflex.mjs link)
reflex link --home /tmp/b pair 'reflex://pair?...'   # a second Link pairs with the first one's code
reflex link status                          # Spaces, peers, Agents, the Inbox
reflex link --relay wss://relay.example     # also sync through a Relay, and let cloud Agents in (relay/README.md)
reflex link --help
```

The Link runs in its terminal. Enter shows a new pairing code; when an Agent asks to connect, `y` or `n` answers it. The iPad pairs by scanning the QR code or by pasting its text, and can then approve Agents too.

| Path | What it is |
|---|---|
| `link.ts` | composition, the terminal (pairing codes, Agent questions), and the admin RPC on a Unix socket |
| `agent-host.ts` | the Agent layer (`@reflex/agent`'s capability table) on the durable Spaces, Inbox and assets, served on `agent.sock` to `reflex mcp` and the CLI |
| `home.ts` | the profile folder: identity, local credentials, socket |
| `storage/journal.ts` | each Space: a kernel replica, a checkpoint and a journal of change bytes |
| `storage/inbox.ts` | the durable Inbox index and per-recipient receipts |
| `storage/assets.ts` | content-addressed, chunked asset store |
| `storage/db.ts` | the one SQLite database (WAL, `synchronous=FULL`) |
| `adapters/` | push Send Adapters: the contract (`contract.ts`), push targets, their secrets and every attempt (`store.ts`), the dispatcher that pushes new Sends (`dispatch.ts`), and the first adapter, the Claude Code channel (`claude-channel.ts`) |
| `sync/coordinator.ts` | binds Paths to devices, runs the kernel's sync per Space per peer, moves assets |
| `transports/` | the transport seam; LAN (TCP frames plus Bonjour `_reflex-link._tcp`) and the Relay (WebSocket channels through `relay/`) |
| `relay/` | the Relay's encrypted log from this side: Space keys, pushing and pulling entries, crops, grants for cloud Agents |
| `pairing/` | device keys and the handshake, QR pairing offers, the signed control catalog |
| `rpc/client.ts` | the client for the local RPC |
| `presence.ts` | what iPads report, in memory: the Space on screen and the pen (`presence`), and recognized lines in watched Regions (`hints`) |
| `watch.ts` | watch mode: debounced, budgeted snapshots of watched Regions as the person writes, a newer one replacing one not yet taken |
| `web.ts` | the person's web viewer on 127.0.0.1 (`apps/web`); its address and key are printed in this terminal at start |
| `bin/reflex-link.ts` | the command |

## Guarantees

- **Durable before visible.** A change is journaled, and any Send it brings is indexed in the Inbox, in one SQLite transaction before it is synced or answered. If that fails, the replica is reloaded from disk.
- **Recovery** loads the checkpoint, replays the journal and rebuilds the Inbox index from the Sends in each Space. After 256 journal entries a Space is checkpointed, and the covered entries are dropped in the same transaction.
- **Inbox:** `ready → delivered(recipient) → acknowledged(recipient)`, or `failed`. A Send stays pending for a recipient until that recipient acknowledges it.
- **Assets** are written chunk by chunk with fsync and atomic renames, manifest last, and every read checks the hashes. Bytes from a peer are kept only if they match the hash that was asked for.
- **Discovery is never authentication.** Each device has an Ed25519 key, and its device ID is derived from it. The handshake signs a transcript of both hellos, and the session is encrypted with ChaCha20-Poly1305 using keys from an X25519 exchange. A peer is bound only if it is paired with exactly that key, or proves it knows the secret of a live pairing offer.
- **Pairing:** the QR code carries the offering device's key, a single-use secret valid for 10 minutes, its addresses, and its person. A device that holds nothing yet becomes that person's device (ADR-0008).
- **One path per peer.** If both sides dial at once, both keep the path dialed by the lower device ID. Sync state is reset on every new binding, so anti-entropy runs after each reconnect.
- **Agent approval.** Agents reach the Link on `agent.sock` with `rpc.key` and a credential they keep (`agents/*.cred`, 0600). The first time, the Link asks the person: Allow on an iPad that paired by scanning this Link's code, or `y` in the Link's terminal. Nothing else can approve: the admin RPC (`admin.key`) can deny or revoke but never approve, and another Link can't decide either. The Agent sees no Space content until it is approved. The decision is kept in the signed control catalog against the credential's hash, and records whose signature doesn't verify are ignored.
- **The web viewer reads and never writes.** Its key is new at every start, held in memory and shown only on the Link's terminal; what a browser sends goes through `receive_sync_message_checked` with no writers, so a change from it is refused and logged. `--web-port <n>` moves it, `--no-web` turns it off.
- **Routing.** A Send goes to the Agent that owns the Element or Region it came from, else to the Agents that own what its Marks point at, else to every Agent on the Space ([routing.ts](routing.ts)). A Behavior trigger with only `set`, `apply_recipe` or `open_panel` reaches no Agent: the Link runs `set` and `apply_recipe` itself, as the Element's owner, once (each action has a fixed request ID), and not at all once the person revoked or denied that Agent.
- **Regions.** A Region's Send button claims only the strokes and changes inside it, and shows the work earlier Sends from it carried as context; its handwriting reaches the Agent line by line. Ink is refused where a Region has `ink: false`, checked where the stroke is written. With `watch` on, the Link freezes snapshots of the Region (`kind: "watch"`, claiming nothing) when the person pauses, or every `REFLEX_WATCH_MAX_S` while they keep writing, within `REFLEX_WATCH_MIN_S` and `REFLEX_WATCH_PER_HOUR`. `user_still_writing` comes from the iPad's pen (down, or lifted under 1.5 s ago) when an iPad shows the Space, else from timing; the handwriting text comes from the iPad's recognizer (`hints`), else from earlier Sends.
- **Presence.** An iPad reports the Space on its screen; `request_attention` answers `already_viewing` when a connected iPad shows that Space.
- **Push is an add-on; the Inbox stays the guarantee** (ADR-0002). A Send goes by push only to an Agent with a live push target (a Claude Code session running `reflex mcp --channel`) that isn't already in a `wait_for_user` that takes it, only if it arrived after that target went live, and at most once per recipient. While the push is in flight `wait_for_user` skips that Send. A push that works counts as a delivery (`delivered`), and the Send stays pending until the Agent acknowledges it. A push that fails or times out (5 s) leaves the receipt `failed`, so the next `wait_for_user` returns it, and the surface drops a push that reaches it after that deadline, so it never arrives twice. Targets, their config and callback, secrets (0600 files under `adapters/`) and every attempt are kept by the Link, outside the adapter; `reflex link status` lists them. Behavior actions (`set`, `apply_recipe`) run only while the owning Agent is approved.
- **Re-asking is throttled.** After the person denies or revokes an Agent, its calls answer `rate_limited` for 10 minutes (`REFLEX_REASK_S`) before it may ask again.
- **Received changes are checked.** The kernel tries a peer's changes on a fork first and applies them only if that peer may make them: an iPad writes only as its person (its own Ink, its Sends, its removals), a paired Link also on behalf of Agents. A rejected message is logged and the session is closed. The Agent layer writes as each Agent through the kernel's own checks.

## Not here yet

- The `dev` commands (with `--dev`) act as the person without an iPad, for testing.
- The check on received changes knows people and Agents but not roles; roles come with T22.
- Approval can't be given through any Reflex command, but a local process running as your OS user can still read the Link's files (`identity.json`, `link.db`) or its terminal. OS-level separation, and the platform credential stores, come later.
- Paths are tried LAN first, then the Relay; picking the fastest live path waits for T11. The fault-injection transport isn't built yet.
