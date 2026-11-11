# Reflex kernel

The sans-IO Rust core that owns every Space (ADR-0005). JSON and bytes go in, and new state, JSON results and bytes come out. It has no sockets, files, clocks or threads. Callers pass in the time (`now_ms`) and a random actor ID for each replica.

| Path | What it is |
|---|---|
| `core/` | the `reflex-kernel` crate: the Automerge mapping (`doc.rs`), Agent batches and user intents (`ops.rs`, `apply.rs`), per-person undo (`lib.rs`), scene projection and lints (`scene.rs`), and `freeze_send` (`send.rs`) |
| `ffi/` | the Swift binding, through UniFFI |
| `wasm/` | the TypeScript binding, through wasm-bindgen, with one entry for Node (`@reflex/kernel/node`) and one for Cloudflare Workers (`@reflex/kernel/workers`) |
| `swift/` | the `ReflexKernel` Swift package: an XCFramework plus the generated Swift |
| `proof/` | the proof setup: a SwiftUI app for the iPad Simulator, a Node hub and a local-only Worker, each holding a replica of one Space |

The Element types are **stand-ins** until T1's schemas land in `protocol/`. The envelope (ID, owner, layer, the free `data` map), Ink, text, notes, shapes and connectors follow ARCHITECTURE §4.2. Any other type is kept as an extension type with opaque `props`.

## API

Every binding exposes the same calls on one `Space` object, which is one replica of one Space:

```
create(space_id, kind, actor_hex)            load(bytes, actor_hex)
apply_agent_batch(agent, request_id, batch_json, now_ms) -> result JSON
apply_user_intent(person, device, intent_json, now_ms)   -> result JSON
undo(person, device, now_ms)   redo(person, device, now_ms)
scene(query_json) -> scene JSON              digest() -> hash of the logical state
freeze_send(person, device, raw_json, now_ms) -> frozen Send JSON
save() -> bytes   heads() -> JSON   changes_since(heads_json) -> bytes   receive(bytes)
sync_message(peer) -> bytes?   receive_sync_message(peer, bytes)   reset_sync(peer)
```

- **Owners** are `person:<id>` or `agent:<id>` (ADR-0008). They come from the caller's authenticated context and never from the batch.
- **Agent IDs are scoped to the Agent.** Claude's `n-auth` is stored as `claude/n-auth`. Claude sees it as `n-auth`; everyone else sees `claude/n-auth`.
- **Agents change only their own Elements** and never a person's Ink. Only the person who drew a stroke can change or erase it.
- **A batch is one atomic Automerge change.** Rejection is all or nothing and lists every failing op, each with a `fix`. Retrying the same request returns the first result. Reusing a request ID with different ops is rejected. The same request accepted on two replicas merges into one Element.
- **Undo is per person, across devices.** History is one flat map keyed `<person>|<time>|<entry>`. Undo only reverts a field if it still holds the value that person wrote, so it never overwrites someone else's later change. A new action ends that person's redo chain: their undone entries become `abandoned` and are never redone.
- **`freeze_send`** pins the frontier and, in the same commit, claims the person's strokes and changes since their last Send. A frozen Send never changes. Freezing the same ID again returns the stored record.
- **Text is collaborative and indexed in UTF-16.** A connector's two ends, an Element's bounds and a stroke's geometry are each stored as one atomic value (ARCHITECTURE §7.1).
- **Deleting writes an immutable removal record for that incarnation.** Restoring makes a new incarnation, so a concurrent patch can't bring an Element back.
- **Every replica of a Space starts from the same genesis change.** It is written by an actor derived from the Space ID at time 0, so replicas created separately still merge.

## Build

```sh
rustup target add wasm32-unknown-unknown aarch64-apple-ios aarch64-apple-ios-sim
cargo install wasm-bindgen-cli --version 0.2.104   # must match Cargo.lock
sh kernel/wasm/build.sh      # -> kernel/wasm/pkg
sh kernel/swift/build.sh     # -> kernel/swift/ReflexKernelFFI.xcframework + generated Swift
cargo test -p reflex-kernel  # the convergence traces in tests/traces/
```

## Proof run (local only, nothing is deployed)

```sh
npm install
(cd kernel/proof/worker && npx wrangler dev --port 8787)   # Workers replica, kept in a Durable Object
node kernel/proof/node/hub.ts                              # Node replica on :7311, syncs with the Worker via POST /relay
(cd kernel/proof/ipad && xcodegen && xcodebuild -scheme KernelProof -sdk iphonesimulator ARCHS=arm64 -derivedDataPath build CODE_SIGNING_ALLOWED=NO build)
```

Install `KernelProof.app` in an iPad Simulator. Its buttons make Ana's edits, draw a stroke, undo, Send, and sync with the hub. Each replica shows its `digest`. Replicas that agree on every Element, Send and Library entry have the same digest.
