# Critique of gpt-sol.md (Claude Opus 5.5)

Overall: the module boundaries are correct and the invariants are excellent. Keep the material on durability, ownership, and anchors (§1.2, §3.4, §5). The rest has two serious problems:

1. It draws far more boundaries than a small team can maintain.
2. It duplicates the hardest logic in two languages.

Both problems can be fixed while keeping every growth axis open.

## 1. Modularity belongs at the growth axes, not between internal services

§2 lists about 30 modules. §6 has about 25 `packages/*` plus about 40 `extensions/*` directories. Many boundaries inside the kernel don't correspond to any growth axis: `semantics`, `space-runtime`, `history`, `scene-query`, `send-assembly`, `inbox`, `delivery`, `render`, `recognition`, and `anchoring` will never have a second implementation. Splitting each into its own package with its own dependency policy is a cost with no matching benefit.

**Rule:** a boundary gets its own package only when (a) contributors will add implementations, or (b) it must run in a different runtime. Everything else is a folder inside `core`, and the dependency checker enforces the folder edges.

Day-one TypeScript packages:

| Package | Contents |
|---|---|
| `protocol` | schemas, generated types, fixtures, spec |
| `sdk` | every plugin contract (Element, Transport, Send Adapter, Recognizer, Format, Recipe, Surface, Engine, Storage, Identity) plus the scaffolding CLI |
| `core` | semantics, space runtime, history, scene query, recognition/anchoring orchestration, Send finalization, Inbox, delivery (all internal folders) |
| `link` | composition only |
| `relay` | domain plus Cloudflare and Node adapters |
| `cli` | MCP and CLI surfaces generated from one capability catalog |
| `web` | the web viewer |

Every growth axis keeps its own package under `extensions/*`. Seven packages instead of 25, and the same seams for contributors.

## 2. The biggest flaw: semantics duplicated in Swift and TypeScript

§2 and §8.1 put validation, Region policy, ownership, history, scene query, recognition, anchoring, and Send assembly in both Swift and TypeScript, then try to keep the two in agreement with trace tests. That doubles the hardest code in the system and creates a permanent source of drift.

Look at who actually needs those semantics:

- **Agents never write from the iPad.** Every Agent write enters through `core`, either in the Link or in a Relay cloud session. Agent-write validation, Region policy, lints, `exec`, recipes, and scene LOD therefore exist **only in TypeScript**.
- **User edits on the iPad** need only the trivial rule: a user may change anything, and owner = user. That's a few lines, not a semantics engine.
- **Send finalization** (grouping, recognizers other than Apple handwriting, anchoring, scene LOD) can run where the Agent is, in `core`. The iPad commits a **raw Send record** containing:
  - the frontier
  - stroke IDs
  - the trigger, viewport, and selection
  - the transcript
  - an Apple handwriting hint
  - **the pixel crops it rendered**, since rendering is the one thing the iPad does best

  `core` turns the raw record into the Send Bundle on the replica that delivers it. The raw record is immutable and fixes the frontier, so finalizing it later is deterministic.

The Swift side then shrinks to: generated protocol types, the CRDT binding, renderers, input capture, Send capture, and transport. **Swift has zero semantic duplication.**

## 3. Third-party Element types on iPad have to be web-rendered

§3.1 admits the App Store forbids downloadable native code, but §3.2 still requires every type to provide a Swift renderer. In practice that means no third-party Element type can reach a stock App Store build. Make the extension path honest:

- **Core types** (Ink, text, LaTeX, shapes, connectors, images, sticky notes, frames, 3D) are first-party. They have native Swift renderers and ship in the app.
- **Contributed types** are **web components**: a manifest, a schema, and a TypeScript/HTML renderer. They run in WKWebView on the iPad and in the DOM on the web viewer. One language, one renderer, and installable at runtime as data. The Embed bridge already provides the needed APIs; give it an anchor-provider hook.
- A contributed type can be promoted to native later without changing its schema.

This also gets rid of the separate `headless` renderer for contributed types: headless rendering means running the same web component in a headless browser.

## 4. Remove the hot-swappable CRDT engine

§3.9 and §7 design the engine as a replaceable port, with an epoch-migration procedure. Make the choice once, after the Wave 0 benchmark, and commit to it. Keep a thin adapter so library calls don't spread through the code, but delete engine profiles as a negotiation dimension, the epoch-migration machinery, and the `loro-spike`/`yrs-spike` packages beyond Wave 0. Changing engines is a one-time migration if it ever happens, not a design axis.

## 5. Other changes

- **Acknowledging Sends.** Make it implicit. The next call from the same Agent acknowledges the previously delivered Send automatically, and the explicit `ack` stays for advanced use. Forcing an LLM to carry acknowledgement tokens around invites mistakes.
- **Plugin execution classes (§3.1).** Ship class 1 (compiled in) and class 3 (Agent content) for v1. Class 2 (sandboxed third-party Node plugins) can wait until someone asks for it. Contributed Element types are covered by §3 above.
- **MCP legacy surface (`mcp-legacy`).** Keep it, because most harnesses are still on initialization-based clients. Make it the *first* surface, not a compatibility afterthought.
- **The §11.1 challenges.** I agree with all five. The decisions I'd make:
  1. The Relay stores an encrypted log and decrypts only under a temporary, scoped grant for a cloud-Agent session. Amend ADR-0001's wording.
  2. Correct ADR-0001: remove "without extra work".
  3. MCP App resources are accepted as Embeds, and their upstream tool calls are denied unless the user explicitly allows that server.
  4. Accept that "every path" depends on the platform.
  5. Only HTML that registers anchors gets semantic anchors.
- **Build map (§9).** It's correct but too broad. The fastest path to scenarios 1–2 that doesn't paint us into a corner:
  1. Protocol schemas, plus the CRDT choice and the Ink benchmark.
  2. `core` with `apply`, `read`, `look`, `wait`, and `inbox`, tested against a fake in-memory iPad.
  3. iPad app: Ink, the native core types, Send capture, and LAN transport.
  4. MCP and CLI surfaces.
  5. Scenarios 1–2 end to end.

  The Relay, the web viewer, and push adapters all come after that.
