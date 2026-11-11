# Reflex for iPad

The iPad app: a PencilKit canvas for the user's Ink, with Agent Elements drawn under it.

## Build and run

Needs Xcode 26.4 or later. The project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen); run `xcodegen generate` after adding or removing files.

```sh
xcodebuild -project Reflex.xcodeproj -scheme Reflex \
  -destination 'platform=iOS Simulator,name=<an iPad simulator>' build
```

## Layout

- `Reflex/`: the app. `CanvasScreen` stacks the Elements, the Ink canvas, the toolbar and the Send button.
- `Packages/ReflexInput`: Ink. The PencilKit canvas, tools, eraser, undo gestures, Pencil double-tap and squeeze, stroke identity and local saving.
- `Packages/ReflexRender`: draws Elements (text, Markdown, shapes, sticky notes, connectors, images) from scene JSON. Unknown types draw as a labelled placeholder.

`ReflexKernel` (UniFFI) and `ReflexEmbed` join when the round-trip and Embed tickets need them.

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

On load, strokes are paired with their saved records by creation time, point count and visible ranges. This is local storage only: syncing finished strokes through the kernel comes with the round-trip ticket (T6). Agent Elements never touch the PencilKit drawing.

## Debug

Debug builds have a `#` button on the toolbar that draws each stroke's ID, and its parent, next to it.
