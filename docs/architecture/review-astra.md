# Adversarial review of the Reflex architecture

Review date: 2026-11-10. Target: [gpt-sol.md](gpt-sol.md). Context read first: [SPEC.md](../SPEC.md), [GLOSSARY.md](../../GLOSSARY.md), and ADR-0001 through ADR-0003. Section references below refer to the proposal unless explicitly identified otherwise. This review proposes decisions; it does not amend the settled documents.

## Verdict

Do not implement this architecture in its proposed package and build order. Keep its ownership rules, durable Send design, explicit revision handles, unknown-type preservation, and separation of capabilities from MCP/CLI. Cut the extension framework substantially.

The proposal mistakes an inventory of responsibilities for a useful set of independently maintained modules. Its roughly thirty catalog entries expand into still more packages, Swift targets, registries, generated artifacts, runtime adapters, and compatibility dimensions. Before an Agent can review one handwritten circle, the team is asked to build a small application platform and part of a schema compiler. That is an expensive way to discover that the stroke model or Send interaction is wrong.

The research is substantially better than the architecture's delivery plan. The checked WWDC26, MCP v2, MCP 2026-07-28, and A2UI v1.0 claims are supported by current primary sources. They should not be called hallucinations merely because they differ from older knowledge. The important weaknesses are unproved compatibility, unspecified distributed semantics, and abstractions that do not actually cover the advertised extension axes.

## 1. Replace the module catalog with six implementation units

Sections 2 and 6 explicitly insist that history, scene-query, Send assembly, and Panels/Behaviors become separate packages. There is no demonstrated second consumer, independent release cycle, or ownership structure that justifies this. A private folder can have a narrow interface and dependency tests. Moving it behind a published package adds coordination without making its semantics more independent.

Use these six logical units initially. Swift and TypeScript implementations are separate build targets where necessary; this is not a claim that one TS package can execute natively in Swift.

| Initial unit | Responsibilities merged from §§2 and 6 | Boundary to enforce |
| --- | --- | --- |
| `protocol` | Wire schemas, generated models, version profile, portable Ink codec specification, interoperability fixtures | No application or platform dependencies; versioned public data contracts |
| `core` / Swift `ReflexCore` | Semantics, built-in capabilities, scene queries, history/revert, Region rules, declarative Behaviors, recognition/anchoring coordination, Send assembly and Inbox rules | No MCP, CLI, UIKit, sockets, database, or engine handles; trusted intents enter through one validation path |
| `replica` / Swift `ReflexReplica` | Space runtime, one selected CRDT implementation, durable journal/checkpoint integration, asset lifecycle, sync coordinator | Owns persistence and replication; exports immutable views, committed deltas, and transaction results |
| `content` / Swift content target | Built-in Element definitions, renderer registrations, basic recognition, later formats, simple recipes and docs | Open Element identity and opaque props; platform renderer code stays in explicit subtargets, not the portable import graph |
| `link` | Composition, local identity/approval, credential access, pairing, LAN implementation, CLI backend, stdio proxy, MCP/CLI bindings, later push delivery | One long-lived process; surfaces call the same invoker; networking and credentials remain outside core |
| `ipad` | App lifecycle, PencilKit, speech, native rendering, viewport, user input, platform storage/network/crypto bindings | Local interaction does not wait on recognition or network; no Agent operation can navigate the user |

Conformance fixtures live with protocol and ordinary test targets, not a production service. Add `relay` and `web` as deployment units when they are implemented. Extract shared rendering or delivery packages when those second consumers expose an actual stable interface. This preserves the spec's top-level intent without its own premature expansion into a package federation.

### Boundaries worth having on day one

1. **Public protocol versus internal objects.** IDs, operations, revisions, Send Bundles, and compatibility rules must survive independent Swift/TS releases. Never expose Automerge objects to content or surfaces.
2. **Authenticated capability invocation versus surface formatting.** MCP and CLI already are two implementations. ADR-0003 justifies this immediately. Keep one static capability table and two thin bindings; it does not justify a general capability-plugin marketplace.
3. **Semantic intent versus durable commit.** Ownership checks, normalization, idempotency, and the persistence barrier require a clear transaction API even inside a small codebase.
4. **Element envelope versus type-specific props and rendering.** Multiple native types exist immediately. Use a static registry, namespaced IDs, versioned props, and an unknown-type fallback from the first saved Space.
5. **PencilKit capture versus durable portable Ink.** This prevents native drawing archives from becoming the protocol and protects the latency path.
6. **Replication versus byte transport.** Define peer identity, frames, backpressure, cancellation, and reconnect now. Start with one real LAN transport and a fault-injection transport. Add path scheduling when a second usable path exists.
7. **Inbox durability versus delivery.** Waits cannot own the records they return. Keep durable recipient/ack semantics now; a bounded waiter can call Inbox directly.
8. **Device/platform services versus pure rules.** Narrow storage, renderer, clock, and credential dependencies are useful. These are internal testable seams, not promises of a stable public plugin ABI.

### Boundaries that should wait

- **`contracts`, public `plugin-sdk`, activation/disposal infrastructure, dependency resolution, artifact manifests, plugin permissions and subprocess RPC (§§2, 3.1, 6):** wait for an actual externally installed executable extension. Static application composition is enough for built-ins. Artifact hashes without a publisher trust/update model are not a distribution solution anyway.
- **`capabilities` separate from `core` (§2):** merge. A dispatcher and its twelve built-in handlers do not need independently released packages. Keep protocol bindings out of the handler implementations.
- **History, query, recognition coordination, anchoring, Send assembly, Inbox, Panels/Behaviors (§2):** private modules within core. They change together while the first two scenarios are being discovered. Pure functions and dependency checks provide the useful isolation.
- **`delivery` and `send-adapters/wait` (§§2, 3.4):** do not force a pull-based wait through a push-oriented `offer` abstraction. Extract a delivery worker and adapter contract with the first push implementation; validate the abstraction with the second.
- **Universal engine/storage/crypto/identity registries (§§3.1, 3.9):** keep implementation wrappers, not public plugin systems. An engine change requires a Space migration (§7), not runtime activation. Crypto suites are security-reviewed protocol choices, not interchangeable community conveniences. Generalize identity-provider methods only when local pairing and OAuth both exist.
- **General recognizer/format/recipe plugin hosts (§§3.5–3.7):** start with ordinary functions and registered data. Multiple built-in heuristics warrant a small callable interface, not permission manifests or worker infrastructure. Extract format streaming/probing when two real importers disagree about it.
- **Headless renderer SDK, client SDK and shared display-list language (§§1.1, 3.2, 6):** keep a render request/result seam, implement iPad capture first, and earn the portable rendering contract with one Link implementation. A display-list language with interaction, fonts, math, accessibility, and hit testing is itself a substantial product.
- **Generic surface plugins (§3.8):** MCP and CLI wrappers now; SDK/HTTP surface generalization when there is a third consumer. Surface metadata should not infect portable capability semantics.
- **`exec-runtime` (§2):** defer execution entirely until the two demos work. Its eventual sandbox remains a genuine isolation boundary; it is not a prerequisite for arranging a dependency graph.

Stable external interfaces should be the smallest tested interoperability promises. Internal interfaces should remain cheap to change during pre-v1. Calling all of them stable on day one works against the stated goal of extensibility.

## 2. The claimed extension coverage has holes

### 2.1 A new Element works only within an unspecified semantic vocabulary

Section 3.2 avoids a closed Element union correctly. But `MergeLayout`, `PreparedBatch`, patch addressing, and `Geometry` are mostly names. A plugin can declare collaborative text or keyed collections; the architecture never defines how an `apply.patch` means insert text, move a keyed child, or conditionally edit a particular field incarnation. If every patch is a JSON replacement, the merge layout cannot deliver the promised collaborative semantics. If each type invents operations, core dispatch and engine projection need changes.

Define a deliberately finite set of supported field operations and merge primitives, with behavior under concurrency. A type needing another primitive is a protocol change. Say so. No plugin API can make an unbounded set of future collaboration semantics free.

The unknown-type promise is also stronger than its contract. An old client receives a type whose merge layout it does not know. Can it inspect bounds and move the envelope without decoding or rewriting nested CRDT containers? Sections 3.2 and 7 say yes but do not define the persisted layout descriptor or generic projection needed to do it. Preserve the underlying unknown subtree, including engine metadata, and update only understood envelope paths. Test old-client move/save/reload against a future type with collaborative text; a JSON round trip alone is inadequate.

The required schema, web/iPad/headless renderer, migration, lint, anchor, import/export declarations, docs, and fixture matrix in §3.2 is too high an entry fee for an experimental Element. Require schema, safe geometry/summary, and one renderer; provide explicit generic fallback contributions for other facets. Require richer profiles when the type claims those features.

### 2.2 Adding Android requires editing the supposedly open contracts

`PluginManifest.runtimes` is the closed union `link | relay | web | ipad` (§3.1), while `ElementType.renderers` explicitly names `ipad`, `web`, and `headless` (§3.2). `ClientProfile` (§3.9) cannot repair those upstream closed shapes. A native Android renderer requires changing the manifest schema, generated types, packaging validator, and contribution contract. That is a concrete core-contract edit, beyond composition/lockfile changes.

Use namespaced runtime/renderer-profile identifiers with capability requirements, and distinguish “must render somehow” from “must have native code for every platform.” Start by supporting only the actual profiles. A new client must implement the replication/semantic profile as well as rendering: generated `Codable` models are not an Android or visionOS SDK.

### 2.3 The transport interface cannot accept a connection

`Transport` in §3.3 has discovery and outbound `open`, but no listener/accept lifecycle or host registration for incoming paths. The sync module has `attach`, yet the transport contract never explains who calls it for a passive server connection. A Relay connection may multiplex many peers, while `Path.peer` assumes one peer. Neither authentication handoff nor logical peer paths over a routed connection are specified. Authors will reach into runtime composition or the sync coordinator to finish their transport.

Define how a transport yields authenticated-or-pending paths in both directions and how the coordinator binds them to a peer. Keep discovery optional. Specify whether a Relay transport demultiplexes into logical per-peer paths and where replay/framing applies. Before supporting unordered/unreliable paths, specify sequencing and retransmission of engine sync messages; idempotent CRDT changes do not prove arbitrary stateful sync conversations tolerate missing messages. Anti-entropy is a recovery mechanism, not a complete definition of that contract.

The estimated fastest-path formula is a plausible heuristic, not a latency guarantee. It omits startup, radio contention, uncertainty, and cost of hedging. First prove reconnect and bounded queues. Add measurements and hysteresis when LAN and a second path can be compared.

### 2.4 A Send Adapter needs more than `offer`

Section 3.4 has a useful narrow delivery view and sensible at-least-once behavior. But a webhook adapter needs configuration, secret retrieval, a callback/ack endpoint, credential rotation, durable retry scheduling, and disposal. A channel needs an outbound notification connection owned by an MCP surface. An MCP App needs a live view and host session. None of these dependencies has a concrete registration contract; “delivery-scoped host ports” hides the hard part.

For the first push adapter, define those specific host dependencies and persist attempts outside the adapter. A retry delay returned by a function is not durable scheduling. Avoid a single universal SDK until two adapters demonstrate the shared minimum. Keep wait/Inbox available independently.

### 2.5 Auth and surfaces have the same category error

`IdentityProvider` combines authentication, device pairing, and revocation (§3.9). An OAuth token verifier is not a device-key pairing provider. Separate evidence verification from the fixed grant/control policy; compose pairing as its own workflow. A grant revocation needs causality and dissemination semantics, not merely a method returning `void`.

`CapabilityDescriptor` requires MCP annotations and CLI argument mappings (§3.8). That makes the portable capability catalog depend conceptually on its current surfaces even when the SDK imports are banned. Keep semantic input/output/effect metadata together, with separately keyed binding metadata. The same core behavior across MCP and CLI is essential; forcing every future capability to know every presentation is not.

## 3. Correctness gaps matter more than another port

### 3.1 Validation before a local commit does not validate the merged result

Sections 1.2 and 5.1 validate prospective props locally. Suppose an Element requires `min < max`, initially 0 and 10. One disconnected writer changes min to 9; another changes max to 1. Both local writes are valid. A fieldwise merge can produce 9 and 1. Similarly, a Region becomes Agent-read-only on one replica while another approves an Agent write against the old Region state.

Choose a rule: related values form an atomic register; merged violations become explicit conflict states with safe rendering; or an operation CRDT enforces the invariant. Define whether authorization is checked at the writer's causal frontier or against a converged control state. Merely rerunning local rejection logic during receive risks order-dependent replicas. Keep immutable user-Ink ownership as a stronger invariant than mutable Region policy.

### 3.2 Global request idempotency is not provided by a local journal

Section 5.1 atomically saves request/result mappings locally. An Agent times out at Link and retries at Relay during a partition. Both can accept the same request. Request-derived IDs help, but two replicas can still independently create competing nested CRDT objects under one logical Element ID. Shared root genesis (§1.2) does not solve per-Element creation races or same-ID creates by different Agents.

Specify request scope, payload hash checking, stable logical birth identity, and deterministic conflict/projection behavior. Either route retries to a named acceptance endpoint and disclose its offline limitation, or support duplicate concurrent acceptance explicitly. Test Link/Relay duplicate creation and replay with different input, not just a lost stdio response to one process. ID “repair” must not silently change the meaning of connectors or anchors.

### 3.3 Pinning a revision is not sufficient to reconstruct what the user marked

Sections 3.2 and 5.2 correctly discuss marking-time transforms and Send-time freezing. The missing product decision is what happens when the Agent moves a target between the circle and Send. The image at Send time may show the target elsewhere, while the mark retains its earlier anchor. Dynamic HTML and 3D camera state can change without a CRDT revision at all.

Store marking-time target evidence and a render-state identifier/capture where needed; preserve both the original and current resolution. Show an ambiguity or moved-target indication. Define the capture barrier across strokes, viewport, content layout, and Send assembly. Historical CRDT lookup cannot reproduce a prior DOM animation, font load, or WebGL camera by itself.

### 3.4 Durable Ink and durable Send preparation need a small explicit state machine

The proposal acknowledges pending preparation (§5.2) but does not pin down which transaction freezes unsent-edit IDs or advances the local cursor. Two rapid Sends, process death during assembly, or interrupted voice transcription could duplicate or omit user edits. Define persisted states such as preparing, ready, and acknowledged-per-recipient, plus cancellation/error recovery and edit-claim behavior. Raw evidence must be durable before the UI indicates a saved Send.

Section 3.4 wisely requires explicit acknowledgements. Do not promise that “the next Agent call” proves durable harness receipt: ordinary MCP/CLI consumers may keep no durable local state. Define ack as the consumer's declared acceptance, return pending records until that declaration, and make the replay visible. Reflex can guarantee durable availability and retries, not eventual processing by a stopped harness.

### 3.5 Full replicas and selective grants need a precise trust model

Sections 3.9 and 5.3 distinguish grants from keys, which is good. But a whole-Space key decrypts a whole-Space replica. An Agent-scoped grant limits what honest Relay code returns; it does not cryptographically limit what that execution context can read. Expiry is enforced policy, not a cryptographic eraser. State the trusted components and the consequences of a compromised Relay context.

Likewise, filtering a recipient's Send Bundle is not enough if the signed control catalog changes during an offline period. Define which grant version freezes recipients and what delivery does after revocation. For v0, use Space-level access and causal policy with explicit refusal when grant validity is unknown; do not imply stronger isolation than the chosen replication model provides.

### 3.6 Retention is not a late maintenance feature

Each Space accumulates strokes, removal records, batches, immutable Sends, receipts, and historical asset references (§1.2). Watch mode adds repeated snapshots. A note saying GC needs a policy does not bound storage or replay cost. Before any public release, set Send/image retention, maximum watch frequency/size, device retirement behavior, and history limits. Distinguish deleting derived assets from reclaiming engine history. An unbounded full-history model can defeat the 100k-stroke target regardless of how clean the engine port looks.

## 4. Primary-source checks as of 2026-11-10

These are web search/fetch checks, not compiled SDK or performance tests. Current project READMEs establish advertised status, not application-level suitability. Several deep documentation URLs failed to fetch; the findings below use the accessible primary pages rather than treating fetch failures as proof of nonexistence.

### 4.1 Automerge, Loro and Yjs Swift status — substantially correct (§10.1)

- **Automerge:** its official Swift README describes cross-language support and says the supplemental Swift repository layer is tested with JavaScript Automerge Repo. It also points to a native app using WebSocket and peer networking. This supports trying Automerge first; it does not certify Reflex's history, multi-path sync, or large-Ink workload. [Official Swift README](https://raw.githubusercontent.com/automerge/automerge-swift/main/README.md).
- **Loro:** the official Swift README still calls the bindings experimental. Its 1.17.1 notes document pending-update export/recovery and an undo call that can consume an item without changing state. The proposal's status and recovery claim check out. “Experimental” alone does not prove missing required features; compare actual API coverage and release artifacts. [Official Loro Swift README](https://raw.githubusercontent.com/loro-dev/loro-swift/main/README.md).
- **Yjs/Yrs/YSwift:** YSwift says it is built on Yrs, interoperates with Yjs implementations, and remains WIP with incomplete exposed features. That supports a Swift integration-risk penalty, not a claim that Yjs has no Swift route. [Official YSwift README](https://raw.githubusercontent.com/y-crdt/yswift/main/README.md).

**Decision:** Automerge first, Loro as the concrete fallback, YSwift only if the required API coverage changes the result. Pin actual Swift/core/npm version triples and test update exchange, erasure, historical views and recovery. Do not spend the first milestone implementing three production engine adapters merely to defend a provisional ranking.

### 4.2 PencilKit WWDC26 — verified, with a narrower implication (§10.2)

Apple's WWDC26 session explicitly describes iOS 27 on-device handwriting recognition, stable UUID identities on strokes and paths, selection access, programmatic erasing/substroke extraction, Metal rendering, and the cost of slicing complex drawings. The proposal's central claims are supported. [Apple: Read between the strokes with PencilKit](https://developer.apple.com/videos/play/wwdc2026/203/).

The leap to question is architectural: these APIs do not supply Reflex's portable stroke codec, replicated erase lineage, undo attribution, or historical mark capture. Verify ID behavior through native serialization, erase fragments and reconstruction from portable geometry. Choose the supported OS/device baseline during the first Ink spike, not after an abstraction has already promised all versions. Retain a native archive for fidelity and a tested portable form for interoperability.

### 4.3 MCP SDK v2 and specification 2026-07-28 — verified (§§3.8, 10.3)

The SDK's v2 page calls it the stable release line implementing 2026-07-28 and shows the split server package. The specification describes self-contained requests and per-request negotiation; the official release post confirms removal of the initialization exchange and `Mcp-Session-Id`. The proposal is correct on these points. [SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/), [specification](https://modelcontextprotocol.io/specification/2026-07-28), [official release explanation](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

Do not turn that into an assumption about installed harness versions or timeout behavior. Start with the binding that the two target harness versions actually support; add the other binding using SDK compatibility facilities where available. Publish tested host/version/timeout/cancellation results. The proposal already warns that progress does not guarantee a timeout extension; keep that warning and measure it before building a generalized surface host.

### 4.4 Durable Objects — cited limits correct; execution feasibility unproved (§§1.1, 5.3, 10.3)

The documented SQLite-backed limits include 10 GB per object and 32 MiB received WebSocket messages. Hibernation can retain inbound WebSocket connections while discarding in-memory application state; reconstructing from durable state/attachments is necessary. These parts of the proposal check out. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

The material omission is **128 MB per Worker isolate, including JavaScript and WebAssembly allocations**. DO documentation says Workers limits also apply. Disk capacity is not a full-CRDT working-set budget. Materializing history, building projections, cloning candidate state, and rendering can exceed it long before SQLite is full. [Workers memory limits](https://developers.cloudflare.com/workers/platform/limits/).

**Decision:** keep a DO as encrypted routing/storage coordinator; prove a representative materialized Space fits before putting cloud capability execution there. Otherwise use an explicitly placed execution/render service and budget its cold-load time and key lifecycle. The proposal already allows a separate render service; it needs the same explicit decision for CRDT materialization. A hibernated promise or expired in-memory key cannot sustain a cloud Agent wait/session by wishful thinking.

### 4.5 A2UI v1.0 — verified; renderer parity is a separate claim (§10.3)

The official site identifies v1.0 and describes registered component composition. Its community renderer catalog lists distinct version support by implementation; the fetched Apple community entry lists v0.8/v0.9.x. Search snippets and catalog pages were not fully consistent about current Swift v1 support, so pin a specific renderer release before claiming it. [A2UI](https://a2ui.org/), [community renderer catalog](https://a2ui.org/ecosystem/renderers/).

The proposal is right to say “A2UI-style” is not blanket compatibility. However, importing a live UI protocol may require maintaining surface/data-binding state and translating user actions, not just converting one JSON file into a Panel. Treat a future A2UI adapter as a restricted, versioned session translator. For the demos, implement a button and simple Panel fields directly.

## 5. Decisions on all five challenges in §11.1

1. **Encrypted Relay versus full replica — agree with the conflict, partially disagree with the remedy.** An encrypted archive should not be quietly renamed a normally functioning CRDT replica. I would explicitly amend the ADR to distinguish a complete recoverable encrypted archive from a materialized replica during a user-authorized cloud session. Keep one CRDT per Space and no Relay merge authority. Define archive completeness/recovery, key lifetime and cloud-execution trust before protocol storage commitments; do not postpone all of this to Wave 6. This is a proposed amendment, not permission to disregard the current ADR.

2. **CRDTs do not give authorization/undo for free — strongly agree.** Correct ADR-0001's “without extra work” cost implication. Keep author-scoped compensating operations, immutable ownership and trusted capability endpoints. Add concrete concurrent-edit/revert traces before choosing the engine mapping. Do not make arbitrary paired devices untrusted validators unless the team is willing to design a substantially stronger system. State that paired writable replicas are trusted application nodes.

3. **MCP Apps accepted as-is versus the small bridge — agree.** Preserve HTML/resource metadata as input, but advertise a restricted host profile and reject unsupported tools/permissions with visible diagnostics. “Accepted” must not mean “fully functional.” Do not proxy arbitrary upstream calls in v0. A later explicit user grant can add scoped upstream capabilities without expanding every Embed's default rights.

4. **Always-open fastest paths versus platform limits — agree.** Promise automatic use of available paths while the OS permits execution, with recovery after suspension. Ship Bonjour/LAN on supported desktop platforms first, then an Apple-specific router-free path. USB-C remains a feasibility item. Keep the multipath design; drop any literal promise that a suspended iPad remains continuously reachable or that Apple peer networking works identically on Windows/Linux.

5. **Arbitrary HTML cannot yield semantic anchors — agree.** Require cooperative anchor providers for chart data, DOM identities and 3D parts. For opaque content, return captured pixels, local coordinates and unresolved/low-confidence interpretation. Never manufacture a DOM/data target to satisfy the schema. Make the fidelity visible in both `look` and Send Bundles, with marking-time evidence retained when content later changes.

## 6. Schema/codegen: retain JSON Schema, reject the hidden compiler project

Section 4 picks a reasonable wire language and oversells the amount of tooling obtained by naming three libraries. quicktype supports schema-driven Swift and TypeScript model generation. Ajv standalone generation produces JavaScript validators ahead of time. Neither fact establishes a Swift validator with identical constraints, unknown-field preservation, tri-state patches, discriminators, canonical JSON, or all 2020-12 semantics. The proposal acknowledges this, then assigns all of it to a “small wrapper.” That wrapper is a compiler and compatibility runtime. [quicktype schema workflow](https://github.com/glideapps/quicktype), [Ajv standalone generation](https://ajv.js.org/standalone.html).

**My choice:** JSON Schema remains the canonical public data contract for v0; Ajv validates TypeScript boundaries. Treat quicktype as a replaceable build tool for ordinary DTOs, conditional on a small adversarial generation spike. Use explicit raw JSON preservation and hand-reviewed boundary types where generation cannot express required behavior. A small, explicit Swift constraint layer for the actual v0 schemas is preferable to announcing a general-purpose Swift schema compiler. Keep its obligations visible and test them against the same negative fixtures as Ajv.

Specifically:

- Define patch changes as explicit operations such as setting a value or removing a path. Do not rely on clever decoding of nested Swift optionals to distinguish absent/null/delete.
- Preserve unknown props and extension fields in an explicit JSON representation; never decode and re-encode an entire unknown subtree through a closed model. Define how shared safe integers and Unicode lengths are interpreted. Swift character counts and JavaScript string lengths are not interchangeable validators.
- Enumerate supported schema keywords and mappings. Fail generation on unsupported features rather than silently weakening validation. Pin the generator and Swift compiler settings, including `Sendable` behavior.
- Validate cross-language acceptance/rejection and round trips with hand-authored fixtures independent of the generator. Generating expected fixtures from the same implementation can reproduce the same bug twice.
- Keep canonical frame signing and duplicate-key detection at the byte/parser boundary. An Ajv validator cannot detect duplicate keys already discarded by a JSON parser.
- Precompile installed schemas in trusted builds. A data-only schema arriving at runtime cannot magically acquire an Ajv standalone validator on a restricted Worker or a generated Swift validator on iPad. Unknown types must remain opaque/read-only until their supported validation profile is present.

### Would TypeSpec be better?

TypeSpec is not merely an HTTP description tool: its official site shows JSON Schema and Protobuf output as well as HTTP APIs. Dismissing it as only useful for a future HTTP service (§4) is too narrow. It could make a large family of models easier to author and review. [TypeSpec](https://typespec.io/).

It still would feed JSON Schema into validators/model generators or require another Swift emitter/runtime. It does not, by itself, settle unknown-field preservation, patch meaning, or CRDT merge semantics. With this small initial protocol, I would not add a compiler stage. Reconsider when repetitive schemas become a measured authoring problem, and make TypeSpec the sole source if adopted; never hand-maintain both emitted JSON Schema and TypeSpec.

### Would protobuf be better?

For a closed binary control protocol, protobuf has a stronger ready-made Swift story through Apple's compiler plugin and runtime. It deserves more than a passing dismissal. [SwiftProtobuf](https://github.com/apple/swift-protobuf).

For Reflex's open Element props and JSON-facing tools, it relocates rather than removes complexity. JSON conversion still needs tool schemas and validation. ProtoJSON's evolution rules differ from binary protobuf: unknown fields are not preserved in the same way, and ordinary null handling treats fields as unset. Those behaviors collide with this proposal's preservation and patch promises unless Reflex adds explicit wrappers. [ProtoJSON semantics](https://protobuf.dev/programming-guides/json/).

Keep CRDT changes in their existing binary format and assets in versioned binary codecs; do not wrap everything in protobuf for hypothetical efficiency. Consider protobuf for a measured binary envelope need later, not as a second authoritative model of Elements. Zod-first or hand-maintained TS interfaces are no better shared source: they privilege TS and still leave Swift validation and generation to solve. The real choice is a small, tested common semantic subset, not the IDL brand.

## 7. Build the two product loops before the platform

Section 9 is not a realistic small-team critical path. Wave 0 freezes contracts before the Ink spike can change them. Wave 1 builds a manifest registry/SDK before any extension author exists. Wave 3 claims scenarios 1–2 end to end; Wave 4 introduces Panels/Behaviors, headless rendering and “scenario 2 complete.” The math demo needs a writable Region, a scoped Send trigger, LaTeX, line-level evidence, and usable visual feedback before it can pass. The full client/engine/transport/format/renderer test matrix in §8 is an eventual certification plan, not the entry ticket for the first demonstration.

Use vertical milestones with executable exit conditions. These are ordering recommendations, not invented calendar estimates.

### Milestone 0: retire three uncertainties in bounded spikes

- On a real supported iPad, capture strokes, erase part of one, undo, serialize/reload, and map stable Reflex IDs. Decide the minimum OS/device and portable stroke representation.
- Exchange an Automerge Space between Swift and TS, including concurrent create/patch/delete, a changed Ink asset reference, and restart. Try Loro only if a required behavior or measured budget fails.
- Run a tiny bounded wait tool through the actual Claude Code and Codex versions, including cancellation and a lost response. Establish the smallest supported MCP binding and timeout policy.

Run a small representative corpus first, then the 10k/100k stress case before committing to public scale promises. Do not require real Relay integration in the engine-selection spike (§8.4); simulate disrupted delivery there and separately test the deployed runtime later.

### Milestone 1: one Agent writes; one user circles; the Agent reads it

Implement protocol envelopes, two replicas, durable assets, local pairing/Agent approval, one LAN path, and thin CLI/MCP handlers for `apply`, `read`, `look`, bounded wait, and Inbox acknowledgement. Start with text, rectangles/connectors, and Ink. Use iPad-rendered images with explicit revision/view transforms; if the iPad is unavailable, return a truthful unavailability result during this internal milestone.

The loop is: Agent places a small dependency graph → user circles one Element → Send persists raw strokes, a crop, and a candidate target ID → Agent receives and acknowledges it → Agent annotates on its own layer. Kill Link after Send, reconnect, and verify pending delivery. This loop exposes more architectural mistakes than a perfect manifest parser.

### Milestone 2: finish the coding-plan-review demo

Add arrows, strikethroughs, nearby writing, voice transcript capture, selection/viewport context, simple geometric anchoring, user-only undo and Agent batch revert. Preserve raw evidence and ambiguity. Exercise simultaneous Agent edits while the user marks a target, and two Agents with independently pending receipts. Verify the complete loop through both surfaces and both target harnesses.

Bring in a minimal Link renderer for the supported Element set now, including portable Ink and math support as it arrives. Share normalized geometry/font assets where practical; disclose fidelity differences. This makes `look` useful while the iPad sleeps without building a general renderer SDK first. A stale cached image is not a successful current `look`.

### Milestone 3: finish the math-tutor demo

Add a LaTeX Element, a writable Region, one built-in “notify Agent” Behavior and Region Send control. Group written work into line-level evidence with stroke IDs and image crops; add text hints opportunistically. Do not make reliable mathematical OCR a prerequisite for grading raw visual work. The Agent adds hints beside specific lines and reverts its own grading batch without altering Ink.

If watch mode is demonstrated, implement one Region-scoped debounce with explicit rate/size budgets and durable delivery behavior. Keep it optional as the product spec allows. A full Panel catalog, A2UI translation, dynamic recipes, general HTML and `exec` are not dependencies of this demo. Store the two scenarios as ordinary fixtures and simple guides initially.

### Milestone 4: prove extension seams with one real counterexample each

Add a non-core Element using the registry and fallback profile, then a second transport. Verify unknown-type preservation on an older client and duplicate delivery over both paths. Only then stabilize their external contribution contracts. Build HTML isolation before shipping arbitrary Embeds. Add the first push adapter after wait/Inbox reliability is already demonstrated, preserving ADR-0002.

Relay/OAuth and web remain later product work, but carry their constraints forward now: full-replica memory, recoverable encrypted storage, Space-level grants, portable Ink, explicit feature profiles, and render-state provenance. Do not defer those protocol decisions simply because their deployment milestone comes later.

## Top 10 concrete changes, ranked

1. **Replace §§2/6/9's package federation with the six-unit structure and vertical milestones above.** Delete the requirement for separate history/query/Send/Panel packages and remove the plugin SDK from the pre-demo critical path.
2. **Specify concurrent semantics before declaring the protocol stable (§§1.2, 3.2, 5.1).** Cover invalid merged props, same-ID creates, cross-endpoint retries, erase lineage, mutable Region policy, and conditional revert with explicit traces.
3. **Move `look`, Regions, the scoped Send Behavior, LaTeX and line-level evidence into the first-two-demo path (§9).** Remove the contradictory Wave 3 “done” / Wave 4 “complete” gates.
4. **Make Send preparation, edit claiming, readiness and acknowledgement an explicit durable state machine (§§3.4, 5.2).** Test two rapid Sends, cancellation, a lost response and restart; distinguish durable availability from harness processing.
5. **Close the marking-time evidence gap (§§3.2, 5.2).** Bind anchors to captured transforms/content state, preserve original evidence after target motion, and never substitute current pixels for historical proof.
6. **Replace fixed runtime/renderer enums with extensible profile IDs and implement true opaque Element preservation (§§3.1–3.2, 3.9, 7).** Demonstrate Android-like registration and an old-client move without rewriting unknown props.
7. **Finish the transport lifecycle contract (§3.3).** Define inbound acceptance, peer authentication handoff, Relay multiplexing, message ordering and backpressure before adding fastest-path scheduling.
8. **Resolve Relay trust and working-set feasibility early (§§5.3, 11.1).** Propose the explicit encrypted-archive ADR amendment, document whole-Space key exposure, and benchmark materialization against Worker memory limits before selecting execution placement.
9. **Shrink §4 to a proven JSON Schema subset and an honest Swift validation budget.** Gate quicktype on adversarial round trips; avoid a general schema compiler, runtime schema compilation assumptions, and duplicate authoritative IDLs.
10. **Replace universal plugin promises with staged contracts and budgets (§§3, 7–8).** Static built-ins first; publish a contract after a second implementation, set history/Send/watch retention limits, and pin researched SDK/engine/renderer versions with measured conformance results.
