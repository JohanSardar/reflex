# Reflex for iPad

Write with PencilKit, hold the mic to speak, then Send to the paired Link. The
canvas, erasers, lasso and undo are native PencilKit. Drawing and moving the
Pencil have no network callbacks. Voice recognition stays on the iPad.

Pair with the QR code from `reflex setup` or `reflex pair`. Pairing and Agent
approval use the existing encrypted LAN, peer-to-peer Wi-Fi and Relay paths.
The Link asks this iPad to approve Agents as before. Agents receive Sends in
Claude Code or Codex; they cannot write onto the iPad.

## Local pages and upgrades

Pages live under `Application Support/Reflex/Spaces/<id>/`. `ink.pkdrawing` is
the native drawing archive; `ink.json` keeps stroke IDs and the pending Send
selection. Both are saved on a serial background queue after finished edits,
never on Pencil movement. Existing archives and IDs are read in place. Old
`space.automerge` files are left intact, but are never loaded or sent. Agent
content from those documents is no longer shown. Pages kept under an earlier
pairing in `LocalOnly/` remain readable locally and cannot be sent to a new
person's Link.

## Send

Only pressing Send, or releasing the voice button, exports ink. A Send holds
new strokes, a snapshot of the page's ink for resolving marks and targets,
Apple's handwriting hints, timed spoken words, viewport and PNG screen crops.
The snapshot does not change while handwriting recognition finishes.

The envelope is written atomically under `Reflex/Sends/` and bound to the
paired Link's key before strokes are claimed. It is retried on reconnect and
until `send_ack`. Referenced crop assets go first on the same ordered encrypted
connection. The Link acknowledges only after durable ingestion. Acknowledging
receipt on the Link is separate from the Agent acknowledging the Send with
`wait_for_user(after: ...)`.

## Build

Run `xcodegen generate --spec apps/ipad/project.yml`, then:

```sh
xcodebuild -project apps/ipad/Reflex.xcodeproj -scheme Reflex \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

No Rust build, Automerge, renderer, Embed host, 3D runtime or math layout is
part of the iPad app. `ReflexInput` owns local ink and `ReflexLink` owns pairing,
approval and Send delivery. The deployment target remains iPadOS 26.
