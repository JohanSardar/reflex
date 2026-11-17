# iPad quality and release comparison

Research inspected on 2026-11-16 for T31. Links below pin the source revisions
rather than assuming today’s default branches remain unchanged:

- Happy: `1d6d88c5e14cbfb98cad76881acd7ff171edb50c` ([tree](https://github.com/slopus/happy/tree/1d6d88c5e14cbfb98cad76881acd7ff171edb50c)).
- Immich: `ff445d5fda8bf396e769df8977c316726dc25c9c` ([tree](https://github.com/immich-app/immich/tree/ff445d5fda8bf396e769df8977c316726dc25c9c)).
- Localsend: `d1e6198f401939a9b76854f406f7dbb27d67a808` ([tree](https://github.com/localsend/localsend/tree/d1e6198f401939a9b76854f406f7dbb27d67a808)).

## Scope and method

Read the three public repository trees, front pages, mobile manifests, build
instructions, CI definitions and release instructions directly through GitHub.
Happy is now a native Swift/UIKit project; describing its former Expo/EAS
setup as current would be wrong. Immich and LocalSend use Flutter and cannot
supply a Swift lint configuration to copy verbatim. Distinguish written policy,
executable checks and missing automation. No benchmark, star count or number
of modules establishes quality by itself.

The transferable standard is clear ownership, a reproducible local build,
checks that actually run for contributors, and release steps whose credentials
are separate from the source. Reflex is much smaller: three Swift targets,
no third-party Swift packages, and no reason to add a UI framework, paid lint
service, cross-platform build system or many new modules just to resemble a
larger project. Unchanged UI, persistence and protocol behavior take priority.

## Practice-by-practice comparison

### iOS layout and modules

| Project | Observed practice |
| --- | --- |
| Happy | [Swift targets](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/Package.swift) separate crypto, wire, store, core, layout, UI and composition. [Architecture rules](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/AGENTS.md) explain platform boundaries and ownership. |
| Immich | [Mobile guide](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/README.md) explains Flutter/Riverpod models, providers, services, UI and views. [Domain](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/lib/domain/README.md) and [infrastructure](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/lib/infrastructure/README.md) document newer boundaries. |
| LocalSend | [Directory/build guide](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md) places Flutter in app/, shared Rust in packages/, CLI in cli/. [App dependencies](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/app/pubspec.yaml) expose the module edges. |
| Reflex after T31 | Keep the existing app → ReflexInput/ReflexLink package edges. Split board values, file persistence and library state into BoardModel/BoardFiles/BoardLibrary; name BoardSession after its actual type. Extract agent wire values from LinkSync. No new framework or runtime dependency. |

### Separation from server/CLI

| Project | Observed practice |
| --- | --- |
| Happy | [Repository map](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/README.md) distinguishes native iOS/Android from happy-cli, happy-server, shared wire and push server. [Workspace manifest](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/package.json) keeps JS services independent of native Swift. |
| Immich | [Repository front page](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/README.md) separates mobile from server, web, machine-learning and packages/cli; [mobile manifest](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/pubspec.yaml) declares its own dependencies. |
| LocalSend | [Architecture and protocol](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md) describes direct HTTPS peer communication, app/, cli/, packages/ and optional signaling server. A local transfer does not require a central service. |
| Reflex after T31 | App builds only Swift app and two local packages. agent/ is MCP/CLI, link/ is the Mac service, relay/ is a separate relay, dist/ is the small npx distribution. These paths and their delivery are untouched. |

### Lint and formatting

| Project | Observed practice |
| --- | --- |
| Happy | [Native rules](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/AGENTS.md) emphasize typed boundaries, main-thread budgets and deterministic layout. The inspected tree has no native SwiftLint/swift-format config or iOS Actions formatting job; do not attribute one to it. |
| Immich | [Analyzer rules](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/analysis_options.yaml) includes flutter_lints, explicit async/correctness rules and generated exclusions. [Executable tasks](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/mise.toml) runs format, fatal-info analysis and DCM. [Contributor guide](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/README.md) explains its open-source DCM license. |
| LocalSend | [Analyzer config](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/app/analysis_options.yaml) defines Dart rules; [PR CI](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/workflows/ci.yml) runs dart format with failure on changes and flutter analyze. |
| Reflex after T31 | Strict Xcode-bundled swift-format checks all app/package/test Swift with four spaces and 120 columns; code formatted in this change. Swift 6 complete concurrency checking remains enabled. Both run through CI compilation; no baseline or disabled checks. No paid DCM dependency. |

### Tests

| Project | Observed practice |
| --- | --- |
| Happy | [Test targets](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/Package.swift) cover crypto/wire/store/sync/layout; [Build/test guide](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/AGENTS.md) documents swift test and Simulator-hosted UIKit tests plus fixtures. |
| Immich | [Test workflow](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/test.yml) runs mobile Flutter tests; [Mobile test task](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/mise.toml) executes flutter test. The commented mobile E2E workflow block is not a running check. |
| LocalSend | [Test job](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/workflows/ci.yml) runs Flutter app/package tests and Rust core/signaling tests. [Contribution rules](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/CONTRIBUTING.md) asks for tests with changes. |
| Reflex after T31 | Wire the existing precise-erase stroke-identity regression into the shared Reflex scheme and PR CI. It was present as an SPM XCTest but app builds alone did not run it. Do not inflate coverage with formatter tests. Manual drawing/pairing/Send and code-exhaustion remain essential checks; one passing ink test is not proof of them. |

### CI builds

| Project | Observed practice |
| --- | --- |
| Happy | [Available release workflow](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/.github/workflows/release-happy-cli.yml) is for CLI, not native iOS. [Native guide](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/README.md) documents local/macOS and Linux commands. No native iOS PR Actions build was found in the inspected tree. |
| Immich | [Mobile build workflow](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/build-mobile.yml) includes signed iOS builds, provisioned runners and API-key secrets; its iOS job excludes fork PRs. [Analysis workflow](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/static_analysis.yml) routes mobile checks separately. |
| LocalSend | [PR workflow](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/workflows/ci.yml) checks formatting, analysis, tests and package versions on Ubuntu. [Release workflow](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/workflows/release.yml) dispatches platform packaging. These are not an unsigned iOS PR build. |
| Reflex after T31 | Dedicated iPad workflow runs on every PR without path/fork filtering and pushes to main: GitHub-hosted macos-26, selected Xcode 26.4.1, format lint, Release Simulator build and Debug hosted tests. contents:read only; no signing secrets. Keep xcresult artifacts seven days. This improves on the observed native PR coverage rather than copying a gap. |

### Signing and TestFlight/App Store

| Project | Observed practice |
| --- | --- |
| Happy | [Production continuation](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/README.md) requires the existing app/team/keychain identity and manual distribution signing with an ASC API key. [Release procedure](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/.agents/skills/release/SKILL.md) separates build/upload from public release and records source/binary identity. |
| Immich | [Fastlane lanes](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/ios/fastlane/Fastfile) obtain an ASC API key outside Git, fetch profiles, build/export and upload to TestFlight. Production and dev bundle/group IDs are distinct. [Workflow](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/build-mobile.yml) installs signing inputs as secrets. |
| LocalSend | [Distribution ownership](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/CONTRIBUTING.md) explicitly lists App Store distribution as manual. [iOS build helper](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/support/scripts/compile_ios.sh) runs Flutter/CocoaPods and builds an IPA; it does not document an automated TestFlight lane. |
| Reflex after T31 | RELEASING.md and archive.sh live in the repo. Manual signing prerequisites are explicit and transferable; archive/export never upload. Document Apple validation/upload, Public external group and Beta App Review separately. Keys/certs stay outside Git. Signed export/upload not executed in T31; no claim that simulator CI proves signing. |

### Versioning/build numbers

| Project | Observed practice |
| --- | --- |
| Happy | [Versioning rules](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/AGENTS.md) uses CalVer YYYY.M.C, shared across variants; store build number remains explicit. [Release identity](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/README.md) records the next native build and preserves the existing app listing. |
| Immich | [pubspec](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/pubspec.yaml) holds app version; [Release lane](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/ios/fastlane/Fastfile) extracts its public version and chooses latest_testflight_build_number + 1. |
| LocalSend | [pubspec version](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/app/pubspec.yaml) encodes version+build. [Packaging checks](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/workflows/ci.yml) compare app, CLI and platform packaging versions. |
| Reflex after T31 | project.yml owns MARKETING_VERSION and CURRENT_PROJECT_VERSION; generated plist now references them. Preserve effective 1.0 (baseline plist had 1.0 despite project setting 0.1). Require explicit greater unused BUILD_NUMBER checked against ASC, so local default 1 cannot silently be reused. Do not add tags/releases under this ticket. |

### Links to app and first-run setup

| Project | Observed practice |
| --- | --- |
| Happy | [Front page](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/README.md) puts App Store/Play download buttons near the top, explains the CLI installation, and maps sibling projects. |
| Immich | [Front page](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/README.md) links its website/docs and demo alongside self-hosting information. Its [mobile download partial](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/docs/docs/partials/_mobile-app-download.md) supplies direct App Store, Play and APK links. |
| LocalSend | [Downloads](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md) offers platform download links including App Store, then explains direct local transfers and setup. |
| Reflex after T31 | iPad README prominently links https://testflight.apple.com/join/R81n88Re and explains external beta approval. Keep the npx one-liner plus “connect my iPad”; no additional onboarding requirement or service. Root front page is T29 ownership. |

### Build it yourself

| Project | Observed practice |
| --- | --- |
| Happy | [Native README](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/README.md) gives Swift/xtool commands and XcodeGen/open steps, with iOS 26/Swift 6.2 prerequisites and deeper [build instructions](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/AGENTS.md). |
| Immich | [Mobile README](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/README.md) links developer setup, describes structure and lists local static analysis commands. |
| LocalSend | [Getting started/building](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md) identifies pinned Flutter/FVM plus Rust, dependency installation and flutter run/IPA build. [Contributor setup](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/CONTRIBUTING.md) lists code generation. |
| Reflex after T31 | README gives fresh-clone prerequisites, Xcode selection, XcodeGen, open/run an iPad Simulator, unsigned CLI build, full local check, code map and troubleshooting context. No server, Node, Rust, account or distribution key required for Simulator. RELEASING.md covers authorized distribution separately. |

## Reflex implementation and boundaries

- [iPad README](../../apps/ipad/README.md), [release guide](../../apps/ipad/RELEASING.md),
  [project source](../../apps/ipad/project.yml), [workflow](../../.github/workflows/ipad.yml),
  [check script](../../apps/ipad/scripts/check.sh), [archive script](../../apps/ipad/scripts/archive.sh).
- The app’s visual code receives formatter-only changes. BoardSession is a
  filename correction; board persistence/library and agent-value extractions
  move existing declarations without changing them. There is no new migration,
  network behavior, wire value, screen, brand color or dependency.
- Generated Xcode project and shared scheme are committed so a newcomer can
  inspect targets immediately; XcodeGen remains the source of truth.
- Root docs, MIT license, repository policies and front-page distribution are
  owned by T29. Mac/server/CLI quality is T30. None is silently changed here.
- The arrow assets, relay defaults, pairing protocol, Send durability and
  wait_for_user semantics are unchanged. The npx branch, dist/, package.json,
  server deployment and dependency size are outside this diff.

## Verification and remaining gaps

See [T31 verification](ipad-quality-verification.md) for commands, results,
review findings and the specific manual checks that could not be completed.
Do not call this a complete equivalence audit while those checks remain open.
The code and release tooling can be reviewed independently from the missing
hands-on behavior evidence; neither lint nor CI substitutes for that evidence.
