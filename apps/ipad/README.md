# Reflex for iPad

The iPad app: a PencilKit canvas for the user's Ink, with Agent Elements drawn under it, synced with the Reflex Link on your computer.

## Use it

1. Run `reflex link` on your computer. It shows a QR code and the same code as text.
2. On the iPad, tap Connect and scan the code, or paste its text (it starts with `reflex://pair?`). Opening a `reflex://pair?…` link pairs too.
3. When an Agent opens a Space, it shows up in the Spaces menu (a dot marks Spaces that changed). Draw on it, and press Send to hand your strokes to the Agents in that Space.
4. The first time an Agent connects, the iPad asks whether to allow it.
5. To share a Space, tap the people button, pick Editor or Viewer and Make an invite: a QR code and a `reflex://invite?…` code, single use. The other person scans it, opens it, or pastes it in Connect and taps Join. The People list there changes someone's role or removes them. Who else is here shows as named chips at the top right, with their cursors and selections on the canvas; a viewer sees "View only", and someone removed sees "Removed".

The iPad keeps working offline. Strokes and Sends are saved in the kernel first and go out when the Link is back.

## Build and run

Needs Xcode 26.4 or later. The project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen); run `xcodegen generate` after adding or removing files.

```sh
xcodebuild -project Reflex.xcodeproj -scheme Reflex \
  -destination 'platform=iOS Simulator,name=<an iPad simulator>' build
```

## Layout

- `Reflex/`: the app. `CanvasScreen` stacks the Elements, the Ink canvas, the toolbar, the Send button, the Spaces menu and the connection status. `SpaceSession` turns each finished Ink change into a kernel intent (`add_stroke`, `erase`, `erase_precise`, `move`) and canvas undo into the kernel's per-person undo. `PairSheet` pairs.
- `Packages/ReflexLink`: the Link connection. The same handshake and encrypted framing as the Link (Ed25519, X25519, HKDF, ChaCha20-Poly1305 over length-prefixed TCP), Bonjour discovery, reconnects, the kernel's sync per Space, assets, and Agent approval. When the Link uses a Relay it tells the iPad where (`relay.json`), and if no LAN address answers, the iPad reaches the Link through the Relay (`RelayConnection`) with the same handshake inside. Each Space is a kernel replica (UniFFI, `kernel/swift`) saved to `space.automerge`.
- `Packages/ReflexInput`: Ink. The PencilKit canvas, tools, eraser, undo gestures, Pencil double-tap and squeeze, stroke identity and local saving.
- `Packages/ReflexRender`: draws Protocol v0 Elements (text, Markdown, shapes, sticky notes, math, frames, regions, connectors, images) from the kernel's scene JSON. Unknown types draw as a labelled placeholder. LaTeX (`math`) is typeset natively with [SwiftMath](https://github.com/mgriebling/SwiftMath) (MIT), drawn at the screen's scale times the zoom so it stays crisp when zoomed in; LaTeX that doesn't parse shows as its source.

- `Packages/ReflexEmbed`: HTML Embeds. Each runs in its own `WKWebView` with a nonpersistent data store, a content rule list that blocks every load but its approved CDNs (code only) and `allow` hosts, the same Content Security Policy as the web viewer, no navigation, popups or dialogs, and the shared bridge (`Resources/bridge.js` links to `apps/web/src/bridge.js`) on a script message handler. A 5-second heartbeat stops an Embed that keeps the processor busy, a crashed web process is reported, and every block shows as a note on the Embed. Canvas Embeds don't take touches (the Pencil draws over them); Embeds in a Panel do. `setState` is saved on the Element (`set_state`) and syncs; an Embed in a Panel saves it as its component's value. `notify` becomes a tap for the Agent, `emit` fires `embed_event` Behaviors, and a Mark drawn on an Embed asks its Anchor resolver what it points at (`embed_anchors` on the Send). An MCP App view's tool calls are denied until the person taps "Allow <server>" on it; this iPad remembers the server.
- `Packages/ReflexModel`: 3D Embeds (an Embed with a `model`). It reads the GLB the Link packs every glTF into (node tree, triangle meshes, base colors) or a USDZ into RealityKit, in an `ARView` with no camera feed. The orbit camera matches the web viewer and `look` (40° field of view, `yaw`, `pitch`, `zoom` around the model's center). Named nodes holding meshes are its parts. It answers which part is under a point (ray against the triangles), resolves a Mark to the parts it covers with the camera pose, and moves a grabbed part on a plane facing the camera.

## 3D Embeds

- **Turn, zoom, slide.** One finger on a 3D Embed turns the model, a pinch zooms, two fingers slide it. The Pencil still draws over it. These are read from the touches themselves in `ReflexInput`'s `TouchWatcher`: on iOS 26 PencilKit holds back a pan recognizer's actions on the canvas until the finger lifts.
- **Grab a part.** Hold a finger still on a part for a moment (it turns blue), then move it. Letting go saves `part:<name>` in the Embed's state (`position`, `moved_by`, `base`), which syncs and shows in the next Send's `changes`. A viewer can't move parts.
- **Marks.** A stroke drawn over the model is resolved when it is drawn, so it names the part as the person saw it: `{kind: "part", part, parts, label, camera}`.
- **Send images** draw a snapshot of the model under the Ink, not a grey box.
- **Import.** A `.glb`, `.gltf` (with its buffers inside) or `.usdz` from Files or dropped on the canvas becomes a 3D Embed.

## Minimum iPadOS: 26.0

The WWDC26 PencilKit APIs with stable stroke and path IDs need iPadOS 27 and its SDK (Xcode 27). Xcode 26.4 ships only the iPadOS 26.4 SDK, so this build targets iPadOS 26 and gives strokes their own Reflex IDs (`StrokeIdentity.swift`):

- A new stroke gets an ID like `ink_1f2e3d4c5b6a`.
- A fragment left by a precise erase gets a new ID whose `parent` is the stroke it was cut from.
- Undo and redo bring back the IDs the strokes had before.
- A lasso move or recolor keeps the ID.
- Strokes are never identified by their index in the drawing.

Once Xcode 27 is available, the native IDs can feed this same mapping behind an availability check, and the minimum can move to iPadOS 27 if keeping iPadOS 26 isn't worth the cost.

## Ink on disk

Each Space keeps two files in `Application Support/Reflex/Spaces/<space>/`:

- `ink.pkdrawing`: the native PencilKit archive, kept for fidelity.
- `ink.json`: the portable strokes (ID, parent, ink, color, transform, control points, visible ranges, bounds), plus the IDs of erased strokes kept for lineage. This is the form for the web viewer, export and `read(detail: "strokes")`.

On load, strokes are paired with their saved records by creation time, point count and visible ranges. Every finished stroke also goes into the Space's kernel replica as Ink with the same ID, and that is what syncs. Agent Elements never touch the PencilKit drawing.

## Send

Send claims the strokes drawn since the last Send in the kernel (`freeze_send`), with the viewport and a crop of the screen around them. The crop is stored as an asset first and pushed to the Link ahead of the Send. The Link groups the strokes into Marks, finds what each circle encloses, and hands the Bundle to the Agents.

## Plan review

- **Marks.** Circles, arrows, strikethroughs and writing go out with the Send as strokes, with a crop of the screen around them and Apple's on-device handwriting hint for each group of strokes that reads as writing (`hints`, from Vision). The kernel's `marks` and the Link decide what the marks mean.
- **Voice.** Hold the mic button and talk. Apple's on-device speech recognition transcribes it, with each word's `start_ms` and `end_ms` on the same clock as the strokes. Letting go sends the voice and the Ink together. Audio never leaves the iPad, and there is no voice where on-device recognition isn't available.
- **Agents and history.** Each Agent that changed the Space gets a chip in its color. The chip says what its last change was and reverts it (the kernel's `revert`, as the person, so undo brings it back). The clock opens the Space's history (the kernel's `timeline`), newest first, with reverted and undone entries greyed.
- **Behaviors.** Tap, long-press, drag end, Ink drawn inside, and a Panel value changing fire the Element's Behaviors. `open_panel` opens a native Panel on the iPad. For anything else the iPad freezes a raw Send with `trigger: "behavior"`, the `element` and `on` (and the Panel's `values`, or the strokes drawn inside), and the kernel decides what it is: a full Send, a tap that claims nothing, or an action (`set`, `apply_recipe`) the Link runs as the Element's owner. A finger on an Element with a Behavior for that touch doesn't draw.
- **Photos and files.** The + menu adds photos, a camera photo, or files; files and pictures can also be dropped on the canvas. Each becomes one `add_file` intent: a picture an image Element, each rendered PDF page an image Element, anything else a file Element. The bytes are stored as assets first, and the Elements go in the nearest free spot on screen.
- **Ink from other devices** is drawn from its raw points under this iPad's own Ink.

## Math tutor: Regions

- **Regions** show their rules: a tinted writing area with its title; hatched grey with "No writing here" where `ink: false`; an "Agent is watching" badge while watch mode is on; a lock badge where Agents are read-only.
- **No Ink where `ink: false`.** A pen stroke that starts there doesn't draw, and the person is told why. A stroke the kernel refuses anyway (its center is inside) is taken back off the canvas.
- **A Region's Send button** ("Check my work", the Region's `send_button`) sits at its bottom-right corner, above the Ink. It sends only the work inside that Region (`trigger: "region"`), with a crop of the part of the Region on screen and one handwriting hint per line: the strokes are grouped into lines top to bottom and Vision reads each line, without language correction, so `3x - 7 = 2x + 5` stays an equation.
- **Watch mode.** While a Region is watched, the iPad reads its lines again each time the person pauses (lines it already read are cached) and sends them to the Link (`hints`), so the Link's watch snapshots carry the recognizer's text.
- **Presence.** The iPad tells the Link which Space is on screen (none in the background) and when the pen goes down and up (`presence`). `request_attention` answers `already_viewing` when the person is in that Space, and a watch snapshot's `user_still_writing` comes from the pen.

## Not yet

- The device key and pairing are files in Application Support, not the Keychain.
- After a refused change, the iPad starts the Space over from the Link's copy; its own Ink comes back as remote Ink.
- Remote Ink can't be erased or lassoed from this iPad; only its own Ink is in PencilKit.
- An MCP App server the person allowed is allowed on this iPad only.
- 3D models: textures, skins and animation aren't read from a GLB; a `.gltf` import needs its buffers inside it (data: URIs). Only one part moves at a time, by position; turning a part by hand isn't there.
- A refused Panel save isn't retried.

## Debug

Debug builds have a `#` button on the toolbar that draws each stroke's ID, and its parent, next to it.

Debug builds also take `reflex://debug/voice?file=<name>`, which transcribes an audio file in the app's Documents through the same on-device recognizer and sends it as a voice Send. The Simulator has no on-device speech model, so there it shows "Speech recognition failed"; use a real iPad.

Debug builds also take `reflex://debug/ellipse?cx=&cy=&rx=&ry=` (screen points), which draws one closed pen stroke through the same PencilKit path as a finger. Simulator automation has no freeform gesture, so this is how a circle is drawn there.

Debug builds also take `reflex://debug/write?region=<id>&text=<line>[&pause=<s>]`, which writes one line by hand below the person's lines in that Region: each glyph's outline in a handwriting font becomes pen strokes, drawn one after another (`pause` seconds apart, 0.05 by default) with the pen going down and up, through the same PencilKit path. Encode `+` as `%2B`.
