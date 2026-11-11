# Reflex Link

The process on your computer that keeps a copy of every Space, stores it durably, and syncs it with your other devices over the local network (ARCHITECTURE §1, §2, §6). Every Space operation goes through the Rust kernel (`@reflex/kernel/node`); the Link never edits Space data itself.

```sh
sh kernel/wasm/build.sh && npm install
reflex link                                 # start the Link: shows a pairing QR code and its text (or: node agent/bin/reflex.mjs link)
reflex link --home /tmp/b pair 'reflex://pair?...'   # a second Link pairs with the first one's code
reflex link status                          # Spaces, peers and their paths, Agents, the Inbox
reflex link --help
```

On macOS, build the peer-to-peer helper once with `npm run build:p2p` (Xcode's command-line tools); the Link then also listens over Apple peer-to-peer Wi-Fi, so an iPad reaches it with no shared Wi-Fi network. Without the helper, or with `--no-p2p`, it uses LAN only.

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
| `sync/coordinator.ts` | binds Paths to devices, runs the kernel's sync per Space per peer, moves assets |
| `sync/paths.ts` | every live path to a peer, and which one changes go out on (fastest, with hysteresis) |
| `transports/` | the transport seam; `lan.ts`: TCP frames plus Bonjour `_reflex-link._tcp`; `p2p.ts`: Apple peer-to-peer Wi-Fi through the `p2p/` helper; `fault.ts`: fault injection |
| `transports/p2p/` | `reflex-p2p`, the Apple-only Swift helper: listens over peer-to-peer Wi-Fi (AWDL) with Network.framework, advertises `_reflex-p2p._tcp`, and pipes bytes to the Link on stdio |
| `pairing/` | device keys and the handshake, QR pairing offers, the signed control catalog |
| `rpc/client.ts` | the client for the local RPC |
| `bin/reflex-link.ts` | the command |

## Guarantees

- **Durable before visible.** A change is journaled, and any Send it brings is indexed in the Inbox, in one SQLite transaction before it is synced or answered. If that fails, the replica is reloaded from disk.
- **Recovery** loads the checkpoint, replays the journal and rebuilds the Inbox index from the Sends in each Space. After 256 journal entries a Space is checkpointed, and the covered entries are dropped in the same transaction.
- **Inbox:** `ready → delivered(recipient) → acknowledged(recipient)`, or `failed`. A Send stays pending for a recipient until that recipient acknowledges it.
- **Assets** are written chunk by chunk with fsync and atomic renames, manifest last, and every read checks the hashes. Bytes from a peer are kept only if they match the hash that was asked for.
- **Discovery is never authentication.** Each device has an Ed25519 key, and its device ID is derived from it. The handshake signs a transcript of both hellos, and the session is encrypted with ChaCha20-Poly1305 using keys from an X25519 exchange. A peer is bound only if it is paired with exactly that key, or proves it knows the secret of a live pairing offer.
- **Pairing:** the QR code carries the offering device's key, a single-use secret valid for 10 minutes, its addresses, and its person. A device that holds nothing yet becomes that person's device (ADR-0008).
- **Every path stays open; changes take the fastest.** A peer can be connected over LAN and peer-to-peer Wi-Fi at once. Frames from either path are taken. Each side sends over its active path: the one with the lowest RTT (plus 1 ms per KiB queued), switching only when another path has been under 0.75× its score, and at least 1 ms better, for 4 s. When the active path closes, or hears nothing for 7 s (pings go every 2 s on every path), the next best takes over at once, and sync state is reset so anti-entropy repairs whatever was in flight. The iPad runs the same rule.
- **One path per transport per peer.** If both sides dial at once, both keep the path dialed by the lower device ID. Sync state is reset on every new binding, so anti-entropy runs after each reconnect. A peer's addresses are dialed at once, the one it was last reached at first.
- **Duplicates are harmless.** The same change arriving twice, over one path or two, leaves the Space, its journal and the Inbox as they were. `--every-path` sends every change over every live path to show it.
- **Fault injection.** `--fault "lan:delay=80,jitter=40;p2p:drop=0.01"` drops, delays or duplicates frames per transport, both ways; `reflex link fault <spec>` changes it while running (`lan:drop=1` takes LAN down, `""` clears it). Sessions are authenticated and ordered, so a dropped or duplicated frame closes the session, and the Link reconnects and runs anti-entropy.
- **Agent approval.** Agents reach the Link on `agent.sock` with `rpc.key` and a credential they keep (`agents/*.cred`, 0600). The first time, the Link asks the person: Allow on an iPad that paired by scanning this Link's code, or `y` in the Link's terminal. Nothing else can approve: the admin RPC (`admin.key`) can deny or revoke but never approve, and another Link can't decide either. The Agent sees no Space content until it is approved. The decision is kept in the signed control catalog against the credential's hash, and records whose signature doesn't verify are ignored.
- **Received changes are checked.** The kernel tries a peer's changes on a fork first and applies them only if that peer may make them: an iPad writes only as its person (its own Ink, its Sends, its removals), a paired Link also on behalf of Agents. A rejected message is logged and the session is closed. The Agent layer writes as each Agent through the kernel's own checks.

## Not here yet

- The `dev` commands (with `--dev`) act as the person without an iPad, for testing.
- The check on received changes knows people and Agents but not roles; roles come with T22.
- Approval can't be given through any Reflex command, but a local process running as your OS user can still read the Link's files (`identity.json`, `link.db`) or its terminal. OS-level separation, and the platform credential stores, come later.
- The Link only listens over peer-to-peer Wi-Fi (the iPad dials it); two Links reach each other over LAN. The headless renderer isn't built yet.
