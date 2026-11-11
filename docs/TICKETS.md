# Reflex tickets

The build is split into 22 tickets, one agent each. [ticket-map.html](./ticket-map.html) shows which can run at the same time. Steps and their outcomes are summarized in [ARCHITECTURE.md §12](./ARCHITECTURE.md).

Every ticket is proven by using the real thing: the app in the iPad Simulator, a real Claude Code or Codex session, or the real CLI. No ticket builds benchmarks, eval harnesses or test suites.

## All tickets

There are 55 work items (H1–H55), and each one is in exactly one ticket.

| Ticket | What's in it | Can start |
|---|---|---|
| T1 Protocol v0 | H9 schemas for every message, including `data`, Behaviors, `define`, Embed state and added files, with a few correct examples · H10 hand-written tool text and server instructions · H51 owners as people or Agents, and `from` on every Send | Now |
| T2 Kernel | H5 Element types · H6 `apply`, `scene`, `freeze_send` · H7 Swift and WASM bindings, with a stop-and-report if they don't work or the copies don't converge · H8 Automerge mapping · H43 the `data` map on every Element · H52 person IDs on every owner and undo per person | Now |
| T3 iPad canvas | H1 PencilKit Ink, Goodnotes-style eraser and undo, reload, stable IDs · H2 minimum iPadOS · H3 drawing Elements · H4 Send button | Now |
| T4 Agent layer | H11 `open_space`, `apply`, `read`, `look`, `wait_for_user` over MCP and the CLI · H12 one real wait in Claude Code and one in Codex, recording each one's timeout and MCP version | After T1, T2 |
| T5 Link | H13 journal, LAN, pairing, approval | After T2 |
| T6 Round trip | H14 connect the iPad, Link and Agent; the Agent draws, you circle, the Agent replies; kill the Link once after a Send | After T3, T4, T5 |
| T7 Plan review iPad | H15 arrow, strikethrough and writing Marks · H16 voice · H17 undo UI · H44 Behavior triggers (tap, long-press, drag end, Ink inside, Panel change) · H46 adding photos, camera captures, PDFs and files | After T6 |
| T8 Plan review core | H18 Mark grouping and Anchors · H19 transcript interleaved with Marks · H20 revert · H21 `look` without the iPad · H22 CLI parity · H45 Behavior actions (open Panel, notify, Send, set, apply Recipe) · H47 added files in the Send Bundle | After T6 |
| T9 Relay | H23 encrypted log, OAuth, grants · H24 run a real Space in a Durable Object · H25 self-hosted Node Relay | After T6 |
| T10 Web + author kit | H26 web viewer · H27 `reflex create/test/dev` · H50 `define` and the Library | After T6 |
| T11 Peer-to-peer | H28 Apple peer-to-peer Wi-Fi, including the same change arriving over two paths | After T6 |
| T12 Math tutor iPad | H29 LaTeX on iPad · H30 Region and Region Send button | After T7 |
| T13 Math tutor core | H31 Regions, line-level evidence, grading Recipe and Guide, watch mode | After T8 |
| T14 Deploy Relay | H32 relay.eilmer.si | After T9 |
| T15 Claude channel | H33 push, then pull out the shared adapter contract | After T8 |
| T16 Chart Embed | H34 chart Embed Template and anchor bridge · H35 HTML sandbox hardening · H36 an old app keeps an Element type it doesn't know · H48 `setState` and `emit` on the bridge · H49 Embeds inside Panels | After T10, T12 |
| T17 Webhook, MCP App | H37 webhook adapter · H38 MCP App adapter | After T14, T15 |
| T18 3D Embed | H39 RealityKit, glTF/USDZ part maps | After T16 |
| T19 Scenarios 3–5 | H40 CAD, chart and grading Recipes | After T18, T13 |
| T20 Scenarios 6–13 | H41 the remaining Recipes and Guides | After T18 |
| T22 Shared Spaces | H53 invites, roles and membership checks · H54 Space key sharing and rotation on removal · H55 live presence, and each person's Sends carrying only their Marks | After T17 and T12 |
| T21 Protocol v1 | H42 publish the protocol and conformance profiles | Last |

Tickets for later steps are written when their step is next, so they can build on what earlier tickets found.

## Step 1 tickets

```md
# Protocol v0: the shapes and words every Agent sees

## Goal
Write the first version of Reflex's public contract: the JSON Schemas for every message, and the hand-written text every Agent reads. When this is done, `protocol/` holds:
- schemas for `apply` and its operations (`add`, `patch`, `remove`, `arrange`, `focus`, `define`) and its results
- schemas for errors with `fix` hints
- schemas for the Send Bundle
- schemas for the other tools' inputs and outputs
- owners as principals: a person or an Agent, each with a stable ID, and `from` on every Send naming the person who sent it
- one correct, hand-written example for each message type

Next to them sit the descriptions of the eleven tools and server instructions of about 400 tokens or fewer, all written by hand.

Everything else in Reflex builds on these shapes, and the Agent is Reflex's real user. The shapes must also leave room for uses nobody designed: every Element has a free `data` map, Behaviors pair a trigger with an action, `define` saves an Agent's Recipe or Embed Template to the Library, and the Send Bundle carries Embed state and files the user added. Owners are people or Agents from the start, so shared Spaces can come later without migrating anyone's Spaces (ADR-0008).

## Context
- Read docs/ARCHITECTURE.md §4 (the Agent contract, with example `apply` and Send Bundle JSON), §5 (the Embed bridge) and §9 (schema rules); docs/SPEC.md §2, §4, §5, §7, §9 and §11; docs/adr/0003, 0006 (including its amendment), 0007 and 0008; and docs/architecture/review-fable.md §2, the source of the tool list, the op and Bundle shapes, and ten ways models get confused.
- The user decided:
  - The eleven tools are fixed, and plugins never add tools.
  - The Inbox is reached through `wait_for_user(timeout_s: 0)`.
  - A Send is acknowledged through `after` or `in_reply_to`, with `redelivered: true` on resends.
  - Each Agent has one stable coordinate space, and placement is relative by default.
  - Built-in Element types have typed, top-level fields.
- Schema rules from ARCHITECTURE §9: JSON Schema 2020-12 in a restricted subset; one level of `oneOf`, because some harnesses' strict modes handle deep unions badly; patches are explicit operations; integers stay in the shared safe range; text ranges are UTF-16.
- T2 (the Rust kernel) runs at the same time and generates its types from these schemas once they land. T3 (the iPad canvas) draws from scene JSON in these shapes.
- T4 builds the MCP and CLI surfaces on this text and runs it in real Claude Code and Codex sessions. That run is how the text gets proven.

## Constraints
- The tool list is exactly the eleven tools in SPEC §11.
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

```md
# Kernel: the Rust core that owns every Space

## Goal
Build the Rust Space kernel and bind it to both Swift and TypeScript. When this is done:
- The kernel crate maps Reflex's Elements onto Automerge.
- It covers the Element envelope (ID, owner, layer, the free `data` map), Ink, text, shapes and connectors.
- Every owner is a person or an Agent with a stable ID, and undo covers one person's own actions across all their devices (ADR-0008).
- It applies `apply_agent_batch`, projects `scene`, and freezes a Send with `freeze_send`.
- Swift calls it through UniFFI in an app running in the iPad Simulator.
- TypeScript calls it through WASM, in Node and in Cloudflare Workers.

A Swift copy and a TypeScript copy of the same Space must still agree after edits made to both at the same time, including create, patch and delete, and after one restart.

If the bindings don't work, or the copies don't converge, stop and report what failed. ADR-0005's fallback then applies. That go/no-go is the point of building the kernel first: a disagreement here would be a malformed document copied to every device.

## Context
- Read docs/adr/0001, 0004, 0005 and 0008; docs/ARCHITECTURE.md §3 (the kernel API and guarantees), §7 (correctness rules), §9, §11 and §13; and docs/architecture/gpt-sol.md §1.2 for the data model.
- The kernel is sans-IO. Events and bytes go in; new state, effects and bytes come out. It contains no sockets, files, clocks or threads, and callers inject time and random seeds.
- The engine is Automerge. Loro is the fallback only if Automerge visibly fails while you build and use the kernel.
- Pencil samples never cross into the kernel. A finished stroke crosses once.
- The Library (saved Recipes and Embed Templates) is an ordinary Space of kind `library`.
- Cloudflare Workers cap memory at 128 MB per isolate, including WASM.
- T1 is writing the protocol schemas at the same time. Use stand-in types for Element data until they land, then generate from them. T3 is building the iPad canvas at the same time.

## Constraints
- The kernel crate does no IO.
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

```md
# iPad canvas: Ink, eraser, undo and drawing Elements

## Goal
Build the first real version of the Reflex iPad app's canvas. When this is done, the app runs in the iPad Simulator. You can:
- draw Ink with PencilKit
- erase with a stroke eraser, a precise eraser and a lasso
- undo and redo with the toolbar, a two-finger tap and a three-finger tap
- close and reopen the app with every stroke intact

Every stroke, and every fragment left after a partial erase, keeps a stable ID through all of that. The canvas also draws Elements (text, shapes, connectors, images) from scene JSON, and has a floating Send button.

Ink is how users talk to Reflex. Every Mark, Send and Anchor is built on stroke identity, so this has to be right before anything builds on it. The ticket also settles the minimum iPadOS version.

## Context
- Read docs/SPEC.md §5 and §6 (Ink, eraser and undo); docs/ARCHITECTURE.md §3, §7.5, §8.2 and §13 (the Ink row); and docs/architecture/gpt-sol.md §1.2 and §10.2.
- The user decided:
  - The eraser and undo work like Goodnotes. Pencil double-tap or squeeze switches to the eraser.
  - Undo covers only that person's own actions.
  - Agents never edit or erase user Ink.
- From the architecture:
  - A precise erase records new fragments or a mask that point back to the parent stroke, not a rewrite of the whole drawing.
  - Reflex keeps a native PencilKit archive for fidelity, plus a portable stroke form for the web viewer, export, and the Agent's `read(detail: "strokes")`.
  - PencilKit is never re-serialized when Agent content changes.
- Apple's WWDC26 session "Read between the strokes with PencilKit" (https://developer.apple.com/videos/play/wwdc2026/203/) describes stable stroke and path IDs, on-device handwriting recognition, programmatic erase and substroke extraction. The minimum iPadOS is whatever those APIs require.
- Use the Xcode iPad Simulator through T3 Code's device tools, so the user can watch in the Device panel. The user has an Apple Developer account. A real Pencil pass (pressure, tilt, squeeze) comes later and is not part of this ticket.
- T1 is writing the scene JSON shapes and T2 is building the kernel at the same time. Draw from stand-in scene JSON until T1's examples land. Connecting to the kernel happens in T6.

## Constraints
- PencilKit is the Ink engine. Report anything that blocks it; don't build an alternative.
- The app lives in apps/ipad/, laid out as in ARCHITECTURE §10.
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

## Step 2 tickets

```md
# Agent layer: the MCP server and CLI that Agents use

## Goal
Build the TypeScript Agent layer, the part of Reflex every Agent talks to. When this is done, a real Claude Code session and a real Codex session can each connect to Reflex, through MCP and through the CLI, and use `open_space`, `apply`, `read`, `look` and `wait_for_user` against a real Space held by the Rust kernel (through its WASM build). The kernel accepts exactly the shapes in `protocol/`: its Rust op and scene types are generated from `protocol/schema`, so T1's `apply` example goes through it. `protocol/` is part of the root npm workspace.

You also record what each harness actually does with a long-held `wait_for_user` call, from one real run in each: the default tool timeout and how to change it, whether progress notifications extend it, what cancelling does, what happens when the pipe closes mid-wait, and which MCP version or binding it speaks. Write that down in docs/harness-notes.md. It decides the timeout policy and which MCP binding ships first.

This is the first time an Agent touches a real Space. Everything after it (the round trip, every scenario, every push adapter) is built on this layer.

## Context
- Read docs/ARCHITECTURE.md §1, §2, §4 (the Agent contract), §6 (Send delivery), §8.1, §9, §10 and §11 (the MCP row); docs/SPEC.md §7–§9, §11 and §12 (the CLI, following https://vercel.com/design/cli); docs/adr/0002, 0003 and 0007; protocol/ (schemas, examples, tool text, `pnpm check`); and kernel/README.md.
- What exists on main: `protocol/` (T1: schemas, 31 examples, hand-written tool text and server instructions), `kernel/` (T2: Rust kernel on Automerge, UniFFI and WASM bindings, convergence proven), and `apps/ipad/` (T3).
- T2's kernel still parses its own stand-in op shapes. T1's `apply` example is rejected because T1 sends `map_put`/`text_insert` as lists with a `field` and adds `behaviors`, `math` and `embed`. Generating the Rust types from `protocol/schema` changes op parsing and scene output, not how Elements map onto Automerge.
- `protocol/` has its own `package.json` and pnpm lockfile; the root uses npm workspaces.
- T1's worker measured the bundled `apply` input schema at about 26 KB (roughly 6,500 tokens) sent with every request. See what the harnesses do with it.
- T5 (the Link) runs at the same time and owns `link/`: durable storage, the Inbox journal, LAN sync and pairing. Until T6 joins the two, run the Agent layer from a small entry point with an in-memory Space and Inbox. Keep storage and transport behind the interfaces in ARCHITECTURE §6 so T6 can plug T5's in.
- `look` goes through a renderer interface. A basic scene-to-image renderer is enough here; the full headless renderer is T8.
- Claude Code and Codex are both installed on this machine.

## Constraints
- The tool list is exactly the eleven tools in SPEC §11, with the text from `protocol/tool-text/`. This ticket implements five of them; the rest can return a clear "not yet available" error.
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

```md
# Link: the companion process that keeps Spaces safe and in sync

## Goal
Build Reflex Link, the process on the user's computer that keeps a copy of every Space, stores it durably, and syncs it with other devices over the local network. When this is done, `npx reflex link` (or the repo's equivalent while unpublished) starts the Link. It:
- keeps each Space in a durable journal plus a content-addressed asset store, using the Rust kernel through WASM
- keeps a durable Inbox index, so a Send that arrives is never lost
- finds peers with Bonjour and syncs Spaces with them over LAN/TCP, through the kernel's `sync_step`
- pairs a new device by showing a QR code that exchanges keys, and binds a connection to a device only after it proves its key
- asks the user to approve each new Agent the first time it connects, and remembers the decision in a credential store

Two Links (or a Link and a second peer process) on this machine must pair, sync a Space both ways, keep syncing after edits made on both sides at the same time, and come back intact after one of them is killed and restarted.

The Link is what lets local Agents and the iPad meet. The round trip (T6) joins it with the Agent layer and the iPad app.

## Context
- Read docs/ARCHITECTURE.md §1, §2 (the `link` unit), §6 (transport, storage, identity), §7 (correctness rules, especially the Send state machine and retention), §8 and §10; docs/SPEC.md §3, §4 and §13; docs/adr/0001, 0004, 0005 and 0008; and kernel/README.md.
- What exists on main: `protocol/` (T1), `kernel/` (T2: Rust kernel with WASM bindings; convergence and restart were proven across Swift, Node and Workers), and `apps/ipad/` (T3).
- T2 noted the kernel does not yet check authorization on changes it receives, and the WASM build is 3.0 MB.
- Every owner is a person or an Agent with a stable ID (ADR-0008). Devices are bound to a person.
- Fastest-path selection waits until a second real transport exists (T11). Build LAN/Bonjour first, behind the transport interface in ARCHITECTURE §6.
- T4 (the Agent layer) runs at the same time and owns `agent/`. Don't build MCP or CLI tools here; T6 plugs the Agent layer into the Link. Both of you add workspaces to the root `package.json`; whoever merges second rebases.
- The iPad's side of pairing and sync is T6.

## Constraints
- Use the kernel for every Space operation; the Link never edits Space data itself.
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

## Step 3 ticket

```md
# Round trip: an Agent draws, you circle, the Agent answers

## Goal
Join the iPad app, the Link and the Agent layer into the first real Reflex round trip. When this is done:
- `reflex link` (from the repo; publishing comes later) starts the Link with the Agent layer inside it. A harness connects through `reflex mcp` or the CLI to the running Link, so Agents read and write the Link's durable Spaces and Inbox instead of T4's in-memory ones.
- The iPad app pairs with the Link (scanning the QR code, or typing the code where there is no camera, such as the Simulator), syncs Spaces with it over the local network, and talks to the Rust kernel through T2's Swift bindings.
- The iPad draws Elements from the real Space in the Protocol v0 Element format, replacing T3's stand-in scene JSON, and shows Agent changes live as they sync.
- When the person presses Send, the iPad freezes the Send in the kernel with its stroke IDs, viewport and the crops it rendered, and syncs it to the Link. The Link groups the strokes into Marks and finds what a circle encloses. A waiting `wait_for_user` call is released with a Send Bundle that names the circled Element's ID and includes the crop.

Prove the whole loop with a real Claude Code session and the app in the iPad Simulator: the Agent draws a small graph, you circle one node and press Send, the Agent gets the Mark with that node's ID and a crop, and it answers on its own layer next to the circle, which you then see on the iPad. Then press Send once more and kill the Link right after; when the Link restarts, that Send is still delivered.

This is the first time the whole product works end to end. Every scenario after it builds on this loop.

## Context
- Read docs/ARCHITECTURE.md §1–§4, §6, §7 (especially the Send state machine and marking-time evidence) and §8.1–§8.2; docs/SPEC.md §3, §5, §8, §9 and §13; docs/adr/0002 and 0008; docs/harness-notes.md; and the READMEs in agent/, link/, kernel/ and apps/ipad/.
- What exists on main:
  - `protocol/` (T1): schemas, examples and tool text.
  - `kernel/` (T2): Rust kernel on Automerge with Swift (UniFFI) and WASM bindings. `freeze_send` exists; Mark grouping and Anchor resolution don't yet.
  - `apps/ipad/` (T3): PencilKit Ink with stable stroke IDs, Goodnotes-style eraser and undo, an Element renderer on stand-in scene JSON, and a Send button. It targets iPadOS 26.
  - `agent/` (T4): MCP and CLI surfaces for `open_space`, `apply`, `read`, `look` and `wait_for_user`, running on an in-memory Space and Inbox behind storage interfaces. Codex cuts MCP calls at 300 s, so waits are held for at most 280 s there.
  - `link/` (T5): durable SQLite journal and Inbox, LAN sync over Bonjour and TCP, QR pairing with encrypted connections, Agent approval. Its `dev` subcommands stand in for the iPad and an Agent.
- Carried over from earlier tickets (docs/TICKETS.md, "Follow-ups"):
  - The kernel doesn't check authorization on changes it receives from peers, so a paired device is trusted for everything it sends. Check owners and roles on received changes at the writer's frontier (ARCHITECTURE §7.2).
  - `link/`'s `admin.key` is readable by the user's account, so a local Agent with shell access could read it and approve itself. Close that.
- A circle around one Element is enough Mark recognition here. Arrows, strikethrough and writing come in T7 and T8.
- Drive the Simulator with T3 Code's device tools so the user can watch. Claude Code is installed on this machine.

## Constraints
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

## Step 4 tickets

```md
# Plan review on the iPad: arrows, strikethrough, writing, voice and Behaviors

## Goal
Make the iPad capture everything scenario 1 (the coding plan review in SPEC §16) needs from the person, and show everything Agents and other devices put in the Space. When this is done, on the iPad:
- Arrows, strikethroughs and handwriting next to an Element are captured with the stroke evidence and Apple's on-device handwriting hint that the Link needs to recognize them.
- Holding the mic button records speech, transcribed on the iPad with on-device recognition and word timings; releasing it sends the voice and the Ink together.
- Each Agent has a color chip that reverts its last change, and each Space has a history timeline showing who did what.
- Behavior triggers fire from the iPad: tap, long-press, drag end, Ink drawn inside, and a Panel value changing.
- The person can add photos, camera captures, PDFs and files (Photos, Files, the camera, drag and drop). Photos and PDF pages become image Elements the person can write on; other files become file Elements.
- Ink drawn on other devices is drawn on this iPad too (T6 only drew the iPad's own Ink).

## Context
- Read docs/SPEC.md §5, §6, §9, §10 and §16 (scenario 1); docs/ARCHITECTURE.md §4.3, §7.5 and §8.2; docs/adr/0006 (its amendment) and 0008.
- What exists on main: `protocol/` (T1), `kernel/` (T2), `apps/ipad/` (T3), `agent/` (T4), `link/` (T5) and the working round trip (T6): an Agent draws, the person circles an Element on the iPad and presses Send, and the Agent gets the circled Element's ID and a crop. Read the READMEs in each folder and docs/harness-notes.md.
- T8 runs at the same time and owns the Link and Agent side: recognizing these Marks, the interleaved transcript in the Send Bundle, revert, Behavior actions and added files in the Bundle. You own `apps/ipad/`. Agree on shapes through `protocol/`.
- Scenario 1 must work end to end once both T7 and T8 land; prove your half by running the real app against a real `reflex link`.
- Drive the Simulator with T3 Code's device tools so the user can watch. A real iPad (iPad13,6, paired) is connected over USB; use it for anything the Simulator can't show, such as the microphone or the camera. T6 added a debug-only `reflex://debug/ellipse` link because the automation tool only drags in straight lines; use debug links only for stroke shapes the tool can't draw, and say so.

## Constraints
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

```md
# Plan review core: Marks, transcript, revert, headless look and CLI parity

## Goal
Make scenario 1 (the coding plan review in SPEC §16) work end to end for Agents, in Claude Code and Codex, through both MCP and the CLI. When this is done:
- The Link groups strokes into Marks and resolves their Anchors: circles, arrows from one Element to another, strikethroughs, and writing next to an Element with its recognized text and confidence.
- The Send Bundle interleaves the voice transcript with the Marks it refers to ("merge these [m1] [m2]"), as in ARCHITECTURE §4.3.
- `revert` undoes an Agent's own batches through the kernel's revert planning.
- `look` works without the iPad: the Link renders the Space headlessly.
- Every capability is reachable from the CLI as well as MCP, including `read_me` and `recipe`, so all eleven tools work.
- Behavior actions run: open a Panel, notify, Send, set a field, apply a Recipe.
- Files the person added appear in the Send Bundle (photos and PDF pages as images, other files by reference, read with `read`).

## Context
- Read docs/SPEC.md §7–§9, §11, §12 and §16; docs/ARCHITECTURE.md §3, §4, §5, §7 and §8; docs/adr/0003, 0006 and 0007.
- What exists on main: `protocol/` (T1), `kernel/` (T2), `apps/ipad/` (T3), `agent/` (T4), `link/` (T5) and the working round trip (T6): an Agent draws, the person circles an Element on the iPad and presses Send, and the Agent gets the circled Element's ID and a crop. Read the READMEs in each folder and docs/harness-notes.md.
- Carried over (docs/TICKETS.md, "Follow-ups"): T4's open review items S3, S5, S7 and S8; `read_me` and `recipe` aren't built though the server instructions point Agents at `read_me`; the CLI's image `file` path has no schema field; Agent Element IDs show as `agent:id`; T2's kernel follow-ups (the digest skips Send contents, connector moves do nothing, two undo/redo edge cases); and from T6, an Agent turned away isn't throttled when it keeps asking.
- T7 runs at the same time and owns `apps/ipad/`: capturing these Marks, voice and imports on the iPad. You own `agent/`, `link/` and `kernel/` for this work. Agree on shapes through `protocol/`.
- T9 (Relay) and T10 (web viewer and author kit) also run now. T10 adds its own CLI command group; whichever of you merges second rebases.
- If Codex's usage limit runs out, prove the Codex half in Claude Code only and say so (the user decided this).

## Constraints
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

```md
# Relay: reach a Space from anywhere, with an encrypted log

## Goal
Build the Relay, the hosted service that lets Agents and devices outside the local network reach a Space. When this is done:
- A Cloudflare Worker with Durable Objects stores each Space as an encrypted log it cannot read, plus encrypted assets in R2, and routes encrypted changes between a person's devices.
- Remote MCP over OAuth lets a cloud Agent connect. A device issues a scoped, expiring grant for one Space; only under that grant does a cloud session decrypt and materialize the Space and run the same `kernel` and `agent` code.
- The Link and the iPad can sync through the Relay over WebSocket, as a second path next to the LAN.
- A self-hosted Node Relay runs the same code outside Cloudflare.
- A real materialized Space runs inside the Durable Object within Workers' 128 MB. If it runs out of memory there, cloud execution moves to a separate service and the Durable Object stays the encrypted router and log.

Run everything locally (`wrangler dev` and Node). Deploying to relay.eilmer.si is T14.

## Context
- Read docs/adr/0001, 0004 and 0008; docs/SPEC.md §3 and §13; docs/ARCHITECTURE.md §2 (the `relay` unit), §6 (transport, storage, identity), §8.4 and §13 (the Relay row).
- What exists on main: `protocol/` (T1), `kernel/` (T2), `apps/ipad/` (T3), `agent/` (T4), `link/` (T5) and the working round trip (T6): an Agent draws, the person circles an Element on the iPad and presses Send, and the Agent gets the circled Element's ID and a crop. Read the READMEs in each folder and docs/harness-notes.md.
- The kernel's WASM build is about 3.8 MB.
- T8 (core), T7 (iPad), T10 (web) and T11 (peer-to-peer) run at the same time. You own `relay/` and the Relay transport behind the interface in ARCHITECTURE §6. T11 adds another transport; keep yours in its own module.
- Never deploy to Cloudflare in this ticket.

## Constraints
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

```md
# Web viewer, author kit and the Library

## Goal
Build the web viewer and the tools for people and Agents who extend Reflex. When this is done:
- A web viewer opens a Space from the Link in a browser and draws it, live.
- `reflex create guide|recipe|embed|adapter <name>` writes a working example; `reflex test` runs that kind's contract checks; `reflex dev` opens the viewer on an in-memory Space with hot reload and three panes (what the Agent reads, what a Send produces when you draw with the mouse in dev mode, and live lints and Anchors), with a "save example" button.
- An Agent saves a Recipe or Embed Template it invented with `apply`'s `define` op. It lands in the person's Library (an ordinary Space of kind `library`), is checked like any extension, and appears in `read_me("index")` for every Agent in every Space.

## Context
- Read docs/SPEC.md §7 ("Agents save what they invent"), §12 and §14; docs/ARCHITECTURE.md §3 (the Library), §4.2 (`define`), §5 (the extension ladder and author kit) and §10; docs/adr/0006 and its amendment.
- What exists on main: `protocol/` (T1), `kernel/` (T2), `apps/ipad/` (T3), `agent/` (T4), `link/` (T5) and the working round trip (T6): an Agent draws, the person circles an Element on the iPad and presses Send, and the Agent gets the circled Element's ID and a crop. Read the READMEs in each folder and docs/harness-notes.md.
- T8 runs at the same time and builds `read_me` and `recipe` and CLI parity in `agent/`. Add your CLI commands as their own group and keep `define`'s Library storage separate from T8's files where you can; whichever of you merges second rebases.
- None of this needs an iPad or Xcode.

## Constraints
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

```md
# Peer-to-peer: a second path between the iPad and the Mac

## Goal
Add a second real transport between the iPad and the Link: Apple peer-to-peer Wi-Fi, so they stay connected with no shared Wi-Fi network. When this is done:
- The iPad and the Mac find each other and connect over peer-to-peer Wi-Fi (Network.framework), with the Mac side as a small Apple-only Swift helper the Link talks to.
- With both LAN and peer-to-peer up, each change takes the fastest live path, chosen with hysteresis, and moves to the other path when one drops.
- The same change arriving over both paths is harmless.
- A fault-injection transport exists for dropping, delaying and duplicating frames.

## Context
- Read docs/SPEC.md §3 and §13; docs/ARCHITECTURE.md §6 (the transport interface and build order) and §7; docs/adr/0001.
- What exists on main: `protocol/` (T1), `kernel/` (T2), `apps/ipad/` (T3), `agent/` (T4), `link/` (T5) and the working round trip (T6): an Agent draws, the person circles an Element on the iPad and presses Send, and the Agent gets the circled Element's ID and a crop. Read the READMEs in each folder and docs/harness-notes.md.
- A real iPad (iPad13,6) is paired and connected to this Mac over USB, and the user has an Apple Developer account. Peer-to-peer Wi-Fi only works on real hardware, so prove it on that iPad with the Mac. Build and install with Xcode's command-line tools; don't run anything that triggers macOS password or keychain prompts.
- T9 (Relay) adds a WebSocket transport at the same time; T7 edits the iPad app's screens. Keep your networking in its own module on both sides.

## Constraints
- Don't edit SPEC, ARCHITECTURE or the ADRs. If the work shows one needs to change, say so in your report.

## Evidence of done
When you are done, use it yourself the way a user would: run the real app and go through it like they do. If it has no user, use it the way its real client would, such as a program calling the API or an agent calling the tool. Check that it works, that it does everything this ticket asks, and that you hit no other problems. Show what you saw: screenshots, a video, or the output.
```

## Follow-ups carried into later tickets

Found while building earlier tickets. Each goes into the named ticket's brief.

- **T6:** move the iPad's Element drawing from T3's stand-in scene JSON onto the Protocol v0 Element format.
- **T6 (done):** the kernel checks changes it receives from peers (`receive_sync_message_checked`, `kernel/core/src/auth.rs`): an iPad may write only as its person, and a Link also for Agents. It checks against the receiver's state before applying, not at the writer's frontier; ownership never changes, so the two agree for owners. Roles wait for T22.
- **T6 (done, narrowed):** no Reflex command can approve an Agent any more. Only the Link's terminal or an iPad that paired by scanning its code can, and `admin.key` can only deny or revoke. A local process running as the user can still read the Link's files and its terminal; OS-level separation and platform credential stores are left for later.
- **T11:** the fault-injection transport isn't built (T5).
- **T8:** T4 review items left open: Mark IDs are looked up per Agent, not per Space (S3); result indexes are off when a `define` op comes first (S5); a Space can't be named `library` and the error doesn't say why (S7); an `add` with type `ink` or `file` reports a missing type (S8).
- **T8:** `read_me` and `recipe` aren't built, but the server instructions tell Agents to call `read_me` first.
- **T8:** the CLI adds a `file` path to images that the schema has no field for. Agent Element IDs show to other Agents as `agent:id`, because the protocol's ID pattern doesn't allow `/`.
- **T2 follow-ups for the kernel owner (T8):** the state digest covers Send IDs but not their contents; moving a connector is accepted but changes nothing; undo, redo, undo in the same millisecond can hide a restored Element; concurrent undo and a new action on two of one person's devices can make redo replay an older entry. Text measurement, Mark grouping, revert planning and migrations aren't built.
- **T16:** Embed state changes don't sync yet (T10). **T20:** Library entries can't be renamed or deleted yet; `read_me(<type>)` returns `unknown_topic` for Element types listed in the index; example values for a number with maximum below 1 come out as 1; the web viewer says "Offline, retrying" after a 401 (T10).
- **T15:** tap actions on a revoked Agent's Elements still run its `set` and `apply_recipe`, because the runner doesn't check approval; `wait_for_user(element:)` misses taps whose action is `send`; `request_attention` never reports that the person is already viewing that Space (T8). **T13:** nothing caps how many Elements one Mark lists, and Marks re-fork the Space once per Mark (T8).
- **Codex:** its usage limit ran out until 2026-11-12 13:06, so T8's scenario 1 was proven in Claude Code only; recheck in Codex in a later ticket.
- **T9:** check the kernel WASM (3.77 MB) against Workers' 128 MB with a real Space.
- **Real iPad pass:** three-finger redo, Pencil double-tap and squeeze. Native WWDC26 stroke IDs need Xcode 27 (the app targets iPadOS 26 for now).
