# Reflex: Product Spec

Status: agreed design, v0 (2026-11-10). Vocabulary follows [GLOSSARY.md](../GLOSSARY.md); key decisions are recorded in [docs/adr/](./adr/).

## 1. Goal

Today agents talk to people through one text box. Reflex replaces that box with a **shared spatial surface**: a Pencil-first canvas on iPad that **any** agent harness can connect to, draw on, build on, and read from. The user writes, draws, taps, and speaks back.

Reflex knows nothing about any domain. The Agent brings the domain (math tutoring, code planning, CAD, grading, personal planning) and decides how to use the canvas, based on what the user asks for or its own judgment.

Reflex is **free and open source**, for everybody. There is no moat to protect; the only goal is the best possible product.

### What makes it more than "an MCP server that draws"

1. **Two-way.** Ink, taps, drags, and voice are first-class input the Agent can read.
2. **Spatial.** Where something sits carries meaning. The Agent answers *next to* what the user marked.
3. **Interactive.** Agents place live things (HTML, 3D, graphs, Panels) with Behaviors attached.
4. **Markup-first.** Research across professions shows the bottleneck has moved from producing work to *reviewing and steering what agents produce*. The core gesture is "I mark up what the AI made, right where it is."

## 2. Principles

- **Any harness, day one.** Anything that can call an MCP tool or run a shell command can use Reflex fully. Push to specific harnesses is an add-on (ADR-0002).
- **The user owns their work.** Agents never edit or erase user Ink. Users can erase, move, or delete anything.
- **The user owns their attention.** Agents can ask for it, but can never switch the user's current Space.
- **Ultrafast locally, reachable from anywhere.** Every connection stays live, and each change takes the fastest available one (ADR-0001).
- **One capability model.** MCP and the CLI are two equal interfaces over the same core (ADR-0003).
- **Agent output is data, not instructions.** This applies to text, Embeds, and anything an Agent produces.
- **Open-ended.** Reflex can't predict how Agents and users will use it, so every surface is general rather than built for one use. Any Element can carry the Agent's own data. Embeds run any web code and keep their state. Behaviors combine any trigger with any action. Panels can host Embeds. Agents can save what they invent for every Agent to reuse. A new use needs new data, never a new tool or an app release (ADR-0006).

## 3. System architecture

```
 ┌──────────────┐  peer-to-peer Wi-Fi / Bonjour / USB-C ┌───────────────┐  stdio MCP / CLI  ┌──────────────┐
 │  iPad app    │◀────────────────────────────────────▶│  Reflex Link  │◀─────────────────▶│ local Agents │
 │ (+ web view, │                                       │ (user's comp.)│                   │ Claude Code, │
 │  more iPads) │◀──────────┐                 ┌────────▶│               │                   │ Codex, custom│
 └──────────────┘           │  WebSocket/HTTP │         └───────────────┘                   └──────────────┘
                            ▼                 ▼
                       ┌──────────────────────────┐  remote MCP (OAuth)  ┌──────────────────┐
                       │ Relay (eilmer.si, also   │◀────────────────────▶│ cloud Agents     │
                       │ self-hostable)           │                      │ claude.ai, ChatGPT│
                       └──────────────────────────┘                      └──────────────────┘
```

- **iPad app.** Renders Spaces, captures Ink, voice and touch, and holds a full replica of each Space.
- **Reflex Link.** Started with `npx reflex link` and runs on macOS, Windows, and Linux. It hosts the stdio MCP server, the CLI back end, the Send Adapters, and a replica of each Space, so Agents keep working while the iPad sleeps.
- **Relay.** The official instance runs at `relay.eilmer.si`, and anyone can self-host one. It gives cloud Agents a public, OAuth-protected remote MCP endpoint, and it syncs devices that aren't on the same network.
- **Web viewer.** Runs in a browser, for laptops and Android. Users can view, type, tap, and Send, but there's no Pencil.
- **Sync.** Each Space is a CRDT document replicated on every node (ADR-0001). A transport only carries changes; it never decides what is true. Every available path stays open (peer-to-peer Wi-Fi, LAN, USB-C, Relay) and each change uses the fastest one. Duplicate deliveries are harmless.
- **Not Bluetooth.** BLE is too slow for images. Peer-to-peer Wi-Fi gives a local link without a router.

## 4. Spaces and Agents

- A user has many **Spaces** and switches between them. Several Agents can write into one Space, and an Agent can create its own.
- **Agent identity.** A harness declares a name (for example "Claude Code · reflex repo"). The first time it connects, the user approves it, as with Bluetooth pairing. After that it keeps a stable identity, a color, and its Space permissions across reconnects.
- **Attention.** A new Space created by an Agent appears with a badge. When an Agent writes into a Space the user isn't viewing, that Space gets an unread badge. Agents can call `request_attention`, which shows a banner the user can tap to switch. Agents can never force a switch.
- **Routing Sends.** A Send goes to the Agent that owns the Region or Element involved. If ownership is ambiguous, every Agent attached to the Space gets it.
- **Multiple devices.** Several iPads and web viewers can be on one Space at the same time.

## 5. Content model

The content model has four layers. Every Element has a stable ID, an owner (the user or an Agent), and lives on the owner's layer. Every Element can also carry a free-form `data` map that its Agent defines, such as a task ID, a test case or a score. Reflex stores it, syncs it and returns it in reads and Sends, but never interprets it.

1. **Native core.** These Elements are fast, Pencil-aware, and fully understood by Agents:
   - Ink
   - text and Markdown
   - LaTeX math
   - shapes and connectors
   - images
   - sticky notes
   - frames
2. **Embeds.**
   - **HTML**, a must-have: a sandboxed WKWebView that can run three.js, Mermaid, D3, Excalidraw, live dashboards, or custom code. MCP Apps `ui://` resources are accepted as-is.
   - **3D**: RealityKit with USDZ, and glTF converted on import. Users can rotate a model and grab its parts.
3. **Panels.** Native SwiftUI interface declared as JSON (A2UI-style): sidebars, forms, buttons, choice chips. Tapping an Element to get a detail sidebar opens a Panel. A Panel can also host an Embed, so a sidebar can show anything web code can.
4. **Behaviors and Regions.**
   - **Behaviors** say what happens on interaction. Each one pairs a trigger with an action, and an Element can have several:
     - triggers: tap, long-press, drag end, Ink drawn inside, a Panel value changing, an event from an Embed
     - actions: open a Panel, notify the Agent, Send, set a field, apply a Recipe
     - flags: draggable, locked, snap rules

     The lists are fixed, but their combinations give interactions nobody designed in advance.
   - **Regions** set rules for an area: whether Ink is allowed, whether Agents are read-only, whether watch mode is on, and a scoped Send button.
   - **Space size**: infinite, fixed pages, or a set width.

**Interop.** Reflex imports formats Agents already write well rather than inventing its own:
- **Import:** Mermaid, draw.io XML, Excalidraw JSON, SVG, LaTeX, glTF/USDZ, Markdown. These convert to native Elements where possible and become Embeds otherwise.
- **User imports:** the user can add photos, camera captures, PDFs and other files from the iPad (Photos, Files, the camera, drag and drop). Photos and PDF pages become image Elements the user can write on. Other files become file Elements the Agent can read. New imports travel with the next Send.
- **Export:** PDF, PNG, JSON Canvas.
- **Out of scope for v1:** a live Blender link. Blender's glTF export already covers this.

**HTML Embed sandbox.**
- Each Embed reaches the rest of Reflex only through a small bridge API, which lets it:
  - read its own Element's data
  - save its own state (`reflex.element.setState`), such as a slider value, a game move or a simulation setting. The state syncs to every device, survives reloads, and appears in the next Send's changes.
  - emit "notify agent" events, and events that trigger the Element's Behaviors
  - open Panels
  - **register Anchors** (`reflex.anchors.register({ resolve(region) })`): at Send time, Reflex gives the Embed each Mark's geometry in the Embed's local pixels, and the Embed answers with what that Mark refers to, such as data rows, a DOM node or a plate well. Without that registration, Reflex can only report pixel coordinates within the Embed.
- Network access is limited to a user-editable allowlist. Approved CDNs are allowed by default.
- An Embed can never read other Elements or Spaces.

## 6. Ink, eraser, and undo

The goal is to match Goodnotes.

- **Pens.** Pressure and tilt sensitive, and low latency through PencilKit.
- **Eraser.** A stroke eraser, a precise eraser, and a lasso to erase or select. It can be switched to with Pencil double-tap or squeeze.
- **Undo and redo.** Use the toolbar buttons, a two-finger tap to undo, or a three-finger tap to redo. Undo is linear and covers only **the user's own actions**.
- **Agent changes.** Each Agent's batches can be reverted separately from its color chip ("Revert Claude Code's last change"). A history timeline for each Space shows who did what.
- **User Ink.** Agents never edit user Ink. They annotate on their own layer: margin marks, underlines, hints placed next to the Ink.

## 7. How Agents act on the canvas

- **`apply`** is the main tool. It takes one declarative batch of operations: `add`, `patch`, `remove`, `arrange`, `focus`, `define`. Agents choose the stable IDs. A batch is one undo or revert unit, can be replayed, and syncs cleanly.
- **`exec`** is the power-user escape hatch. It runs JavaScript against a simplified Space API, for things like laying out 40 nodes as a force graph.
- **Coordinates.** Each Agent has one stable integer coordinate space per Space, and every `look` image is labeled with the bounds it covers. Placement is relative by default (`at: {right_of: "n-gateway"}`, `near` a user's Mark), and Reflex computes the geometry. Reflex repairs common model mistakes, such as duplicate or missing IDs, and reports each repair (ADR-0007).
- **Lints.** Every write returns warnings such as "text overlaps Ink" or "arrow endpoint unattached".
- **`look`** returns a rendered image of the Agent's viewport or of given Elements, so the Agent can check its own work.

### Teaching Agents to use Reflex well

- **Server instructions.** A short guide, always loaded.
- **`read_me(topic)`.** Full guides loaded on demand: math tutoring, code maps, 3D, grading, charts, and so on.
- **Recipes.** Ready-made patterns built from the scenarios. For example, `recipe("check-my-work")` places a problem, a writing Region, and a "Check my work" Send button in one call.
- **Agents save what they invent.** An Agent that comes up with a useful pattern or Embed saves it to the user's **Library** with `apply`'s `define` operation. It is checked like any other extension, appears in `read_me("index")` for every Agent in every Space, and the user can rename or delete it.

## 8. What Agents see

Agents receive both an **image and structured data**:

- **Scene, at three levels of detail** (as in tldraw):
  - everything near the user's marks or in focus: full detail
  - everything else on screen: outlines (ID, type, bounds, text)
  - everything off screen: counts per cluster
- **Images.** A sharp crop of each changed area, plus a low-resolution thumbnail of the whole Space.
- **Context.** The user's viewport, their selection, and their recent actions.

## 9. Send: the user talking back

**Triggers.** Every one of these is supported:
- a floating Send button
- Pencil Pro squeeze or double-tap
- hold the mic button and talk; releasing sends the voice and the Ink together
- any Behavior whose action is "notify agent" or "Send"
- a Send button the Agent placed for one Region, such as "Check my work"

**The Send Bundle** reads like a set of review comments:
- **Marks.** Each new group of Ink strokes, anchored to what it refers to. Reflex recognizes the gesture (a circle, a strikethrough, an arrow from A to B, writing next to X), attaches the target Element IDs, and maps the mark into the target's own coordinates: data coordinates on a chart, drawing coordinates on a plan, DOM nodes in HTML. It adds a recognized-text hint with a confidence score. Raw strokes are always kept, because handwriting recognition alone is not reliable.
- **Changes.** Elements the user moved, erased, or edited, anything entered into a Panel, state saved by Embeds, and files the user added.
- **Images and scene** as described in §8.
- **Voice.** A transcript produced on the iPad (see §10).
- **Context.** Which trigger was used, the viewport, and the selection.

**Delivery** (ADR-0002):
1. **`wait_for_user(timeout, filter?)`** is the guaranteed path, and the first one built. It holds the call open with progress keepalives and returns either the Send Bundle or `{status: "still_waiting"}`. The tool description tells the Agent to call it again. Optional filters wait only for a given Region, or for a tap on a given Element.
2. **The Inbox.** Sends never get lost. If no Agent is waiting, they queue in the Inbox. Every Reflex tool result carries a "📥 N pending Sends" notice.
3. **Send Adapters, built after (1) and (2):**
   - Claude Code channels, a true push
   - a webhook or Agent SDK stream, for custom harnesses
   - an MCP App view with `ui/message`, for chat hosts such as Claude and ChatGPT

**Turn model.** Turn-based by default. An Agent can turn on **watch mode** for a single Region, which sends debounced snapshots of only that Region, so cost stays bounded.

## 10. Voice

Voice is transcribed **on the iPad** with Apple's on-device speech recognition. That keeps it fast, private, and free. Only the transcript goes into the Send Bundle.

## 11. MCP tool surface (draft)

There are eleven tools, and the list is fixed: plugins never add tools (ADR-0006).

| Tool | Purpose |
|---|---|
| `list_spaces` | Spaces, with unread flags and pending Sends |
| `open_space` | Open or create a Space; returns the outline scene and pending Sends in one call |
| `read` | The scene: outline by default, full detail for given IDs, raw strokes on request |
| `look` | A rendered image, labeled with the bounds it covers |
| `apply` | A batch of operations; `look: true` also returns a crop of what changed |
| `exec` | JavaScript against the same operations, plus `find` and layout helpers |
| `wait_for_user` | Block until a Send arrives; `timeout_s: 0` drains the Inbox |
| `read_me` | On-demand guides; `read_me("index")` lists types, recipes and guides |
| `recipe` | Apply a ready-made pattern; returns the batch so the Agent can adjust it |
| `request_attention` | Ask the user to switch to a Space |
| `revert` | Undo this Agent's own batches |

Every capability exists exactly once in the core. MCP exposes the Inbox through `wait_for_user(timeout_s: 0)`, and the CLI also keeps `reflex inbox list` for people. A Send counts as acknowledged when the Agent passes its ID as `after` to `wait_for_user` or as `in_reply_to` to `apply`. Until then it is redelivered, marked `redelivered: true`.

## 12. CLI

The CLI follows https://vercel.com/design/cli (ADR-0003). It is a full Agent interface and also the human setup tool.

- **Workflows (top level):**
  - `reflex link`: start the Link and show a pairing QR code
  - `reflex login`
  - `reflex status`
- **Groups:**
  - `reflex spaces list|create`
  - `reflex elements apply|read`
  - `reflex look`
  - `reflex wait`
  - `reflex inbox list`
  - `reflex docs read`
  - `reflex recipes list|apply`
  - `reflex agents list|approve|revoke`
  - `reflex extensions add|list|remove`
- **Author kit:**
  - `reflex create guide|recipe|embed|adapter <name>`
  - `reflex test`
  - `reflex dev`: a playground in the web viewer that shows what the Agent reads, what a Send produces, and live lints and Anchors; it needs no iPad and no Xcode
- **Contract:**
  - stdout carries only the answer.
  - `--json` prints exactly one document.
  - On failure, stderr gets one single-line JSON error with a stable `reason` and `next` commands.
  - Exit codes: 0 for success, 1 for operational failure, 2 for usage errors, 130 for cancel.
  - Waits are bounded with `--timeout`.
  - Consent tiers apply.
  - Help works offline.

## 13. Security and privacy

- **Pairing.** Scanning a QR code exchanges keys between the iPad and the Link. After that, Bonjour rediscovers the Link automatically.
- **Approval.** The user approves every new Agent the first time it connects.
- **Encryption.** The Relay stores an encrypted log and passes along encrypted updates it cannot read. It decrypts a Space only under a scoped, expiring grant that the user gives a cloud Agent session (ADR-0004). The E2E guarantee covers storage and device-to-device traffic; cloud Agents necessarily see the Spaces they're granted.
- **Remote MCP** uses OAuth, which claude.ai connectors require.
- **Embeds** are sandboxed (see §5).

## 14. Open protocol

The **Reflex Protocol** is a versioned, documented spec covering Elements, operations, Send Bundles, Agent identity, and transports, with conformance tests. Anyone can use it to build clients (Android, Vision Pro, others) or new Send Adapters. The scenario suite doubles as the conformance suite.

## 15. Tech stack and repo layout

- **Space kernel:** Rust, sans-IO, built next to the CRDT crate. It binds to Swift through UniFFI and to TypeScript through WASM (ADR-0005).
- **iPad:** Swift, PencilKit, RealityKit, WKWebView, SwiftUI.
- **Agent layer, Link, CLI, MCP, Relay, web viewer:** TypeScript. The Relay runs on Cloudflare Workers with Durable Objects, or self-hosted on Node.
- **CRDT:** Automerge. Loro is the fallback, used only if Automerge visibly fails while building and using the kernel.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

The repository layout is defined in [ARCHITECTURE.md §10](./ARCHITECTURE.md).

## 16. Scenario suite (acceptance + conformance)

Built in this order. The first five are the initial proof.

1. **Coding plan / architecture review.** The Agent lays out the plan as a dependency graph. The user circles a task, draws an arrow to another, writes "contradicts", strikes out a file, and says "merge these services". The marks come back anchored to node IDs.
2. **Math / physics tutor.** A LaTeX problem with a writable Region and a "Check my work" button. Grading goes step by step: margin marks at the exact line, distinguishing a sign error from a gap in understanding. Hints sit next to the Ink, and watch mode is optional.
3. **CAD / 3D.** A USDZ model next to its feature tree. The user moves parts, redlines a pocket ("offset 10 mm from outline"), and sketches a dimensioned rib.
4. **Chart markup.** A grid of exploratory charts. The user lassoes outliers and asks "what are these?", crosses out charts, and draws the expected trend. Marks map to data coordinates.
5. **Teacher grading.** A scanned paper with the AI's proposed marks as an overlay. The teacher taps to accept a mark, or strikes it out and writes their own. Scores and feedback come back against the rubric.
6. **UI / HTML prototype markup.** The user draws on a live prototype. Marks anchor to DOM nodes.
7. **Writing / paper markup.** Bracketed passages and margin notes. The Agent changes only what was marked.
8. **Morning experiment review.** Loss curves, an ablation table, and the Agent's claims. The user circles a suspicious cliff, then ticks or kills queued runs.
9. **Kanji / hanzi practice.** Guide boxes, feedback on stroke order and proportion.
10. **Sketch critique.** Corrections on a separate overlay the user can toggle; the original is never touched. Ends with one drill.
11. **3D anatomy learning.** Rotate a heart, label its vessels with the Pencil, take a quiz.
12. **Weekly planning / journal.** Drag time blocks, journal by hand. The Agent updates the calendar.
13. **Lab plate map.** Tap wells, say "row C contaminated". The notebook entry comes back.

These were judged weaker and are not in the suite: legal redlines, incident response, PCB routing, therapy worksheets.

## 17. Build order

Development proceeds in vertical steps, defined in [ARCHITECTURE.md §12](./ARCHITECTURE.md) and broken into tickets in [TICKETS.md](./TICKETS.md). Each piece is proven by using it for real, in the iPad Simulator or a real harness. There are no separate benchmark, eval or test-only phases.

1. The protocol, the Rust kernel and the iPad canvas, in parallel.
2. The Agent layer and the Link.
3. One round trip: an Agent writes, the user circles, the Agent reads the circle.
4. The coding plan review, the Relay, the web viewer and author kit, and a second transport.
5. The math tutor, deploying the Relay, and Claude Code channel push.
6. The chart Embed, and the remaining push Send Adapters.
7. 3D.
8. The remaining scenarios.
9. Reflex Protocol v1.

## 18. Open items

- How to recognize mark gestures (circle, strikethrough, arrow): heuristics, an on-device model, or a mix.
- The exact behavior of `wait_for_user` keepalives under each harness's tool timeout. Recorded from one real run in each harness while building the Agent layer.
- Whether the MCP App adapter can render a live Space view inside chat hosts, or only a read-only one.
