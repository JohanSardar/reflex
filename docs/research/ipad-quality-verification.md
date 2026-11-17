# T31 verification evidence

Base: origin/main `51de789`. Changes are limited to apps/ipad/, the new iPad
workflow and docs/research/. No TestFlight upload or submission was performed.

## Local commands and observed output

Xcode reports **26.4.1 (17E202)**; bundled swift-format reports **6.3.0**.

- `xcodegen generate --spec apps/ipad/project.yml`: succeeded.
- Baseline `xcodebuild -project apps/ipad/Reflex.xcodeproj -scheme Reflex
  -destination 'generic/platform=iOS Simulator' -derivedDataPath
  /tmp/reflex-t31-main CODE_SIGNING_ALLOWED=NO build`: **BUILD SUCCEEDED**.
- `DESTINATION='platform=iOS Simulator,id=ED9B9340-E7B2-4D8C-808A-721ADBD2CE4A'
  DERIVED_DATA=/tmp/reflex-t31-check apps/ipad/scripts/check.sh`: strict format
  lint passed, Release **BUILD SUCCEEDED**, full existing suite **TEST SUCCEEDED**.
  `StrokeIdentityTests.testPreciseEraseAcrossTwoFragmentsKeepsEachParent`
  passed; **executed 1 test, 0 failures**, no skipped tests. No new tests added.
- After declaration extractions and plist changes: strict lint passed and
  Release Simulator build again **BUILD SUCCEEDED**. Built app's effective
  `CFBundleShortVersionString` is **1.0**, matching the baseline plist.
- `bash -n apps/ipad/scripts/*.sh`: passed. Invoking scripts without required
  inputs exits 1 before building/signing (DESTINATION / DEVELOPMENT_TEAM).
- Compared every original Swift file with the same formatter's output,
  accounting for the documented declaration moves/import changes. No hand
  edits to Swift behavior. `git diff --check`: passed.

Existing baseline warnings remain visible: UIScreen.main deprecations, an
unused optional binding, camera availability actor isolation, an unnecessary
nonisolated annotation, and AppIntents metadata extraction without AppIntents.
No warning suppression, test removal or concurrency relaxation was added.

## Device interaction blocker

Created the requested dedicated Simulator **Reflex T31 iPad**, UUID
`ED9B9340-E7B2-4D8C-808A-721ADBD2CE4A`. The device tool returned:

```text
No device ED9B9340-E7B2-4D8C-808A-721ADBD2CE4A on 'This machine' (hostId local).
Call device_list for current ids.
```

Followed its advice once: refreshed `device_list`, then retried `device_open`.
The same error persisted, and the refreshed list omitted the newly created
Simulator. Stopped UI automation as required by the device-tool instructions;
did not use another worker's Simulator or fall back to simctl/AppleScript
for interaction. Xcode's own test runner independently found this Simulator
and ran the existing test successfully, as recorded in its xcresult.

## Ticket acceptance and guardrails

| Requested evidence | Result |
| --- | --- |
| Linked research for all nine practices and Reflex comparison | Written in ipad-quality.md, with pinned source links |
| Every-PR free-runner build/checks | Implemented in ipad.yml; GitHub run status recorded with the PR |
| Fresh-clone README | Isolated local clone at 71b8abb: XcodeGen and the README unsigned Simulator build passed; generated files remained clean. Interactive Run remains blocked |
| Make board, write/draw, restart, compare screens to main | **Not checked**: device discovery blocker; no screenshots/video claimed |
| Fresh-agent code, Send and wait_for_user | **Not checked**: same blocker |
| Correct/wrong/consumed code and five failed tries on iPad | **Not checked**: same blocker |
| LAN/nearby/relay pairing unchanged | Swift changes mechanically verified as formatting/declaration moves; real flow **not checked** |
| Unchanged screens, arrow logo, no red branding | Assets and view logic unchanged in diff; visual parity **not checked** |
| One-paste setup and small npx install | agent/, link/, relay/, dist/, root package.json and npx workflow untouched; download timing **not measured** |
| Secrets out of source, repeatable release | External signing prerequisites and separate upload/group/review steps documented; signed archive/export **not executed** |
| No publish/release/deploy | None performed; only the requested GitHub branch/PR is published |

These limits mean T31's full hands-on acceptance is still open. A green build
and source-equivalent cleanup cannot establish the missing end-to-end evidence.

## Independent Sol review

Two rounds with **gpt-6.1-sol**, reasoning effort **medium**, through T3 Code:
**APPROVE**, no implementation findings and no tests added. Ledger: no blocker,
should or nit items. Round 1 independently checked formatter equivalence,
byte-for-byte regeneration of the project/scheme/plist, strict lint, shell
syntax, diff whitespace, source links and runner/toolchain availability. It
kept the missing manual acceptance evidence separate from implementation
approval. Round 2 approved the CI context/runtime corrections, confirming
the full 26.4.1 runtime against the GitHub runner inventory. Both rounds had
no implementation findings; A1 and A2 below were self-found and resolved.
Usage was not exposed.

Diff at review and after review: 44 files, 3,110 insertions and 1,094 deletions
before this documentation-only evidence update. No product code changed after
review. No findings were declined or fixes requested by Sol. The branch is pushed
only after approval. No new TestFlight binary is needed for a user-visible fix;
shipping this source cleanup would require a separately authorized new build
number, upload and Beta App Review.

## CI bring-up corrections

The first GitHub evaluation failed before starting jobs because runner.temp
is unavailable in a job-level env expression. Moved DERIVED_DATA into the
check step env; actionlint then passed. Also verified Xcode requires the full
runtime version: requesting OS=26.4 locally rejected the available 26.4.1
Simulator. Updated the workflow and README examples to OS=26.4.1. The local
full-suite run used the dedicated device UUID and was unaffected. No Swift
product code changed in these corrections.
