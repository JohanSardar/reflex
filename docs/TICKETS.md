# Reflex tickets

The build is split into 21 tickets, one agent each. [ticket-map.html](./ticket-map.html) shows which can run at the same time. Steps and their outcomes are summarized in [ARCHITECTURE.md §12](./ARCHITECTURE.md).

Every ticket is proven by using the real thing: the app in the iPad Simulator, a real Claude Code or Codex session, or the real CLI. No ticket builds benchmarks, eval harnesses or test suites.

## All tickets

There are 50 work items (H1–H50), and each one is in exactly one ticket.

| Ticket | What's in it | Can start |
|---|---|---|
| T1 Protocol v0 | H9 schemas for every message, including `data`, Behaviors, `define`, Embed state and added files, with a few correct examples · H10 hand-written tool text and server instructions | Now |
| T2 Kernel | H5 Element types · H6 `apply`, `scene`, `freeze_send` · H7 Swift and WASM bindings, with a stop-and-report if they don't work or the copies don't converge · H8 Automerge mapping · H43 the `data` map on every Element | Now |
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
- one correct, hand-written example for each message type

Next to them sit the descriptions of the eleven tools and server instructions of about 400 tokens or fewer, all written by hand.

Everything else in Reflex builds on these shapes, and the Agent is Reflex's real user. The shapes must also leave room for uses nobody designed: every Element has a free `data` map, Behaviors pair a trigger with an action, `define` saves an Agent's Recipe or Embed Template to the Library, and the Send Bundle carries Embed state and files the user added.

## Context
- Read docs/ARCHITECTURE.md §4 (the Agent contract, with example `apply` and Send Bundle JSON), §5 (the Embed bridge) and §9 (schema rules); docs/SPEC.md §2, §5, §7, §9 and §11; docs/adr/0003, 0006 (including its amendment) and 0007; and docs/architecture/review-fable.md §2, the source of the tool list, the op and Bundle shapes, and ten ways models get confused.
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
- It applies `apply_agent_batch`, projects `scene`, and freezes a Send with `freeze_send`.
- Swift calls it through UniFFI in an app running in the iPad Simulator.
- TypeScript calls it through WASM, in Node and in Cloudflare Workers.

A Swift copy and a TypeScript copy of the same Space must still agree after edits made to both at the same time, including create, patch and delete, and after one restart.

If the bindings don't work, or the copies don't converge, stop and report what failed. ADR-0005's fallback then applies. That go/no-go is the point of building the kernel first: a disagreement here would be a malformed document copied to every device.

## Context
- Read docs/adr/0001, 0004 and 0005; docs/ARCHITECTURE.md §3 (the kernel API and guarantees), §7 (correctness rules), §9, §11 and §13; and docs/architecture/gpt-sol.md §1.2 for the data model.
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
  - Undo covers only the user's own actions.
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
