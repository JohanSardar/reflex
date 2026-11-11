# Reflex: Architecture

Status: agreed design, v1 (2026-11-10). This document turns [SPEC.md](./SPEC.md) into a buildable system. Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). Decisions are recorded in [docs/adr/](./adr/), in particular ADR-0005 (Rust kernel), ADR-0006 (extension ladder) and ADR-0007 (Agent coordinates).

It is a merge of one design and three critiques:
- [architecture/gpt-sol.md](./architecture/gpt-sol.md): the original design, with researched sources. It is the reference for detailed invariants.
- [review-astra.md](./architecture/review-astra.md): over-engineering, correctness gaps, fact checks.
- [review-fable.md](./architecture/review-fable.md): the Agent and extension-author experience, and the language seam.
- [review-claude.md](./architecture/review-claude.md): package count, the iPad's role, and App Store reality.

Where this document is silent on a detail, gpt-sol.md's version applies, as long as it doesn't contradict anything here.

## 0. The shape in one paragraph

Reflex is a **small, correct Rust kernel** that owns every Space; a **TypeScript Agent layer** that owns everything an Agent sees; **native shells** that render and capture input; and an **extension ladder** that lets anyone add a new domain without an app release. Modularity sits where Reflex actually grows: new domains (Guides, Recipes, Embed Templates, Anchors) and new ways to connect (transports, Send Adapters, clients). Internals stay ordinary code behind internal interfaces. An internal interface becomes a public contract only after a second real implementation exists.

## 1. Runtime picture

```
                  ┌───────────────────────── Agent layer (TypeScript) ─────────────────────────┐
 local Agents ──▶ │ MCP surface · CLI surface · capability table · Send Bundle projection ·    │
 (stdio / shell)  │ lints · recipes · guides · Send Adapters · exec sandbox                     │
                  └───────────────┬────────────────────────────────────────────────────────────┘
                                  │ coarse calls (WASM)
 ┌──────────── Reflex Link (Node) ▼────────────┐          ┌────────── Relay (Workers / Node) ──────────┐
 │ kernel (WASM) · journal · assets · Inbox    │◀─sync──▶ │ encrypted log + routing (Durable Object)    │
 │ sync coordinator · transports · pairing     │          │ cloud session: kernel + Agent layer,        │
 └──────────────▲──────────────────────────────┘          │ only under a temporary grant (ADR-0004)     │
                │ LAN / Apple peer-to-peer / USB-C          └──────▲───────────────────────▲─────────────┘
 ┌──────────────┴──── iPad app (Swift) ───────────┐               │                       │ remote MCP + OAuth
 │ kernel (UniFFI) · PencilKit · speech ·          │◀──── Relay ───┘                cloud Agents
 │ native renderers · WKWebView Embeds · RealityKit│
 │ Send capture · crops · local journal            │      ┌──── web viewer (browser) ────┐
 └─────────────────────────────────────────────────┘      │ kernel (WASM) · DOM renderers │
                                                           │ `reflex dev` playground       │
                                                           └───────────────────────────────┘
```

- **One long-lived Link process per user.** Each MCP stdio connection is a thin subprocess that forwards to it over authenticated local RPC: a Unix socket or named pipe plus a per-profile credential, never an open loopback port. Closing a stdio pipe never loses a Send.
- **The iPad never runs the Agent layer.** Agents only write through the Link or a Relay cloud session. The iPad runs the kernel for user intents, sync, and Send capture.

## 2. Units

Seven buildable units, plus extensions. Inside each unit, folders are enforced by a dependency checker, but they are not separate packages.

| Unit | Language | Owns | May depend on | Must never depend on |
|---|---|---|---|---|
| `protocol` | JSON Schema + generated code | wire schemas, error registry, fixtures, published spec | nothing | anything in Reflex |
| `kernel` | Rust | CRDT mapping, batch application (user and Agent), ownership and Region policy, history/undo/revert planning, scene projection, Mark grouping + Anchor resolution, Send freezing, migrations, text measurement | `protocol`, the CRDT crate | IO, platforms, MCP, UI |
| `agent` | TypeScript | capability table, MCP and CLI surfaces, tool text, op normalization and repair, lints wording, Send Bundle projection, recipes/guides loader, `exec` sandbox, Send delivery and adapters | `kernel` (WASM), `protocol` | platform UI, concrete transports |
| `link` | TypeScript | composition: journal/assets storage, Inbox index, sync coordinator, transports, pairing and Agent approval, credential store, headless renderer | `agent`, `kernel`, `protocol` | nothing imports `link` |
| `relay` | TypeScript | encrypted log and routing (Durable Object), OAuth, cloud session execution | `agent`, `kernel`, `protocol` | nothing imports `relay` |
| `ipad` | Swift | app shell, PencilKit capture, speech, native renderers, WKWebView Embeds + bridge, RealityKit, Send capture and crops, platform storage, network, crypto | `kernel` (UniFFI), `protocol` | the Agent layer |
| `web` | TypeScript | web viewer, DOM renderers, `reflex dev` playground | `kernel` (WASM), `protocol` | `link`, `relay` |

Extensions live in `extensions/`, organized by kind (§5). Built-in content uses the same rungs where that's natural. Ink and the native Element types are allowed to be special (ADR-0006).

## 3. The kernel (Rust, sans-IO)

A state machine: events and bytes go in; new state, effects and bytes come out. It contains no sockets, files, clocks or threads. Callers inject the time and random seeds.

```rust
// Coarse API, sketched. JSON or bytes cross the boundary.
open(snapshot: Bytes, journal: Iter<Change>) -> Space
apply_agent_batch(space, agent: AgentId, batch: NormalizedBatch, at: Frontier) -> Commit | Rejection
apply_user_intent(space, device: DeviceId, intent: UserIntent) -> Commit   // finished strokes, erase, move, undo
receive(space, change: VerifiedChange) -> Delta
sync_step(space, peer: PeerId, msg: Option<Bytes>) -> SyncOutput
scene(space, query: SceneQuery) -> Scene                    // outline / full / clusters, provenance (`by`)
group_marks(space, strokes: [StrokeId], hints: [RecognizerHint]) -> [Mark]
resolve_anchors(space, marks: [Mark], embed_answers: [EmbedAnchor]) -> [Anchor]
freeze_send(space, raw: RawSend) -> FrozenSend               // pins frontier, claims unsent edits
plan_revert(space, agent: AgentId, batches: [BatchId]) -> RevertPlan
undo(space, device: DeviceId) -> Commit                      // the user's own actions only
migrate(space, to: SchemaVersion) -> Commit
measure_text(spec: TextSpec) -> Size                         // bundled shaper + fonts: same bounds everywhere
checkpoint(space) -> Bytes
```

**What the kernel guarantees:**
- Agents can never change user Ink.
- IDs and owners are immutable.
- Owners come from the authenticated context, never from arguments.
- A batch is one atomic, revertable unit.
- A delivered Send never changes.
- Every runtime computes the same text bounds, so lints mean the same thing on the Link and the iPad.

**Gate.** The milestone 0 spike builds the mapping, `apply_agent_batch` and `scene` in Rust and binds both sides. It measures per-call FFI overhead, XCFramework and WASM size, and cold start on the iPad and in Workers. The fallback, if no one will own Rust, is described in ADR-0005.

## 4. The Agent contract (designed by hand, tested with real models)

The Agent is the product's real user. Tool descriptions are prompt engineering: they are hand-written, then measured. They are not generated from schemas. The capability table guarantees MCP/CLI parity. The text is a separate, eval-tested artifact.

### 4.1 Tools

Eleven tools, and the list is fixed (SPEC §11): `list_spaces`, `open_space`, `read`, `look`, `apply`, `exec`, `wait_for_user`, `read_me`, `recipe`, `request_attention`, `revert`.

- **Server instructions stay under about 400 tokens.** They cover:
  - the loop: `open_space` → `apply` → `wait_for_user`, repeat
  - the ownership rule
  - "call `read_me` before using a type you haven't used"
- **Plugins never add tools or always-loaded text.** They show up in `read_me("index")`.

### 4.2 `apply`

The format is flat and typed. Agents name things; Reflex computes geometry. Each Agent has short, Agent-chosen IDs that are scoped to that Agent, and one stable coordinate space (ADR-0007).

```json
{ "space": "auth-plan", "in_reply_to": "s_12", "look": true,
  "ops": [
    { "op": "add", "id": "n-auth", "type": "shape", "shape": "rect", "text": "Auth service",
      "at": { "right_of": "n-gateway", "gap": 80 } },
    { "op": "add", "id": "e1", "type": "connector", "from": "n-gateway", "to": "n-auth", "text": "JWT" },
    { "op": "add", "type": "note", "text": "Agreed, merging these.", "at": { "near": "m1" } },
    { "op": "patch", "id": "n-db", "set": { "text": "Postgres" } },
    { "op": "remove", "ids": ["n-cache"] },
    { "op": "arrange", "ids": ["n-a", "n-b", "n-c"], "layout": "row", "gap": 40 }
  ] }
```

- **Built-in types have typed, top-level fields.** Only extension types use `props`. When an extension type fails validation, the error includes an excerpt of its schema and one example.
- **The JSON Schema stays shallow**, with one level of `oneOf`, because strict tool modes in some harnesses handle deep unions badly.
- **Repair first, warn second, reject last.** Rejection is all-or-nothing and lists every failing op. Each error comes with a `fix`, for example "No Element 'n-gatway'. Closest: 'n-gateway'." Results report:
  - `batch`
  - generated `ids`
  - `repaired`
  - `lints` (each with a `fix`)
  - `pending_sends`
  - a crop of the changes when `look: true` was set
- **Patches use a finite set of field operations**: `set`, `unset`, `text_insert`/`text_delete`, `list_insert`/`list_move`/`list_remove`, `map_put`/`map_delete`. Their concurrent behavior is defined. A type that needs a new merge primitive requires a protocol change, and that is stated openly.

### 4.3 The Send Bundle (what the model reads)

The stored, frozen Send is the source of truth. The Bundle is a projection of it, about 2,000 text tokens plus at most four images by default.

```json
{ "kind": "send", "send": "s_12", "space": "auth-plan", "trigger": "voice",
  "said": "merge these [m1] [m2] into one service",
  "marks": [
    { "id": "m1", "kind": "circle", "on": ["n-auth"], "image": 1 },
    { "id": "m2", "kind": "arrow", "from": "n-auth", "to": "n-users", "image": 1 },
    { "id": "m3", "kind": "writing", "near": "m2", "text_guess": "contradicts", "confidence": 0.71, "image": 2 },
    { "id": "m5", "kind": "lasso", "on": ["chart-3"],
      "target": { "kind": "data", "rows": ["r17", "r22"] }, "image": 3 },
    { "id": "m6", "kind": "ink", "bounds": [900, 300, 140, 90], "note": "Not recognized. See image 3." }
  ],
  "changes": [ { "kind": "moved", "id": "n-db", "by": [120, 0] },
               { "kind": "removed", "id": "n-cache", "was": "Redis cache" } ],
  "scene": [ { "id": "n-auth", "type": "shape", "text": "Auth service", "by": "you", "bounds": [400, 200, 160, 80] } ],
  "elsewhere": { "on_screen": 14, "off_screen": 31 },
  "images": [ { "n": 1, "shows": "m1, m2 and their targets", "bounds": [380, 160, 520, 180] } ],
  "also_sent_to": [], "redelivered": false, "pending_after": 0,
  "next": "Reply with apply(in_reply_to: 's_12'), then wait_for_user(after: 's_12')." }
```

- **The voice transcript is interleaved with the Marks**, using on-device word timings and stroke timestamps.
- **Anchors are frozen when the Mark is drawn.** If the target moves before the Send, the Bundle shows both the original and the current position, plus a `moved_since_marked` flag.
- **`kind`** is one of `send`, `watch` (carries `user_still_writing`), or `tap`.
- **`by` appears on every scene Element.** Text from other Agents and from Embeds is data, never instructions.
- **Raw strokes are passed by reference.** `read({ids:["m3"], detail:"strokes"})` returns them, for the kanji and sketch scenarios.
- **Acknowledgement.** A Send is acknowledged by passing `after` to `wait_for_user` or `in_reply_to` to `apply`. Otherwise it is redelivered with `redelivered: true`. There are no tokens, and this works over stateless MCP.

### 4.4 Agent evals: a first-class test lane

Scenarios 1 and 2 run against real models through both MCP and the CLI, replaying recorded Send Bundles. Each run is scored on:
- targets hit
- no overlap with Ink
- no duplicate replies
- calls and tokens used

Any change to a tool description, the op schema, or the Bundle projection reruns the evals.

## 5. Extensions: the ladder (ADR-0006)

| Rung | Kind | Author writes | Runs where | Ships |
|---|---|---|---|---|
| 0 | **Guide** | one Markdown file | Link, Relay | a folder, `reflex extensions add`, or inline from an Agent |
| 1 | **Recipe** | one Markdown file: front matter, a parameter schema, a fenced JSON op template | anywhere (it's data) | same as above |
| 2 | **Embed Template** | `reflex.json`, one HTML file, a parameter schema, a Guide | WKWebView on iPad, iframe on web, headless browser on the Link | npm, a folder, or inline |
| 3 | **Declarative Element type** | a schema plus a display-list template | the kernel and every renderer | later: designed after rung 2 has real users |
| 4 | **Native Element type** | Rust kernel support plus Swift and web renderers | compiled in | a pull request; arrives with an app release |
| – | **Send Adapter** | one TypeScript module (plus configuration) | Link | npm; the common case is configuration: `reflex adapters add webhook --url …` |
| – | **Format** | an import/export module that emits ordinary `apply` batches | Link | npm |
| – | **Transport** | an internal interface for now (§6) | Link / iPad | in-repo until a second outside implementation exists |

**The Embed bridge** (SPEC §5) gives an Embed access only to itself:

```js
reflex.element.props()                    // read own data
reflex.notify(payload)                    // a "notify agent" event (becomes a `tap`)
reflex.panel.open(panelSpec)
reflex.anchors.register({ resolve(region) { return { kind: "data", rows: ["r17"], label: "outlier" } } })
```

Each Embed runs isolated:
- a separate, nonpersistent web data store
- a network allowlist enforced for every subresource, redirect, worker and socket
- no native credentials

MCP App (`ui://`) resources are accepted as Embed Templates. Their upstream tool calls are denied with a visible diagnostic unless the user explicitly allows that server.

**Author kit:**
- `reflex create guide|recipe|embed|adapter <name>` writes a working example that passes its own tests.
- `reflex test` runs the contract suite for that kind.
- `reflex dev` opens the web viewer on an in-memory Space with hot reload and three panes:
  1. what the Agent reads
  2. what a Send produces (draw with the mouse, in dev mode only)
  3. live lints and Anchors

  A "record fixture" button turns the current Mark into a conformance fixture. None of rungs 0–3 needs an iPad or Xcode.

## 6. Internal seams (interfaces, not plugin kinds)

These exist so the code stays testable and replaceable. They carry no manifest, activation or permission machinery.

- **Transport.** It must handle both directions:
  - `listen()` and `dial(peer)` yield `Path`s that are pending or authenticated.
  - The coordinator binds a Path to a device once that device proves its key. Bonjour is used for discovery, never for authentication.
  - A Relay transport demultiplexes into logical per-peer paths.
  - A Path carries ordered, reliable frames, plus backpressure and the measurements RTT, throughput and queue depth.
  - Fastest-path selection, with hysteresis, is added once a second real path exists.

  Build order: LAN/Bonjour and a fault-injection transport first, then Relay WebSocket, then Apple peer-to-peer Wi-Fi (an Apple-only Swift helper). USB-C is a feasibility item. Anti-entropy runs after every reconnect.
- **Storage.** A journal (atomic append, recovery, checkpoint replacement) and a content-addressed asset store with chunking and integrity checks. Assets are made durable before anything refers to them. Implementations: SQLite on the Link and iPad, OPFS in the browser, DO SQLite plus R2 on the Relay.
- **CRDT engine.** A thin wrapper inside the kernel, with no engine handles leaking out. Changing engines is a one-time migration, not a runtime option.
- **Identity.** Three separate things:
  - **device pairing:** a QR key exchange
  - **remote principal verification:** OAuth tokens, checked for issuer, audience and scopes
  - **Reflex grants:** Agent approval, Space access and effects, kept in a signed control catalog

  OAuth never approves an Agent by itself.
- **Send delivery.** The Inbox and `wait_for_user` ship first. The push adapter contract (config, secrets, callback endpoint, durably persisted attempts outside the adapter) is extracted with the first push adapter, the Claude Code channel, and validated against the second, a webhook.

## 7. Correctness rules (specified before the protocol is called stable)

1. **Invariants that span fields.** Related values (a `min`/`max` pair, an axis domain, a connector's endpoints) are stored as one atomic register. Two writes that are each valid can still merge into an invalid state. When that happens the kernel renders it safely and reports an explicit conflict. It never picks a winner silently in a way that depends on order.
2. **Authorization** is checked at the writer's causal frontier, and the check is recorded in the commit. User Ink ownership is immutable and stronger than any mutable Region policy. A Region rule never retroactively deletes accepted writes. It applies to writes made after the frontier where the rule became visible.
3. **Idempotency.** Each Agent request has a request ID and a payload hash. Logical IDs come from (Agent, request, op index). If a retry with the same ID carries a different payload, it is rejected. When the same request is accepted on both the Link and the Relay, the two copies converge to one logical Element deterministically. This is tested.
4. **The Send state machine is persisted:**

   ```
   capturing → preparing → ready
       ready → delivered(recipient) → acknowledged(recipient)
       any state → failed(recoverable)
   ```

   - `freeze_send` claims unsent edits atomically, so rapid Sends neither duplicate nor drop edits.
   - The raw evidence (strokes, crops, transcript) is durable before the UI shows the Send as saved.
   - Recognition, Anchor resolution and finalization run where the Agent is, against the pinned frontier.
5. **Marking-time evidence.** A Mark stores its Anchor, the target's transform, and a render-state ID captured when it was drawn: content revision, HTML layout, 3D camera pose. History alone can't reproduce a DOM animation or a WebGL camera.
6. **Retention, decided before public release:**
   - Send image TTL
   - watch-mode rate and size budgets
   - history checkpoint and compaction policy
   - device-retirement rules
   - quotas reported to the user

## 8. Data flows

### 8.1 An Agent's `apply` reaches pixels

1. The MCP or CLI surface authenticates the call and builds the verified context (principal, Agent ID, grants).
2. The `agent` unit normalizes and repairs the batch, resolves relative placement through `measure_text` and `scene`, and runs lints.
3. `kernel.apply_agent_batch` enforces ownership and Region rules, then commits one atomic batch. The `link` unit journals it durably and returns `accepted` with the batch ID, repairs, lints and pending-Send count.
4. The sync coordinator encrypts the change and sends it over the fastest live path. On the iPad, `kernel.receive` emits a delta. The native renderers update only the affected Elements. PencilKit is never re-serialized. Writes to a Space you aren't viewing set its unread badge. Your current Space never changes.

### 8.2 You circle a node and press Send

1. PencilKit draws the circle immediately. When the stroke finishes, it enters `kernel.apply_user_intent` once, with a stable stroke ID and portable geometry.
2. When you press Send, the iPad captures the raw Send:
   - the frontier and stroke IDs
   - the trigger, viewport and selection
   - the on-device transcript with word timings
   - the Apple handwriting hint
   - the crops it rendered
   - each Embed's answers to the Anchors it registered

   Then `kernel.freeze_send` makes it immutable and durable (`ready`).
3. The raw Send syncs to the Link. There the kernel groups the Marks and resolves the Anchors, and the `agent` unit projects the Send Bundle (§4.3). A `wait_for_user` call waiting on the Inbox is released with it.
4. The Agent replies with `apply(in_reply_to: "s_12")`, which also acknowledges the Send. If the stdio pipe dies first, the Send is redelivered, flagged `redelivered`.

### 8.3 A cloud Agent through the Relay

1. claude.ai or ChatGPT calls remote MCP at `relay.eilmer.si` over OAuth.
2. You approve the Agent, and a device issues a scoped, expiring grant for one Space (ADR-0004).
3. The cloud session decrypts and materializes the Space, then runs the same `kernel` and `agent` code. Changes go out encrypted to your devices.

Cloud execution only runs in a Durable Object if the 128 MB benchmark passes. Otherwise it runs in a separate execution service, and the Durable Object stays the encrypted router and log.

## 9. Schemas and code generation

- **JSON Schema 2020-12 is the canonical public contract**: the wire format, tool inputs and outputs, Send Bundles, extension manifests and parameters. A documented, restricted subset is used.
- **Rust:** serde types are generated from the schemas, and boundary tests check them against shared fixtures.
- **Swift:** gets UniFFI-generated kernel types. A small, honest Swift layer validates only the v0 schemas that Swift actually parses. There is no general Swift schema compiler.
- **TypeScript:** generated types plus Ajv validators in strict mode, precompiled in trusted builds.
- **The rules:**
  - Patches are explicit operations, never nested optionals.
  - Unknown props are preserved as raw JSON plus engine metadata, and old clients move unknown Elements by envelope only.
  - Integers stay in the shared safe range.
  - Text ranges are UTF-16 at the boundary.
  - CRDT changes and assets use their own binary codecs.
- **Fixtures are written by hand**, not generated, so a generator bug can't reproduce itself in the tests. CI reruns the pinned generators and fails if the output differs.
- **TypeSpec and protobuf are not used for v1.** TypeSpec would only be reconsidered if authoring the schemas becomes a measured pain, and then it would become the sole source. Either would otherwise add a second authoritative model.

## 10. Repository layout

```
protocol/            schema/, generated/, fixtures/, spec/          (Reflex Protocol)
kernel/              Rust crate + uniffi + wasm bindings
agent/               TypeScript: capabilities/, surfaces/{mcp,cli}/, projection/, lints/,
                     recipes-loader/, exec/, delivery/, tool-text/ (hand-written, eval-gated)
link/                TypeScript composition: storage/, sync/, transports/, pairing/, render-headless/
relay/               TypeScript: domain/, cloudflare/, node/
apps/ipad/           Swift app + Packages/{ReflexKernel (UniFFI), ReflexRender, ReflexInput, ReflexEmbed}
apps/web/            viewer + `reflex dev` playground
extensions/
  guides/            one .md per domain or type
  recipes/           one .md per scenario pattern
  embeds/            Embed Templates (charts, code graph, plate map, …)
  adapters/          claude-channel/, webhook/, mcp-app/
  formats/           mermaid/, excalidraw/, drawio/, svg/, markdown/, latex/, gltf/, json-canvas/
evals/               Agent eval harness + recorded Send Bundles
tests/               traces/ (kernel), conformance/ (scenarios), contracts/ (per extension kind), perf/
docs/                SPEC, ARCHITECTURE, adr/, architecture/ (design history)
```

**Enforced boundaries:**
- dependency-cruiser and ESLint restricted imports in TypeScript
- `cargo deny` plus crate-level `#![forbid]` on IO modules in the kernel
- SwiftPM target graph checks in CI

Specific rules:
- `kernel` imports no IO.
- `agent` imports no platform UI or concrete transport.
- Nothing imports `link`, `relay`, or the apps.
- Extensions import only `protocol` and the published extension SDK types.
- No code `switch`es over all Element types outside the kernel's type registry.

## 11. Versioning

- **Reflex Protocol:** semver. Minor versions add optional features; a major version changes meaning. Peers exchange protocol range, engine profile, crypto suite, key epoch and frame limits in an authenticated hello.
- **Kernel:** one crate version is used across Swift, the Link, the Relay and web. There is no version-pair matrix.
- **Element schemas:** each type has its own monotonic version and a pure migration that runs once inside the kernel. Unknown versions are preserved.
- **Extension kinds:** each manifest kind is versioned separately. Pre-v1 releases ship as one lockstep bundle that still publishes its compatibility manifest.
- **MCP:** the dated MCP revision is versioned independently of the Reflex Protocol. The first surface is whatever binding the target harness versions actually support, measured in milestone 0. The modern stateless 2026-07-28 binding is added alongside it.

## 12. Build map: vertical milestones, with parallel lanes

| Milestone | Parallel lanes (independent owners) | Exit condition |
|---|---|---|
| **0. Spikes** | (a) Ink on a real iPad: capture, partial erase, undo, reload, stable IDs, minimum OS. (b) Rust kernel skeleton bound to Swift and WASM, with FFI, size and cold-start numbers. (c) Automerge vs Loro Ink benchmark (10k, then 100k strokes). (d) Real Claude Code and Codex bounded-wait, cancel and lost-response behavior. (e) Eval harness skeleton plus hand-written tool text v0 | Engine chosen; kernel go/no-go; MCP binding and timeout policy chosen; numbers recorded in ADRs |
| **1. One round trip** | kernel (envelope, Ink, text, shape, connector, `apply`, `scene`, `freeze_send`) · agent (`open_space`, `apply`, `read`, `look`, `wait_for_user`) · link (journal, LAN, pairing, approval) · ipad (Ink, render, Send capture) | Agent draws a graph → you circle a node → the Agent gets the Mark with its target ID and crop → it annotates on its own layer. Kill the Link after the Send; the Send is still delivered. |
| **2. Coding plan review** | arrows, strikethrough and writing Marks · voice with interleaved transcript · undo and revert · headless `look` on the Link · CLI parity · evals | Scenario 1 passes in Claude Code and Codex, through both MCP and the CLI |
| **3. Math tutor** | LaTeX Element · writable Region · Region Send button · line-level evidence · grading recipe and guide · optional watch mode | Scenario 2 passes, including evals |
| **4. Prove the seams** | the first Embed Template with Anchors (a chart) · `reflex create/test/dev` · a second transport (Relay WebSocket or Apple peer-to-peer) · HTML isolation hardening | An outside-style Embed Template ships with no core edits; an old client preserves an unknown type; duplicate delivery over two paths is harmless |
| **5. 3D + data** | RealityKit Embed, glTF/USDZ part maps · chart and grading recipes | Scenarios 3–5 |
| **6. Relay + web** | encrypted log, OAuth, grants, 128 MB benchmark → placement decision · web viewer · self-hosted Node Relay | A cloud Agent works on a granted Space; the Relay stores no plaintext outside sessions |
| **7. Push adapters** | Claude Code channel → extract the adapter contract → webhook → MCP App | Each passes the shared delivery suite; any unsupported host falls back to the Inbox |
| **8. v1** | remaining scenarios · Protocol v1 publication · conformance profiles | Full suite green |

Within a milestone, each lane publishes its fixture or fake first, so the next lane can build against it.

## 13. Library choices

| Area | Choice | Notes |
|---|---|---|
| CRDT | **Automerge**, with Loro as the fallback | Decided by the milestone 0 benchmark. Both are Rust cores used directly by the kernel (gpt-sol §10.1, Astra §4.1) |
| Ink | **PencilKit** | WWDC26 adds stable stroke and path IDs and on-device handwriting recognition (verified, Astra §4.2). Custom Metal only if profiling shows a blocker |
| FFI | UniFFI (Swift), wasm-bindgen (TypeScript) | UniFFI's WASM target is unverified, so wasm-bindgen is used for TypeScript |
| MCP | TypeScript SDK v2 (verified) plus a compatibility binding for initialization-era clients | |
| Panels | Our own small component catalog; an A2UI adapter later, pinned to a specific renderer version | |
| Relay | Durable Objects (SQLite + hibernatable WebSockets) for the encrypted log, R2 for assets | Cloud execution placed only after the 128 MB benchmark |
| Schemas | JSON Schema, Ajv, and quicktype for DTOs once an adversarial round-trip spike passes | |
| Networking | Network.framework on Apple devices; Bonjour/TCP elsewhere | |

## 14. Open questions and risks

1. The minimum iPadOS version, and the memory class of the baseline device: milestone 0a.
2. Kernel go/no-go, and who owns the Rust kernel: milestone 0b.
3. Whether a materialized Space fits within Workers' 128 MB: milestone 6.
4. Whether UniFFI can target WASM, or whether wasm-bindgen stays: milestone 0b.
5. Whether in-process JavaScriptCore can run WASM on current iPadOS. This matters only for the fallback.
6. How each harness's strict tool-schema mode handles the `apply` unions: milestone 0d.
7. Whether there is a supported USB-C path.
8. Key recovery after losing every paired device. An OAuth login alone must never be presented as recovering end-to-end encrypted data.
9. Which default CDNs are allowed, how they're pinned, and how redirects are handled.
10. The UI for showing recipients when a Send fans out to several Agents.
