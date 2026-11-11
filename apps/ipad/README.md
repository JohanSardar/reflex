# Reflex for iPad

The iPad app: a PencilKit canvas for the user's Ink, with Agent Elements drawn under it, synced with the Reflex Link on your computer.

## Use it

1. Run `reflex link` on your computer. It shows a QR code and the same code as text.
2. On the iPad, tap Connect and scan the code, or paste its text (it starts with `reflex://pair?`). Opening a `reflex://pair?…` link pairs too.
3. When an Agent opens a Space, it shows up in the Spaces menu (a dot marks Spaces that changed). Draw on it, and press Send to hand your strokes to the Agents in that Space.
4. The first time an Agent connects, the iPad asks whether to allow it.

The iPad keeps working offline. Strokes and Sends are saved in the kernel first and go out when the Link is back.

## Build and run

Needs Xcode 26.4 or later. The project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen); run `xcodegen generate` after adding or removing files.

```sh
xcodebuild -project Reflex.xcodeproj -scheme Reflex \
  -destination 'platform=iOS Simulator,name=<an iPad simulator>' build
```

## Layout

- `Reflex/`: the app. `CanvasScreen` stacks the Elements, the Ink canvas, the toolbar, the Send button, the Spaces menu and the connection status. `SpaceSession` turns each finished Ink change into a kernel intent (`add_stroke`, `erase`, `erase_precise`, `move`) and canvas undo into the kernel's per-person undo. `PairSheet` pairs.
- `Packages/ReflexLink`: the Link connection. The same handshake and encrypted framing as the Link (Ed25519, X25519, HKDF, ChaCha20-Poly1305 over length-prefixed TCP), Bonjour discovery, reconnects, the kernel's sync per Space, assets, and Agent approval. Each Space is a kernel replica (UniFFI, `kernel/swift`) saved to `space.automerge`.
- `Packages/ReflexInput`: Ink. The PencilKit canvas, tools, eraser, undo gestures, Pencil double-tap and squeeze, stroke identity and local saving.
- `Packages/ReflexRender`: draws Protocol v0 Elements (text, Markdown, shapes, sticky notes, math, frames, regions, connectors, images) from the kernel's scene JSON. Unknown types draw as a labelled placeholder.

`ReflexEmbed` joins with the Embed ticket.

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

## Not yet

- The device key and pairing are files in Application Support, not the Keychain.
- Remote Ink can't be erased or lassoed from this iPad; only its own Ink is in PencilKit.

## Debug

Debug builds have a `#` button on the toolbar that draws each stroke's ID, and its parent, next to it.

Debug builds also take `reflex://debug/voice?file=<name>`, which transcribes an audio file in the app's Documents through the same on-device recognizer and sends it as a voice Send. The Simulator has no on-device speech model, so there it shows "Speech recognition failed"; use a real iPad.

Debug builds also take `reflex://debug/ellipse?cx=&cy=&rx=&ry=` (screen points), which draws one closed pen stroke through the same PencilKit path as a finger. Simulator automation has no freeform gesture, so this is how a circle is drawn there.
