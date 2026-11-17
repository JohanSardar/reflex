# Reflex for iPad

Write with PencilKit, hold the mic to speak, then Send to the paired Link. The
canvas, erasers, lasso and undo are native PencilKit. Drawing and moving the
Pencil have no network callbacks. Voice recognition stays on the iPad.

Pair by typing the 6-digit code an agent gives (its `connect` tool) or `reflex pair` shows. The iPad looks for the Mac over Bonjour
first; only when no Mac is nearby does it try the code in a Relay's pairing room (`RelayLobby.swift`, checked with CPace in
`Cpace.swift`). Pairing and Agent approval use the existing encrypted LAN, peer-to-peer Wi-Fi and Relay paths.
Typing the code lets in the Agent that gave it; others ask on this iPad. Agents receive Sends in
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
Apple's handwriting hints, timed spoken words, viewport and PNG board images. Every Send includes the visible board plus a real
15% margin on each side, rendered without controls at up to 2,000 pixels on the
longest side. Sends with new strokes also include a close-up of those strokes.
Image bounds and the viewport use board coordinates; image roles and mark links
are shared by wait_for_user, Claude Code channel pushes and webhooks.
The snapshot does not change while handwriting recognition finishes.

The envelope is written atomically under `Reflex/Sends/` and bound to the
paired Link's key before strokes are claimed. It is retried on reconnect and
until `send_ack`. Referenced crop assets go first on the same ordered encrypted
connection. The Link acknowledges only after durable ingestion. Acknowledging
receipt on the Link is separate from the Agent acknowledging the Send with
`wait_for_user(after: ...)`.

## Install

[Join the Reflex TestFlight beta](https://testflight.apple.com/join/R81n88Re).
External testers can install once Apple approves Beta App Review. No separate
Mac app install is needed: use the repository's npx command and ask your agent
“connect my iPad”. The app stays useful for local boards without a Mac.

## Build and run from a fresh clone

Use macOS with **Xcode 26.4.1** (Swift 6.3, iOS 26.4 Simulator runtime) and
[XcodeGen](https://github.com/yonaskolb/XcodeGen). The minimum supported device
OS is iPadOS 26. CI uses the same Xcode version on GitHub's free public-repository
`macos-26` runner. Install Xcode and its iOS Simulator runtime first, complete
Xcode's first-launch setup, and install XcodeGen (`brew install xcodegen`).
A Simulator build needs no Apple Developer membership, signing key, Node,
server, Rust or paid service.

```sh
git clone https://github.com/JohanSardar/reflex.git
cd reflex
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -version  # should report Xcode 26.4.1
xcodegen generate --spec apps/ipad/project.yml
open apps/ipad/Reflex.xcodeproj
```

Select the **Reflex** scheme and an **iPad** Simulator, then Product → Run.
The app is iPad-only. Create a board with +, add text or draw, and use Send.
For a real pairing, allow Local Network access and enter the six-digit code
from a fresh agent's `connect` tool; nearby discovery happens before relay
fallback. Simulator drawing uses the mouse; Pencil pressure and on-device
speech recognition require a physical iPad. Select an iPad Simulator, not
“My Mac” or a physical device, to avoid signing setup.

To build without opening Xcode:


Run `xcodegen generate --spec apps/ipad/project.yml`, then:

```sh
xcodebuild -project apps/ipad/Reflex.xcodeproj -scheme Reflex \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## Checks and navigation

From the repository root, list installed destinations with
`xcodebuild -project apps/ipad/Reflex.xcodeproj -scheme Reflex -showdestinations`.
Then run the same check as CI (use an available iPad destination):

```sh
DESTINATION='platform=iOS Simulator,name=iPad Pro 13-inch (M5),OS=26.4.1' \
  apps/ipad/scripts/check.sh
```

This runs strict `swift-format` lint, generates the project, builds Release,
and runs the complete existing `ReflexInputTests` suite on the Simulator.
Each run keeps its `.xcresult` under `apps/ipad/build/check/TestResults/`;
set `DERIVED_DATA` to use another build directory.
The [iPad workflow](../../.github/workflows/ipad.yml) runs on every PR (forks
included, without secrets), pushes to main, and manual dispatch. Test results
are retained for seven days. Swift 6 complete concurrency checking is enabled.
Existing compiler warnings are visible in the logs; they are not suppressed.

Format Swift changes before committing:

```sh
xcrun swift-format format --in-place --recursive \
  --configuration apps/ipad/.swift-format apps/ipad/Reflex apps/ipad/Packages
```

| Location | Responsibility |
| --- | --- |
| `Reflex/ReflexApp.swift` | App composition and lifetime |
| `Reflex/BrowserView.swift`, `BoardScreen.swift`, `CanvasScreen.swift` | Library and board screens |
| `Reflex/BoardModel.swift`, `BoardSession.swift` | Board objects, history, selection and Send snapshots |
| `Reflex/BoardFiles.swift`, `BoardLibrary.swift` | Local persistence and library/folder operations |
| `Reflex/InteractionLayer.swift`, `MiniToolbar.swift`, `ObjectRendering.swift` | Interaction, tools and rendering |
| `Reflex/PairSheet.swift` | Pairing UI |
| `Packages/ReflexInput` | PencilKit canvas, durable ink and stable stroke identities; existing XCTest regression |
| `Packages/ReflexLink` | Pairing crypto, LAN/peer-to-peer/relay transports, approvals and durable delivery |
| `project.yml` | Source of truth for targets, shared scheme, version and build settings |
| `Reflex.xcodeproj`, `Reflex/Info.plist` | Checked-in generated files; regenerate after changing `project.yml` |

The Swift packages have no third-party dependencies and do not import the app.
The app links their products. The MCP server/CLI (`../../agent`), Mac service
(`../../link`) and relay (`../../relay`) are separate processes; none is built
into the app. No Rust, Automerge, Embed host, 3D runtime or math layout is part
of the iPad app. This ticket does not change the npx build or install path.

See [RELEASING.md](RELEASING.md) for signing, version/build numbers, export,
upload and the Public TestFlight group; see the
[reference comparison](../../docs/research/ipad-quality.md) for the standards
and remaining verification limits.
