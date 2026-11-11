# Reflex kernel

The sans-IO Rust core that owns every Space (ADR-0005). JSON and bytes go in, and new state, JSON results and bytes come out. It has no sockets, files, clocks or threads. Callers pass in the time (`now_ms`) and a random actor ID for each replica.

| Path | What it is |
|---|---|
| `core/` | the `reflex-kernel` crate: the Automerge mapping (`doc.rs`), Agent batches and user intents (`ops.rs`, `apply.rs`), per-person undo (`lib.rs`), scene projection and lints (`scene.rs`), `freeze_send` (`send.rs`), and the check on received changes (`auth.rs`) |
| `ffi/` | the Swift binding, through UniFFI |
| `wasm/` | the TypeScript binding, through wasm-bindgen, with one entry for Node (`@reflex/kernel/node`) and one for Cloudflare Workers (`@reflex/kernel/workers`) |
| `swift/` | the `ReflexKernel` Swift package: an XCFramework plus the generated Swift |
| `proof/` | the proof setup: a SwiftUI app for the iPad Simulator, a Node hub and a local-only Worker, each holding a replica of one Space |

The op and Element types are **generated from `protocol/schema/`** by `protocol/scripts/gen-rust.mjs` into `protocol/generated/rust/protocol.rs`, which `core/src/protocol.rs` includes. `apply_agent_batch` parses each op through them, and `scene` returns protocol Elements (`detail: "full"`), scene items (`"outline"`) or raw strokes (`"strokes"`) through them. After each write the Element is checked against the Element schema, so the kernel never stores one it couldn't return. The generated types check shape (fields, types, required fields, enums, closed objects); patterns, lengths and ranges are checked by the Agent layer with Ajv before the kernel runs. Every typed field is one register under its protocol name; text, note, shape and connector text is collaborative. Any type not in the protocol is an extension type with opaque `props`.

After a schema change: `npm run build -w @reflex/protocol` (rewrites `generated/`, including the Rust), then rebuild the kernel.

## API

Every binding exposes the same calls on one `Space` object, which is one replica of one Space:

```
create(space_id, kind, actor_hex)            load(bytes, actor_hex)
apply_agent_batch(agent, request_id, batch_json, now_ms) -> result JSON
apply_user_intent(person, device, intent_json, now_ms)   -> result JSON
undo(person, device, now_ms)   redo(person, device, now_ms)
scene(query_json) -> scene JSON              digest() -> hash of the logical state
freeze_send(person, device, raw_json, now_ms) -> frozen Send JSON    send(send_id) -> frozen Send JSON or null
save() -> bytes   heads() -> JSON   changes_since(heads_json) -> bytes   receive(bytes)
sync_message(peer) -> bytes?   receive_sync_message(peer, bytes)   reset_sync(peer)
receive_sync_message_checked(peer, bytes, writers_json) -> {"ok":true} or {"ok":false,"reason":"not_yours","errors":[...]}
marks(send_id, query_json) -> {send, marks}  timeline(query_json) -> {entries}
revert(by_json, request_id, selector_json, now_ms) -> result JSON
request_attention(agent, json, now_ms) -> result JSON
```

- `freeze_send` takes the raw Send a device writes
  ([raw-send](../protocol/schema/raw-send.schema.json)): the strokes, the
  person's words with times, handwriting hints, crops, and for a Behavior
  trigger the `element` and `on`. A trigger whose actions are only `notify` is
  a `tap`, one with a `send` action a full Send that claims strokes, anything
  else an `action` the Link runs and no Agent receives.
- `apply_user_intent` also takes `{intent: "add_file", …}`: a photo becomes an
  image Element, each rendered PDF page another, and any other file a `file`
  Element.
- `{intent: "set_state", id, state}` saves what an Embed keeps with
  `reflex.element.setState` on its Element; `{intent: "set_state", id, panel,
  values}` saves a Panel's values on the Element that opened it. Both merge (a
  null removes a key), are capped at 16 KB, come only from a person, and show in
  that person's next Send as `embed_state` and `panel` changes. Undo skips them,
  and a run of them between Sends is kept as one history entry.
- A Mark drawn on an Embed takes the Embed's own answer for what it points at
  (`embed_anchors` on the raw Send, from the Embed's Anchor resolver): its
  `target`, and `on` that Embed.

- **Owners** are `person:<id>` or `agent:<id>` (ADR-0008). They come from the caller's authenticated context and never from the batch.
- **Agent IDs are scoped to the Agent.** Claude's `n-auth` is stored as `claude/n-auth`. Claude sees it as `n-auth`; everyone else sees `claude:n-auth` (`/` is not in the protocol's ID alphabet). Both forms resolve.
- **Agents change only their own Elements** and never a person's Ink. Only the person who drew a stroke can change or erase it.
- **A batch is one atomic Automerge change.** Rejection is all or nothing and lists every failing op, each with a `fix`. Retrying the same request returns the first result. Reusing a request ID with different ops is rejected. The same request accepted on two replicas merges into one Element.
- **Undo is per person, across devices.** History is one flat map keyed `<person>|<time>|<entry>`. Undo only reverts a field if it still holds the value that person wrote, so it never overwrites someone else's later change. A new action ends that person's redo chain: their undone entries become `abandoned` and are never redone.
- **Marks are computed at the Send's frontier.** `marks` groups the Send's strokes by time and place (a handwriting hint groups first), classifies each group (circle, arrow, strike, underline, cross, check, writing, ink), anchors it to the Elements it touches, and notes a target that moved or was removed since.
- **Revert replays inverses, newest first.** An Agent reverts only its own batches; a person reverts any Agent's from the history chip. A field someone changed after the batch stays as they left it, and the result says so. Reverted state is derived from batch and history records, so no new root map is needed.
- **`freeze_send`** pins the frontier and, in the same commit, claims the person's strokes and changes since their last Send. A frozen Send never changes. Freezing the same ID again returns the stored record.
- **Received changes are checked before they apply.** `receive_sync_message_checked` applies a peer's changes to a fork, compares the state before and after, and applies them for real only if every difference is one the peer may write. `writers_json` says for whom: `{"people":["p_1"]}` for an iPad, `{"people":["p_1"],"agents":"*"}` for a Link that hosts Agents, `{"any":true}` to trust everything. A person's Ink changes only by that person; a person may put back an Agent's Element they removed (undoing a revert); an Element's owner, type and ID never change; a Send must come from a writing person and never changes; `meta` never changes. Otherwise nothing is applied, and the errors say which change was refused.
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
