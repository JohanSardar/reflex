# Review of `gpt-sol.md`: authors, Agents, and the language seam

Reviewer: Fable · 2026-11-10 · target: [gpt-sol.md](./gpt-sol.md) · section numbers below refer to that file unless prefixed "SPEC".

Scope: the extension author's experience, the Agent's experience, and the Swift/TypeScript seam. A second reviewer covers over-engineering and fact-checking, so I only touch those where they change my conclusions. I did not re-verify gpt-sol's claims about MCP 2026-07-28, WWDC26 or A2UI.

## Verdict

gpt-sol is a careful document about the wrong audience. It spends 795 lines making the *internals* replaceable (CRDT engine, storage, identity, crypto, surfaces) and almost none on the two parties who decide whether Reflex succeeds:

- **The Agent.** There is no `apply` op schema, no Send Bundle JSON, no tool description text, no token budget, and no plan to test any of it against a real model. §8.3 says "Agent model quality is evaluated separately" and then never says where.
- **The extension author.** The headline acceptance test (end of §11) is "an external author can add a fully documented Element type, renderer pair, anchors and formats". Under this design that author writes about two dozen files in two languages and then cannot ship to anyone who installed Reflex from the App Store (§3.1 admits this).

The consistency and durability thinking in §1.2, §3.4 and §5 is good and worth keeping. The plugin system and the dual-language plan need to be redrawn.

---

## 1. Developer and contributor experience

### 1.1 Shipping a new Element type (the §3.2 scatter plot)

Following §3.2 steps 1–8 literally, a third party produces:

| # | Artifact | Notation |
|---|---|---|
| 1 | `reflex.plugin.json` | JSON |
| 2–3 | `props.schema.json`, `anchor.schema.json` | JSON Schema (restricted subset, §4) |
| 4 | merge layout | a CRDT vocabulary that is never defined |
| 5 | migrations | TS, and presumably Swift |
| 6 | docs: summary, topics, examples | Markdown |
| 7 | fixture data | JSON |
| 8–11 | generated props and anchor types, checked in (§4) | TS and Swift |
| 12 | model: geometry, describe, lint | TS |
| 13 | web renderer | TS |
| 14 | iPad renderer, which has its own `geometry()` | Swift |
| 15 | headless renderer or display list | TS |
| 16–17 | anchor provider, twice (`AnchorProvider` and `ElementAnchorProvider`) | TS and Swift |
| 18–20 | CSV import, JSON import, export | TS |
| 21–22 | `package.json`, `Package.swift` | |
| 23+ | fixtures for six contract suites (step 7) | |

The totals:

- **Files:** about two dozen before tests.
- **Languages:** TypeScript, Swift, JSON Schema, plus the merge-layout vocabulary.
- **Toolchains:** Node and Xcode. Xcode means macOS, so a Windows or Linux contributor cannot build or test half their own plugin.
- **Renderers:** three per type (iPad, web, headless).
- **Gates:** manifest validation (§3.1), the packaging validator with eight mandatory facets (§3.2), codegen-diff CI (§4), the dependency policy (§6), six contract suites (§8.2), then a custom iPad build or an App Store release (§3.1, step 8).

Specific problems:

- **Distribution is zero.** §3.1: "Native contributions are linked in a custom build or a subsequent app release." A third-party Element type therefore reaches no ordinary user. The only real route is a pull request into the monorepo, at which point it is first-party code and the manifest, permission, activation and dependency-range machinery bought nothing.
- **Geometry and anchors are written twice by the author.** §3.2 gives `ElementType.geometry` in TS and `IPadElementRenderer.geometry` in Swift, and two anchor protocols. Send assembly runs on the iPad (§5.2 steps 3–4), so the Swift copy is not optional. The author now owns their own cross-language drift problem, with no trace-test harness to catch it.
- **The easy path is one undesigned sentence.** §3.2 says a contributor "need not write native code for a simple type" because of "a shared declarative display-list renderer". That renderer is what 95% of authors would use. It has no schema, no capability list and no example anywhere in the document.
- **Merge layout is expert-only.** Asking a chart author to choose between "scalar fields, nested maps, keyed collections, or collaborative text" (§1.2) is asking them to reason about concurrent edits. Most will pick wrong and nothing will tell them.
- **Eight mandatory facets for a sticker.** "An empty lint list or a generic local-coordinate anchor is valid only when explicitly declared and tested" (§3.2). Declaring and testing an absence is ceremony.

Is it pleasant? No. It is the cost profile of contributing a tldraw `ShapeUtil` multiplied by two languages and three renderers, with no way to publish the result.

### 1.2 Shipping a new Send Adapter (§3.4)

This one is close to fine. One language, two methods (`availability`, `offer`), a clear rule that durability belongs to the Inbox, and a delivery suite to run against (§8.2). Roughly four files: manifest, `index.ts`, `package.json`, tests.

What is missing:

- **No install story.** §3.1 says third-party Link plugins run in "a separate Node process" but the CLI grammar (§3.8, SPEC §12) has no `extensions` group. How does a user add one? Unstated.
- **Most authors need configuration, not code.** The built-in webhook adapter already covers "POST the Send Bundle to my harness". The common case should be `reflex adapters add webhook --url …`, and the document should say so before it describes an SDK.
- **`offered` versus `acknowledged`** (§3.4 `DeliveryOutcome`) is a subtle distinction the author must get right with no worked example. Ship a reference adapter that is 40 lines long and say "copy this".
- **Relay is closed.** "The Relay allows only operator-installed code" (§3.1). Correct for security, but it means no third-party adapter works for cloud Agents on `relay.eilmer.si`. Say it in the author docs.

### 1.3 Shipping a new recipe (§3.7)

A recipe is a parameterised `apply` batch. gpt-sol turns it into:

- an interface with an async `expand()` taking five context services,
- an `inputSchema`, `requirements`, `docs`, a manifest and fixtures (§6: "each with a manifest and fixtures"),
- a plugin execution boundary for executable ones (a separate Node process, §3.1),
- operator-only installation on the Relay.

§3.7 says "prefer declarative templates with parameter substitution" and never defines the template format. §3.1 item 3 lists recipes as *Agent-authored content*, while §3.7 treats them as *installed plugins*. Those are two different trust classes and the document does not pick.

A recipe's real value is as a worked example the Agent can adapt. It should be the cheapest thing in the system to write: one file, no code, no install.

### 1.4 What the extension author kit should look like

**An extension ladder.** Each rung is strictly cheaper than the next, and the first four ship without an app release.

| Rung | What it is | Author writes | Runs where | Ships how |
|---|---|---|---|---|
| 0. Guide | A `read_me` topic | one Markdown file | Link, Relay | drop in a folder |
| 1. Recipe | A parameterised `apply` batch plus a guide | one Markdown file with front matter and a fenced JSON template | everywhere, it is data | drop in a folder, or pass inline |
| 2. Embed template | A reusable HTML Embed with declared anchors | one HTML file plus a small manifest | WKWebView on iPad, iframe on web | npm, or inline from the Agent |
| 3. Declarative Element | Schema plus display-list template | one definition file | the shared kernel | npm; design this later |
| 4. Native Element | Swift and web renderers | a pull request to the monorepo | compiled in | app release |

Rung 2 is where the scatter plot belongs. It is a D3 or Observable Plot page. What it needs from Reflex is an **anchor bridge**, which neither the SPEC's bridge list (SPEC §5) nor gpt-sol defines:

```js
// inside the Embed
reflex.anchors.register({
  // called by Reflex at Send time with a mark's geometry in the Embed's local pixels
  resolve(region) {
    return { kind: "data", rows: ["r17", "r22"], x: [2.1, 3.4], y: [40, 61], label: "2 outliers" };
  },
});
```

This is the honest version of §11.1 challenge 5 ("a controlled Embed can register stable targets"). It makes chart, DOM and lab-plate anchoring a third-party capability with zero Swift, and it covers scenarios 4, 6, 8 and 13.

**One manifest, and usually none.** Rungs 0 and 1 use front matter. Rungs 2 and 3 use a single `reflex.json`:

```json
{
  "name": "scatter-plot",
  "kind": "embed-template",
  "entry": "plot.html",
  "params": "params.schema.json",
  "guide": "GUIDE.md",
  "network": ["cdn.jsdelivr.net"]
}
```

No `api`, `protocol`, `runtimes`, `artifacts[].sha256` or `dependencies` fields for the author to fill in. Tooling writes the hashes and compatibility fields at pack time.

**Scaffolding.**

- `reflex create recipe|guide|embed|adapter <name>` writes a working example that passes its own tests.
- `reflex test` runs the contract suite for that kind.
- `reflex extensions add|list|remove` installs. This also fits ADR-0003's `<group> <action>` grammar.

**A playground, with no iPad and no Xcode.** `reflex dev` opens the web viewer on an in-memory Space with hot reload and three inspector panes:

1. **What the Agent reads.** The exact `read` text and `look` image for the current scene.
2. **What a Send produces.** Draw a circle with the mouse (dev mode only), press Send, see the Send Bundle JSON.
3. **Lints and anchor results**, live.

A "record fixture" button saves the current mark and expected anchor as a conformance fixture. That replaces hand-writing step 7 of §3.2.

**For core contributors:** 23 packages under `packages/`, 45 extension directories and six Swift packages (§6) is a lot of structure for a repository with no code. The other reviewer covers this. My only addition: every package boundary is a place a newcomer must ask "where does this go?", and a dependency-policy file is not an answer.

---

## 2. Agent experience

The Agent is the product's real user. gpt-sol's position is that MCP tools and CLI commands are *generated* from `CapabilityDescriptor` (§3.8). That guarantees parity, which ADR-0003 wants. It also guarantees mediocre tools, because good tool descriptions are prompt engineering tested by evals, not a projection of a schema. Anthropic's guidance is explicit that small description edits have large effects and must be measured ([Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).

### 2.1 What the prior art learned

- **tldraw agent kit.** Three levels of detail (`FocusedShape`, `BlurryShape`, `PeripheralShapeCluster`). Positions are offset so numbers stay small, and rounded. IDs are converted to simple IDs. Every action passes through `sanitizeAction()`, which repairs or drops rather than rejects. It also advises leaving out optional properties "so the agent isn't overloaded" ([Agent starter kit](https://tldraw.dev/starter-kits/agent)).
- **Excalidraw MCP.** Two model-facing tools: `read_me`, then `create_view`. A `checkpointId` means the model never resends the whole scene. A 512 px PNG is pushed back into model context after each render. Its own notes record the cost of taking raw element JSON: "labels need manually computed centered coordinates" ([excalidraw-mcp CLAUDE.md](https://raw.githubusercontent.com/excalidraw/excalidraw-mcp/main/CLAUDE.md)).
- **Figma MCP.** More than 40 tools. Its docs steer Agents to skills to use them well, tell them to call `get_metadata` for an outline before `get_design_context` for detail, and make a general-purpose code tool (`use_figma`) the main write path ([Figma tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts)).
- **tldraw MCP app.** Its blog describes three tools: create, edit, delete. I could not confirm more than that from the post ([tldraw MCP app](https://tldraw.dev/blog/tldraw-mcp-app)).

Lessons that apply directly: keep the tool list short and fixed; outline first, detail on request; repair instead of reject; never make the model compute geometry it can name; give it the picture back without asking; treat code execution as a main path, not an escape hatch.

### 2.2 Where gpt-sol would confuse a model

1. **Acknowledgement tokens (§3.4, §5.2 step 7).** "Return an acknowledgement token and replay the bundle until the next call acknowledges it", with "the shared optional call context" accepting acks on any tool. A model will forget an optional parameter. It then receives the same Send Bundle again, reads it as a new Send, and answers the user twice. This is the most likely real-world failure in the document.
2. **Expiring view handles (§5.1 step 2).** Coordinates are relative to "the most recent `look`" through a handle with an expiry, and a miss returns `stale_view`. The model must then pay for another image to place one sticky note. It also has to hold two coordinate systems in mind.
3. **Open `props` in the tool schema (§4).** "Open contribution collections use an envelope plus `JsonValue` props." So the `apply` input schema for `add` is effectively `props: object`. The model gets no schema for the thing it writes most.
4. **Plugins add tools (§3.1 `capabilities`).** Every installed plugin can change the tool list. That breaks prompt caching and makes Agent behaviour depend on what one user installed. Sorting "deterministically" does not fix it.
5. **Server instructions grow with plugins (§3.2 step 6).** "Registry discovery adds the summary to server instructions." Unbounded always-loaded context.
6. **Namespaced type IDs** such as `org.example.scatter-plot` (§3.1). Long, typo-prone, and they cost tokens on every Element. Built-ins should be `text`, `math`, `shape`, `connector`, `image`, `note`, `frame`.
7. **Internal vocabulary leaks.** `accepted_local`, revision frontiers, incarnations, receipts, engine profiles. `SendBundleView` is named in §3.4 and never defined, so there is no stated line between the stored record and what the model sees.
8. **Sends, watch snapshots and taps are not distinguished.** §5.2 step 8 says watch mode is "a separate trigger" and stops. A model must know whether the user finished their turn or is still writing.
9. **Fan-out with no notice (§3.4).** When ownership is ambiguous every Agent gets the Send. None is told the others did, so all of them answer the same circle.
10. **No provenance in the scene.** SPEC §2 says Agent output is data, not instructions. The scene an Agent reads contains other Agents' text and Embed content, and nothing marks which words are the user's.

### 2.3 The tool list I would ship

Eleven tools, fixed. Plugins add Element types, recipes and guides, never tools.

| Tool | Notes |
|---|---|
| `list_spaces` | Names, unread flag, pending Sends. |
| `open_space` | `{name, create?: true}`. Returns the outline scene and pending Sends, so one call orients the Agent. Replaces `space_create`. |
| `read` | `{space, detail: "outline" \| "full", ids?, near?, region?}`. Text. Outline by default; detail by ID. The Figma pattern. |
| `look` | `{space, ids? \| bounds?}`. One image plus the bounds it covers. |
| `apply` | The op batch. `look: true` returns a crop of what changed in the same result. |
| `exec` | JavaScript whose API is the same ops (`space.add({...})`) plus `find` and layout helpers. One mental model. |
| `wait_for_user` | `{timeout_s, after?, region?, element?}`. `timeout_s: 0` drains the Inbox. |
| `read_me` | `{topic}`. `read_me("index")` lists types, recipes and guides. |
| `recipe` | `{name, params}`. Returns the batch it applied so the Agent can patch it. |
| `request_attention` | |
| `revert` | `{batch? \| last: n}`. |

SPEC §11 also lists `inbox`. I would fold it into `wait_for_user(timeout_s: 0)` on MCP and keep `reflex inbox list` on the CLI for people. That is a small departure from ADR-0003's 1:1 wording: the capability still exists once, but one surface does not expose it. If 1:1 must be literal, keep `inbox` and accept twelve.

Server instructions stay under about 400 tokens: the loop (`open_space` → `apply` → `wait_for_user`, repeat), the ownership rule, and "call `read_me` before using a type you have not used".

### 2.4 The `apply` op shape

Principles:

- Flat. `op` and `type` are the only discriminators. Built-in types have typed, top-level fields. Only plugin types use a `props` object.
- The Agent names things; Reflex computes geometry. Connectors bind by ID. Shapes carry their own `text`. Placement is relative by default.
- IDs are short and Agent-chosen (`n-auth`). Reflex scopes them per Agent, so two Agents cannot collide.
- One coordinate space per Agent and Space, integer, with an origin that does not move. `look` reports the bounds it shows. No handles, no expiry.
- Repair first, warn second, reject last. Rejection is all-or-nothing and reports *every* failing op.

```json
{
  "space": "auth-plan",
  "in_reply_to": "s_12",
  "look": true,
  "ops": [
    { "op": "add", "id": "n-auth", "type": "shape", "shape": "rect",
      "text": "Auth service", "at": { "right_of": "n-gateway", "gap": 80 } },
    { "op": "add", "id": "e1", "type": "connector",
      "from": "n-gateway", "to": "n-auth", "text": "JWT" },
    { "op": "add", "type": "note", "text": "Agreed, merging these.",
      "at": { "near": "m1" } },
    { "op": "add", "type": "math", "latex": "x = \\frac{-b}{2a}",
      "at": { "x": 120, "y": 640 } },
    { "op": "patch", "id": "n-db", "set": { "text": "Postgres", "color": "red" } },
    { "op": "remove", "ids": ["n-cache"] },
    { "op": "arrange", "ids": ["n-a", "n-b", "n-c"], "layout": "row", "gap": 40 },
    { "op": "focus", "ids": ["n-auth"] }
  ]
}
```

Success:

```json
{
  "ok": true,
  "batch": "b_31",
  "ids": { "ops[2]": "note-1" },
  "repaired": ["ops[0]: id 'n-auth' already existed; used 'n-auth-2'"],
  "lints": [
    { "id": "note-1", "code": "overlaps_ink",
      "msg": "Covers the user's Ink m3.", "fix": "Use at: {below: 'm3'}." }
  ],
  "pending_sends": 0
}
```

Failure:

```json
{
  "ok": false,
  "applied": 0,
  "errors": [
    { "op": 1, "code": "unknown_id",
      "msg": "No Element 'n-gatway'. Closest: 'n-gateway'.",
      "fix": "Set from to 'n-gateway'." },
    { "op": 5, "code": "not_yours",
      "msg": "'ink_41' is the user's Ink. Agents cannot remove it.",
      "fix": "Add a note next to it instead." }
  ]
}
```

Notes on the schema itself:

- `at` with a `near`/`right_of`/`below` target is how "the Agent answers next to what the user marked" (SPEC §1) becomes one field. It should accept mark IDs from a Send Bundle, as above.
- Fixed coordinates stay available. That reinterprets SPEC §7 ("coordinates match the most recent `look` image") as "the `look` image is labelled with the coordinates it covers". This is a spec challenge and should be recorded as one.
- Keep the JSON Schema shallow: one level of `oneOf`, no recursive `$ref`. Several harnesses' strict tool modes handle deep unions badly. Verify per harness in the Wave 0 survey that §9 already plans.
- A plugin type that fails validation returns its schema excerpt and one example in the error. That is the fix for problem 3 above without bloating the tool definition.

### 2.5 The Send Bundle shape

The stored Send record (§1.2) and what the model reads are different things. Define the projection. It should read like review comments, put the user's words first, reference raw strokes instead of inlining them, and attach one crop per cluster of marks.

```json
{
  "kind": "send",
  "send": "s_12",
  "space": "auth-plan",
  "trigger": "voice",
  "said": "merge these [m1] [m2] into one service",
  "marks": [
    { "id": "m1", "kind": "circle", "on": ["n-auth"], "image": 1 },
    { "id": "m2", "kind": "arrow", "from": "n-auth", "to": "n-users", "image": 1 },
    { "id": "m3", "kind": "writing", "near": "m2",
      "text_guess": "contradicts", "confidence": 0.71, "image": 2 },
    { "id": "m4", "kind": "strike", "on": ["n-legacy"], "image": 2 },
    { "id": "m5", "kind": "lasso", "on": ["chart-3"],
      "target": { "kind": "data", "rows": ["r17", "r22"], "x": [2.1, 3.4], "y": [40, 61] },
      "image": 3 },
    { "id": "m6", "kind": "ink", "bounds": [900, 300, 140, 90],
      "note": "Not recognised. See image 3.", "image": 3 }
  ],
  "changes": [
    { "kind": "moved", "id": "n-db", "by": [120, 0] },
    { "kind": "removed", "id": "n-cache", "was": "Redis cache" },
    { "kind": "panel", "panel": "p-options", "values": { "priority": "high" } }
  ],
  "scene": [
    { "id": "n-auth", "type": "shape", "text": "Auth service", "by": "you", "bounds": [400, 200, 160, 80] },
    { "id": "n-users", "type": "shape", "text": "User service", "by": "Codex · api", "bounds": [700, 200, 160, 80] }
  ],
  "elsewhere": { "on_screen": 14, "off_screen": 31 },
  "viewport": [300, 100, 1200, 800],
  "images": [
    { "n": 1, "shows": "m1, m2 and their targets", "bounds": [380, 160, 520, 180] },
    { "n": 2, "shows": "m3, m4", "bounds": [600, 320, 300, 160] },
    { "n": 3, "shows": "m5, m6 on chart-3", "bounds": [860, 260, 400, 300] }
  ],
  "also_sent_to": [],
  "redelivered": false,
  "pending_after": 0,
  "next": "Reply with apply(in_reply_to: 's_12'), then call wait_for_user(after: 's_12')."
}
```

Delivered as MCP content: this JSON as one text block, then the images in order, each preceded by its `shows` line, then one low-resolution thumbnail of the Space.

Design choices and why:

- **`said` first, with marks interleaved by time.** "Merge these" is meaningless without knowing which strokes were drawn as the word was spoken. On-device speech recognition gives word timings and strokes have timestamps, so Reflex can place `[m1]` in the transcript. This is the single most valuable thing the bundle can do for scenarios 1, 3, 4 and 13, and gpt-sol does not mention it.
- **A crop per mark cluster.** Current models read handwriting from an image better than a recogniser reports it. `text_guess` is a hint, which is what SPEC §9 already says.
- **Raw strokes by reference.** SPEC §9 says raw strokes are "always kept". Kept does not mean inlined. `read({ids: ["m3"], detail: "strokes"})` returns points for the kanji and sketch scenarios that need them.
- **`by` on every scene Element.** `"you"`, `"user"`, or another Agent's name. It tells the model whose words it is reading.
- **`kind`** is `send`, `watch` or `tap`. A `watch` snapshot carries `"user_still_writing": true`.
- **`also_sent_to` and `redelivered`** address problems 9 and 1.
- **`next`** is the same idea as the CLI's `next` commands in ADR-0003, applied to MCP.
- **Budget:** about 2,000 tokens of text and at most four images by default, with counts and pointers for the rest. Claude Code caps tool results at 25,000 tokens by default ([Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)); a bundle should never be near that.

**Acknowledgement.** Drop `AckToken`. The `send` ID is already scoped by the authenticated Agent. A Send is acknowledged when the Agent passes it as `after` to `wait_for_user`, or as `in_reply_to` to `apply`. If the Agent does neither, it gets the bundle again with `"redelivered": true`, which it can recognise. This keeps §3.4's at-least-once guarantee and works under a stateless MCP transport, where "the next call on this connection" has no meaning. `in_reply_to` also lets the iPad show the user which Send an Agent's batch answers.

### 2.6 Test it

Add a lane to Wave 0 (§9): a small eval harness that runs scenarios 1 and 2 against real models through both MCP and the CLI, replays recorded Send Bundles, and scores the resulting Space (targets hit, no overlap with Ink, no duplicate replies, calls and tokens used). Every change to a tool description, the op schema or the bundle projection reruns it. Without this, §8.3's conformance suite proves the protocol works and says nothing about whether an Agent can use it.

---

## 3. The cross-language seam

### 3.1 What actually sits on the seam

gpt-sol's position (§2 preamble, §6, §8.1, §11.2 last bullet): Swift and TypeScript each implement the semantics, sharing generated types and trace tests. The Swift tree in §6 has `ReflexProtocol`, `ReflexContracts`, `ReflexSemantics` and `ReflexSpaceRuntime`. The data flows add more that must exist on the iPad: the logical-to-CRDT mapping (§1.2), Region policy, Behavior interpretation, undo, scene query, anchoring, Send assembly (§5.2), Element migrations (§7), the sync envelope (§7), and each Element type's geometry and anchors (§3.2).

One clarification gpt-sol never makes: the iPad does *not* need the Agent capability layer. `apply` validation, lints, the catalog, MCP and CLI all run only where Agents connect, on the Link and the Relay. That part is single-language already. What is duplicated is the **Space kernel**: everything that reads or writes a Space on behalf of the user.

### 3.2 The three options

**Option C: duplicate, as proposed.**

- For: no new toolchain; each side is idiomatic; Swift contributors and TS contributors stay in their own world.
- Against:
  - The logical-to-CRDT mapping is the dangerous part. If Swift and TS disagree about how a `props` merge layout maps to CRDT containers, the result is not a wrong lint. It is a malformed document that replicates to every node. Trace tests catch the cases someone wrote down.
  - §11.2 concedes the drift risk and prescribes "common algorithm specifications and dual-runtime trace tests". That is a third artifact, a prose spec, to keep in step with two implementations.
  - Every kernel feature needs a bilingual author or two pull requests. Open-source contributors to an MCP project skew heavily to TypeScript, so the Swift half lags and the iPad, which is the product, becomes the bottleneck.
  - Layout is not reproducible. An Agent's text Element gets its `bounds` (§1.2) from whichever runtime created it, measured with that runtime's fonts. Lints such as "text overlaps Ink" (SPEC §7) are then computed on the Link against bounds the iPad will not reproduce.

**Option B: a TypeScript kernel in JavaScriptCore on the iPad.**

- For: one implementation in the majority language. Third-party Element model code would run on the iPad unchanged. Apple's rules have historically treated JavaScript run by JavaScriptCore differently from downloaded native code, which could even allow shipping it without an app release (verify the current wording of [guideline 2.5.2](https://developer.apple.com/app-store/review/guidelines/) before relying on this).
- Against:
  - In-process JavaScriptCore on iOS has no JIT. Reports put the cost at around 7x, and a WebKit engineer advised Lucid to use WKWebView instead for that reason ([Lucid: JavaScriptCore, 10 months later](https://lucid.co/techblog/2019/01/03/javascriptcore-10-months-later), [Apple forum thread](https://developer.apple.com/forums/thread/746159)). Scene queries and Send assembly over a 100k-stroke Space (§8.4) are exactly the wrong workload for an interpreter.
  - The CRDT engines are Rust. In the browser they run as WASM, but WebKit's own tracker says JSC API clients on iOS never had the JIT that its WASM support depended on ([WebKit bug 265151](https://bugs.webkit.org/show_bug.cgi?id=265151)). I could not confirm whether that has changed. If it has not, the iPad must use the native CRDT through Swift, and the JS kernel reaches it over a chatty bridge on every operation. That bridge is a new seam in the hottest place.
  - A second heap and garbage collector live beside a 120 Hz Pencil loop (§8.4's 8.3 ms budget).
  - Hosting the kernel in a hidden WKWebView gets the JIT back, but the source of truth then lives in a separate process the OS may kill under memory pressure, behind async-only messaging. gpt-sol rejects this in half a sentence (§2 preamble). The conclusion is right; it deserved the argument.

**Option A: one Rust kernel, bound to Swift with UniFFI and to TypeScript as WASM.**

- For:
  - Rust is already in the binary. All three CRDT candidates in §10.1 are Rust cores, and their Swift packages are UniFFI wrappers around them: `loro-swift` says so ([loro-swift](https://github.com/loro-dev/loro-swift)), and gpt-sol's own table describes YSwift as "a Yrs/UniFFI binding". The question is not "should Reflex add a third language" but "should Reflex's own semantics sit next to the CRDT or across an FFI from it".
  - It removes the binding-maturity problem that drives §10.1. The kernel depends on the CRDT *crate* and exports its own narrow API. Reflex stops depending on the API coverage of an "experimental" (`loro-swift`) or "WIP" (YSwift) Swift package, and the CRDT choice can be made on merit.
  - It removes the version-pair problem. §6 warns that "latest Swift binding plus latest npm package is not a compatibility policy" and §8.4 tests engine and FFI versions "as a compatible pair". With one crate there is one version.
  - One implementation of the mapping, policy, migrations, undo and revert planning, scene projection and Send freezing. The trace suite in §8.1 still exists, and it runs once.
  - A bundled text shaper and fonts in the kernel give the Link, the Relay and the iPad the same measured bounds for Agent-authored text, which makes lints mean something.
  - UniFFI is in production in Firefox on mobile and desktop, and its Swift support is described as production quality ([uniffi-rs](https://github.com/mozilla/uniffi-rs), [Swift bindings](https://mozilla.github.io/uniffi-rs/latest/swift/overview.html)). WASM is how Automerge and Loro already ship to Node, browsers and Workers.
- Against:
  - First-party Rust narrows the pool of people who can change the kernel.
  - Three toolchains in CI (cargo, Xcode, Node), an XCFramework to build, and WASM size to watch on Workers.
  - Two binding layers. UniFFI's WASM story is not first-class as far as I could confirm, so the TS side is a thin `wasm-bindgen` facade over the same crate.
  - Debugging across an FFI is worse than debugging one language.
  - It does not help third-party *code*. A plugin cannot contribute Rust.

### 3.3 Pick: Option A, with a narrow, sans-IO kernel

I pick the Rust kernel, on these conditions.

- **Sans-IO.** The kernel is a state machine: events and bytes in, effects and bytes out. No sockets, files, clocks or threads inside. Storage, transports, crypto primitives and rendering stay native on each platform, behind the ports gpt-sol already drew in §3.3 and §3.9.
- **About twenty coarse functions.** `open`, `apply_agent_batch`, `apply_user_intent`, `receive`, `sync_step`, `scene`, `freeze_send`, `plan_revert`, `undo`, `migrate`, `checkpoint`, and a few more. JSON or bytes across the boundary. Nothing crosses per Pencil sample; PencilKit stays native and a stroke enters the kernel once, when it is finished (as §5.2 step 1 already has it).
- **The Agent-facing layer stays in TypeScript.** Tool descriptions, the Send Bundle projection of §2.5, lint wording, MCP, CLI, Send Adapters, recipes. This is where iteration speed matters and where contributors are.
- **Renderers stay per platform.** Swift on the iPad, TS on the web. Optionally the kernel carries a small software renderer for `look` on the Link and the Relay, which would answer §1.1's "Workers cannot be assumed to contain Chromium". LaTeX layout in Rust is an open question, so treat that as a spike, not a plan.
- **Third-party logic is data or an Embed.** The set of native Element types is closed per release. That matches SPEC §5, which lists a fixed native core and puts everything else in Embeds, and it matches the App Store reality §3.1 already concedes. This is the same conclusion as the ladder in §1.4, reached from the other direction.

The cost I am accepting is contributor reach into the kernel. I think that is the right trade: the kernel is the part of Reflex where a subtle bug corrupts users' Spaces, so it should be small, slow-moving and written once. Everything a typical contributor wants to touch is outside it.

**Gate it.** In Wave 0, alongside the engine benchmark §8.4 already plans, build the mapping, `apply_agent_batch` and `scene` in Rust and bind both sides. Measure FFI overhead per call, XCFramework and WASM size, and cold start. If no maintainer will own Rust, fall back to Option C with the seam cut to the minimum: the iPad implements only user intents and Send freezing, and the mapping layer is generated from one declarative table instead of hand-written twice. Option B is my last choice because it moves the seam into the hot path instead of removing it.

---

## 4. What it got most wrong

**It optimised the wrong axis of growth.** The brief was "every axis of growth is a plugin behind a stable interface". gpt-sol read that as "every *component* is replaceable" and produced thirteen contribution kinds (§3.1), including engines, storage, identity and surfaces.

- Nobody outside the core team will write a CRDT engine adapter, and §7 admits that swapping one is "an epoch migration, not a hot swap". That is an internal interface, not a plugin kind.
- Meanwhile Reflex's real axis of growth is stated in SPEC §1: "The Agent brings the domain." Growth means new domains: math tutoring, grading, lab plates, CAD review. A domain is a guide, a recipe, an Embed template and an anchor mapping. Those are rungs 0–2 of the ladder, they need no install on the iPad, and an Agent can supply most of them at run time.
- gpt-sol gives those the least design. Recipes get a code interface instead of a file format. Guides get one clause in a table row (§2, `recipes/*` and `docs`). The Embed bridge gets a hardening paragraph (§11.2) and no anchor API. The declarative renderer gets a sentence.

The consequence is an architecture whose acceptance test (end of §11) is satisfied by an author who cannot ship, and whose most common extension, "teach Agents to use Reflex for my domain", has no documented path.

Two smaller errors that follow from the same blind spot:

- **No agent-facing design at all**, covered in section 2. The capability catalog is treated as plumbing.
- **Uniformity as a goal.** "Built-in Element types use exactly the contracts available to contributors" (§1). That sounds principled and forces Ink, the most performance-sensitive and platform-specific thing in the product, through the same manifest, merge-layout and three-renderer contract as a sticky note. Built-ins should be allowed to be special.

---

## 5. Top 10 changes, ranked

1. **Design the Agent contract by hand and test it with real models in Wave 0.** Write the tool descriptions, the `apply` schema (§2.4 here) and the Send Bundle projection (§2.5 here) as first-class documents. Add an eval harness lane to §9 and replace §8.3's "evaluated separately" with it.
2. **Replace the dual Swift/TS semantics with one sans-IO Rust Space kernel** next to the CRDT crate, bound with UniFFI and WASM. Rewrite §2's preamble, the Swift tree in §6, and §11.2's drift bullet. Gate it with a Wave 0 spike.
3. **Close the native Element set and adopt the extension ladder** (guide, recipe, Embed template, declarative Element, core pull request). Rewrite §3.2's example as an Embed template and change the §11 acceptance test to "an external author ships a new domain without an app release".
4. **Specify the Embed anchor bridge** (`reflex.anchors.register`). It is what makes chart, DOM and plate-map anchoring a third-party capability, and it needs a SPEC §5 amendment.
5. **Make recipes and guides single data files with no code**, loadable from the repository, the user's profile, a project folder, or inline from an Agent. Delete `Recipe.expand()` from §3.7.
6. **Replace acknowledgement tokens with an `after` cursor and `in_reply_to`**, and mark redeliveries. Rewrite §3.4 paragraph 3 and §5.2 step 7.
7. **Give each Agent one stable coordinate space and relative placement (`at: {near, right_of, below}`)**. Remove expiring view handles and `stale_view` from the default path in §5.1 step 2. Record the SPEC §7 reinterpretation as a spec challenge.
8. **Fix the tool list at eleven and stop plugins from adding tools or growing server instructions.** Remove `capabilities` from `PluginManifest.contributes` (§3.1). Type the built-in Elements directly in the `apply` schema instead of `JsonValue` props (§4).
9. **Ship the author kit:** `reflex create`, `reflex test`, `reflex extensions add`, and a `reflex dev` playground on the web viewer with the three inspector panes. No iPad and no Xcode for rungs 0–3.
10. **Cut the manifest to the kinds third parties will use:** guides, recipes, Embed templates, formats, Send Adapters. Engines, storage, identity, crypto and surfaces become ordinary internal interfaces with no manifest, activation or permission machinery.

Also worth doing, below the line: time-align the voice transcript with marks; add `by` provenance to every scene Element; add `also_sent_to` on fan-out; return a crop from `apply` on request; and distinguish `send`, `watch` and `tap` in what `wait_for_user` returns.

---

## Sources

- [tldraw Agent starter kit](https://tldraw.dev/starter-kits/agent)
- [tldraw MCP app blog post](https://tldraw.dev/blog/tldraw-mcp-app)
- [excalidraw-mcp CLAUDE.md](https://raw.githubusercontent.com/excalidraw/excalidraw-mcp/main/CLAUDE.md)
- [Figma MCP server: tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts)
- [Anthropic: Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Lucid: JavaScriptCore, 10 months later](https://lucid.co/techblog/2019/01/03/javascriptcore-10-months-later)
- [Apple developer forum: JavaScriptCore optimization on mobile](https://developer.apple.com/forums/thread/746159)
- [WebKit bug 265151](https://bugs.webkit.org/show_bug.cgi?id=265151)
- [uniffi-rs](https://github.com/mozilla/uniffi-rs) and its [Swift bindings guide](https://mozilla.github.io/uniffi-rs/latest/swift/overview.html)
- [loro-swift](https://github.com/loro-dev/loro-swift)
- [App Store review guidelines](https://developer.apple.com/app-store/review/guidelines/)

Not verified by me: the tldraw MCP app's exact tool names; whether in-process JavaScriptCore on current iPadOS can run WASM; the state of UniFFI's WASM target; how each harness's strict tool-schema mode treats nested unions. Each is flagged where it is used.
