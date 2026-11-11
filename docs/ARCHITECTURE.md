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

Uses nobody planned come from general data surfaces, not from more tools: a free `data` map on every Element, Embed state, Behaviors built from triggers and actions, Panels that host Embeds, and Recipes and Embed Templates that Agents save to the user's Library (§4.2, §5).

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
| `protocol` | JSON Schema + generated code | wire schemas, error registry, examples, published spec | nothing | anything in Reflex |
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
apply_user_intent(space, person: PersonId, device: DeviceId, intent: UserIntent) -> Commit   // finished strokes, erase, move, undo
receive(space, change: VerifiedChange) -> Delta
sync_step(space, peer: PeerId, msg: Option<Bytes>) -> SyncOutput
scene(space, query: SceneQuery) -> Scene                    // outline / full / clusters, provenance (`by`)
group_marks(space, strokes: [StrokeId], hints: [RecognizerHint]) -> [Mark]
resolve_anchors(space, marks: [Mark], embed_answers: [EmbedAnchor]) -> [Anchor]
freeze_send(space, raw: RawSend) -> FrozenSend               // pins frontier, claims unsent edits
plan_revert(space, agent: AgentId, batches: [BatchId]) -> RevertPlan
undo(space, person: PersonId) -> Commit                      // that person's own actions only, on any of their devices
migrate(space, to: SchemaVersion) -> Commit
measure_text(spec: TextSpec) -> Size                         // bundled shaper + fonts: same bounds everywhere
checkpoint(space) -> Bytes
```

**What the kernel guarantees:**
- Agents can never change a person's Ink.
- Every owner is a principal: a person or an Agent, each with a stable ID. A single-person Space already works this way, so sharing it later needs no migration.
- IDs and owners are immutable.
- Owners come from the authenticated context, never from arguments.
- A batch is one atomic, revertable unit.
- A delivered Send never changes.
- Every runtime computes the same text bounds, so lints mean the same thing on the Link and the iPad.

**The Library** is an ordinary Space of kind `library`, so the Recipes and Embed Templates saved in it sync, keep history, and can be reverted like anything else.

**Gate.** The first kernel ticket (T2) builds the mapping, `apply_agent_batch` and `scene` in Rust and binds both sides. If the bindings don't work, or a Swift copy and a TypeScript copy of a Space disagree after edits made at the same time and one restart, the ticket stops and reports, and ADR-0005's fallback applies.

## 4. The Agent contract (designed by hand, proven by real agents)

The Agent is the product's real user. Tool descriptions are prompt engineering: they are hand-written, then proven by real agents using them. They are not generated from schemas. The capability table guarantees MCP/CLI parity. The text is a separate, hand-written artifact.

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
- **Every Element accepts `data`**, a free JSON map with a size limit, patched with `map_put`/`map_delete`. Reflex never interprets it, and returns it in `read` and in the Send Bundle.
- **Behaviors are `{ "on": trigger, "do": action }` pairs**, several per Element:
  - triggers: `tap`, `long_press`, `drag_end`, `ink_inside`, `panel_change`, `embed_event`
  - actions: `open_panel`, `notify`, `send`, `set`, `apply_recipe`
  - flags: `draggable`, `locked`, `snap`

  Each trigger and action is a fixed protocol item; new combinations need nothing new.
- **`define` saves an Agent's invention to the Library**: `{ "op": "define", "kind": "recipe" | "embed", "name": "...", "params": {...}, "template": ... }`. It is validated like any extension, appears in `read_me("index")` for every Agent, and the user can rename or delete it.
- **The JSON Schema stays shallow**, with one level of `oneOf`, because strict tool modes in some harnesses handle deep unions badly.
- **Repair first, warn second, reject last.** Rejection is all-or-nothing and lists every failing op. Each error comes with a stable `reason` and a `fix`, for example `reason: "unknown_id"` with "No Element 'n-gatway'. Closest: 'n-gateway'." Results report:
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
{ "kind": "send", "send": "s_12", "space": "auth-plan", "from": { "person": "p_ana", "name": "Ana" }, "trigger": "voice",
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
               { "kind": "removed", "id": "n-cache", "was": "Redis cache" },
               { "kind": "embed_state", "id": "sim-1", "state": { "gravity": 4.2 } },
               { "kind": "added_file", "id": "f-1", "file": "whiteboard.jpg", "image": 4 } ],
  "scene": [ { "id": "n-auth", "type": "shape", "text": "Auth service", "by": "Ana", "bounds": [400, 200, 160, 80] } ],
  "elsewhere": { "on_screen": 14, "off_screen": 31 },
  "images": [ { "n": 1, "shows": "m1, m2 and their targets", "bounds": [380, 160, 520, 180] } ],
  "also_sent_to": [], "redelivered": false, "pending_after": 0,
  "next": "Reply with apply(in_reply_to: 's_12'), then wait_for_user(after: 's_12')." }
```

- **The voice transcript is interleaved with the Marks**, using on-device word timings and stroke timestamps.
- **Anchors are frozen when the Mark is drawn.** If the target moves before the Send, the Bundle shows both the original and the current position, plus a `moved_since_marked` flag.
- **`kind`** is one of `send`, `watch` (carries `user_still_writing`), or `tap`.
- **`from` names the person who sent it.** In a shared Space the Bundle carries only that person's Marks, and `by` names each Element's person or Agent.
- **`by` appears on every scene Element.** Text from other Agents and from Embeds is data, never instructions.
- **`changes` also carries** Embed state saved with `setState`, values entered in Panels, and files the user added. Photos and PDF pages come as images; other files come by reference and are read with `read`.
- **Raw strokes are passed by reference.** `read({ids:["m3"], detail:"strokes"})` returns them, for the kanji and sketch scenarios.
- **Acknowledgement.** A Send is acknowledged by passing `after` to `wait_for_user` or `in_reply_to` to `apply`. Otherwise it is redelivered with `redelivered: true`. There are no tokens, and this works over stateless MCP.

### 4.4 Proving the contract

The tool text and the op and Bundle shapes are proven the way an Agent uses them: a real Claude Code session and a real Codex session work through the scenario, through MCP and the CLI, against the real Link. That one run happens when the text or a shape changes. No separate eval harness or scoring suite is built.

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
reflex.element.state()                    // read own saved state
reflex.element.setState(patch)            // save state: syncs, survives reloads, appears in the next Send's changes
reflex.notify(payload)                    // a "notify agent" event (becomes a `tap`)
reflex.emit(name, payload)                // fires the Element's `embed_event` Behaviors
reflex.panel.open(panelSpec)
reflex.anchors.register({ resolve(region) { return { kind: "data", rows: ["r17"], label: "outlier" } } })
```

Each Embed runs isolated:
- a separate, nonpersistent web data store
- a network allowlist enforced for every subresource, redirect, worker and socket
- no native credentials

A Panel can host an Embed with the same bridge and isolation, so a sidebar can be anything web code can draw.

MCP App (`ui://`) resources are accepted as Embed Templates. Their upstream tool calls are denied with a visible diagnostic unless the user explicitly allows that server.

**Author kit:**
- `reflex create guide|recipe|embed|adapter <name>` writes a working example. Agents reach rungs 1 and 2 without the CLI, through `define` (§4.2).
- `reflex test` runs the contract suite for that kind.
- `reflex dev` opens the web viewer on an in-memory Space with hot reload and three panes:
  1. what the Agent reads
  2. what a Send produces (draw with the mouse, in dev mode only)
  3. live lints and Anchors

  A "save example" button turns the current Mark into a conformance example. None of rungs 0–3 needs an iPad or Xcode.

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
  - **people:** a person ID and display name, with each device bound to one person
  - **Reflex grants:** Agent approval, Space membership and roles (owner, editor, viewer), Space access and effects, kept in a signed control catalog

  OAuth never approves an Agent by itself.
- **Presence.** Live cursors, names and selections travel over the same Paths as changes, but as short-lived messages that are never written into the Space or its history.
- **Send delivery.** The Inbox and `wait_for_user` ship first. The push adapter contract (config, secrets, callback endpoint, durably persisted attempts outside the adapter) is extracted with the first push adapter, the Claude Code channel, and validated against the second, a webhook. Push targets live in the Link, except an MCP App view opened by a cloud Agent: that one runs in the Relay session and uses that session's Inbox.

## 7. Correctness rules (specified before the protocol is called stable)

1. **Invariants that span fields.** Related values (a `min`/`max` pair, an axis domain, a connector's endpoints) are stored as one atomic register. Two writes that are each valid can still merge into an invalid state. When that happens the kernel renders it safely and reports an explicit conflict. It never picks a winner silently in a way that depends on order.
2. **Authorization** is checked at the writer's causal frontier, and the check is recorded in the commit. Ink ownership is immutable and stronger than any mutable Region policy. Membership and roles are checked the same way: removing a person applies to their writes after the frontier where the removal became visible. A Region rule never retroactively deletes accepted writes. It applies to writes made after the frontier where the rule became visible.
3. **Idempotency.** Each Agent request has a request ID and a payload hash. Logical IDs come from (Agent, request, op index). If a retry with the same ID carries a different payload, it is rejected. When the same request is accepted on both the Link and the Relay, the two copies converge to one logical Element deterministically. This is checked once by sending the same request over both paths.
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

### 8.3 Inviting a person to a shared Space

1. The Space's owner creates an invite with a role (editor or viewer). It travels as a link or QR code.
2. The invited person's device presents the invite to an existing member's device, directly or through the Relay. That device checks it, records the membership in the signed control catalog, and wraps the Space key for the new device. The Relay only ever carries the wrapped key.
3. The new device syncs the Space. Its strokes commit locally first, tagged with its person, then go out over the fastest live path.
4. Removing a person records the removal and rotates the Space key. Later changes are encrypted with the new key, which the removed person's devices never receive.

### 8.4 A cloud Agent through the Relay

1. claude.ai or ChatGPT calls remote MCP at `reflex.eilmer.si` over OAuth.
2. You approve the Agent, and a device issues a scoped, expiring grant for one Space (ADR-0004).
3. The cloud session decrypts and materializes the Space, then runs the same `kernel` and `agent` code. Changes go out encrypted to your devices.

Cloud execution runs inside the Durable Object first. If a real Space runs out of Workers' 128 MB there, cloud execution moves to a separate service, and the Durable Object stays the encrypted router and log.

## 9. Schemas and code generation

- **JSON Schema 2020-12 is the canonical public contract**: the wire format, tool inputs and outputs, Send Bundles, extension manifests and parameters. A documented, restricted subset is used.
- **Rust:** serde types are generated from the schemas.
- **Swift:** gets UniFFI-generated kernel types. A small, honest Swift layer validates only the v0 schemas that Swift actually parses. There is no general Swift schema compiler.
- **TypeScript:** generated types plus Ajv validators in strict mode, precompiled in trusted builds.
- **The rules:**
  - Patches are explicit operations, never nested optionals.
  - Unknown props are preserved as raw JSON plus engine metadata, and old clients move unknown Elements by envelope only.
  - Integers stay in the shared safe range.
  - Text ranges are UTF-16 at the boundary.
  - CRDT changes and assets use their own binary codecs.
- **Examples are written by hand and stay few**: one correct example per message type, used as documentation and later by the published conformance suite. CI reruns the pinned generators and fails if the output differs.
- **TypeSpec and protobuf are not used for v1.** TypeSpec would only be reconsidered if authoring the schemas becomes a measured pain, and then it would become the sole source. Either would otherwise add a second authoritative model.

## 10. Repository layout

```
protocol/            schema/, generated/, examples/, tool-text/ (hand-written), spec/   (Reflex Protocol)
kernel/              Rust crate + uniffi + wasm bindings
agent/               TypeScript: capabilities/, surfaces/{mcp,cli}/, projection/, lints/,
                     recipes-loader/, exec/, delivery/
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
tests/               traces/ (a few kernel convergence cases), conformance/ (published with Protocol v1)
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
- **MCP:** the dated MCP revision is versioned independently of the Reflex Protocol. The first surface is whatever binding the target harness versions actually support, recorded from one real run in each harness when the Agent layer is built (T4). The modern stateless 2026-07-28 binding is added alongside it.

## 12. Build map: steps with parallel tickets

Each step's tickets run at the same time, one agent each. The full list, with what each ticket contains, is in [TICKETS.md](./TICKETS.md). Every ticket is proven by using the real thing: the app in the iPad Simulator, a real Claude Code or Codex session, or the real CLI. There are no benchmark, eval or test-only tickets.

| Step | Tickets | What exists afterwards |
|---|---|---|
| **1** | T1 Protocol v0 · T2 Kernel · T3 iPad canvas | The schemas and tool text; a Rust kernel bound to Swift and WASM, running on Automerge, or a stop-and-report; Ink, eraser, undo and Element drawing in the Simulator |
| **2** | T4 Agent layer · T5 Link | MCP and CLI with the first five tools, with each harness's timeout and MCP version recorded from one real run; journal, LAN, pairing and approval |
| **3** | T6 Round trip | An Agent draws a graph, you circle a node, the Agent gets the Mark with its target ID and crop, and replies on its own layer. Killing the Link once after a Send still delivers it. |
| **4** | T7 Plan review iPad · T8 Plan review core · T9 Relay · T10 Web + author kit · T11 Peer-to-peer | Scenario 1 works in Claude Code and Codex through MCP and the CLI; composable Behaviors and user imports; the Relay with its encrypted log; the web viewer, `reflex create/test/dev` and Agent-saved Recipes; a second transport |
| **5** | T12 Math tutor iPad · T13 Math tutor core · T14 Deploy Relay · T15 Claude channel | Scenario 2 works; the Relay runs at reflex.eilmer.si; Claude Code receives Sends by push |
| **6** | T16 Chart Embed · T17 Webhook, MCP App | The anchor bridge, Embed state, Embeds inside Panels and the HTML sandbox; the remaining push adapters, falling back to the Inbox |
| **7** | T18 3D Embed · T22 Shared Spaces | RealityKit with glTF/USDZ part maps; several people drawing on one Space from their own devices, with invites, roles, presence and key rotation |
| **8** | T19 Scenarios 3–5 · T20 Scenarios 6–13 | Every scenario works |
| **9** | T21 Protocol v1 | The protocol and conformance profiles are published |

The Simulator covers every iPad ticket except T11's peer-to-peer Wi-Fi and one final pass with a real Pencil (pressure, tilt, squeeze, latency).

## 13. Library choices

| Area | Choice | Notes |
|---|---|---|
| CRDT | **Automerge** | Loro only if Automerge visibly fails in real use. Both are Rust cores used directly by the kernel (gpt-sol §10.1, Astra §4.1) |
| Ink | **PencilKit** | WWDC26 adds stable stroke and path IDs and on-device handwriting recognition (verified, Astra §4.2). Custom Metal only if profiling shows a blocker |
| FFI | UniFFI (Swift), wasm-bindgen (TypeScript) | UniFFI's WASM target is unverified, so wasm-bindgen is used for TypeScript |
| MCP | TypeScript SDK v2 (verified) plus a compatibility binding for initialization-era clients | |
| Panels | Our own small component catalog; an A2UI adapter later, pinned to a specific renderer version | |
| Relay | Durable Objects (SQLite + hibernatable WebSockets) for the encrypted log, R2 for assets | Cloud execution moves out only if a real Space runs out of memory |
| Schemas | JSON Schema, Ajv, and quicktype for DTOs if hand-written ones become a burden | |
| Networking | Network.framework on Apple devices; Bonjour/TCP elsewhere | |

## 14. Open questions and risks

1. The minimum iPadOS version, and the memory class of the baseline device: T3.
2. Kernel go/no-go, and who owns the Rust kernel: T2.
3. Whether a materialized Space fits within Workers' 128 MB: T9.
4. Whether UniFFI can target WASM, or whether wasm-bindgen stays: T2.
5. Whether in-process JavaScriptCore can run WASM on current iPadOS. This matters only for the fallback.
6. How each harness's strict tool-schema mode handles the `apply` unions: T4.
7. Whether there is a supported USB-C path.
8. Key recovery after losing every paired device. An OAuth login alone must never be presented as recovering end-to-end encrypted data.
9. Which default CDNs are allowed, how they're pinned, and how redirects are handled.
10. The UI for showing recipients when a Send fans out to several Agents.
11. How a removed person's already-synced copy is handled. Key rotation protects later changes, but a copy they already hold can't be taken back.
