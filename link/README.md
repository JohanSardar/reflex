# Reflex Link

The process on your computer that keeps a copy of every Space, stores it durably, and syncs it with your other devices over the local network (ARCHITECTURE §1, §2, §6). Every Space operation goes through the Rust kernel (`@reflex/kernel/node`); the Link never edits Space data itself.

```sh
sh kernel/wasm/build.sh && npm install
npm run reflex-link                         # start the Link (or: node link/bin/reflex-link.ts)
npm run reflex-link -- pair                 # show a pairing QR code
npm run reflex-link -- --home /tmp/b pair 'reflex://pair?...'   # a second Link pairs with it
npm run reflex-link -- --help
```

`npx reflex link` arrives when T6 joins the Link and the Agent layer.

| Path | What it is |
|---|---|
| `link.ts` | composition, and the local RPC on a Unix socket |
| `home.ts` | the profile folder: identity, local credentials, socket |
| `storage/journal.ts` | each Space: a kernel replica, a checkpoint and a journal of change bytes |
| `storage/inbox.ts` | the durable Inbox index and per-recipient receipts |
| `storage/assets.ts` | content-addressed, chunked asset store |
| `storage/db.ts` | the one SQLite database (WAL, `synchronous=FULL`) |
| `sync/coordinator.ts` | binds Paths to devices, runs the kernel's sync per Space per peer, moves assets |
| `transports/` | the transport seam, and LAN: TCP frames plus Bonjour `_reflex-link._tcp` |
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
- **One path per peer.** If both sides dial at once, both keep the path dialed by the lower device ID. Sync state is reset on every new binding, so anti-entropy runs after each reconnect.
- **Agent approval.** Local clients present `rpc.key` (Agents) or `admin.key` (your own commands), both 0600 in a 0700 folder. An Agent then presents a credential it made itself. The first time, the Link asks you (on its terminal, or through `reflex-link approve|deny`), and the Agent sees no Space content until you approve it. The decision is kept in the signed control catalog against the credential's hash, and records whose signature doesn't verify are ignored.

## Not here yet

- MCP and CLI tools for Agents: T4 builds them, and T6 plugs them into this RPC. The `dev` commands are stand-ins for the iPad and an Agent until then.
- The kernel does not yet check authorization on changes it receives (T2). Only paired devices can send changes, but a paired device is trusted for everything it sends.
- `admin.key` and `rpc.key` are files readable by your OS user, so a local Agent with shell access could read `admin.key` and approve itself. OS-level separation, and the platform credential stores, come later.
- Fastest-path selection waits for a second transport (T11). The fault-injection transport and the headless renderer aren't built yet.
