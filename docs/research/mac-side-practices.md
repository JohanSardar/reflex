# How Happy, Immich and LocalSend keep their server and CLI code, and how Reflex's Mac side compares

Checked on 2026-11-16 against each project's `main` branch. "Mac side" means Reflex's `agent/` (the MCP server and
CLI), `link/` (the Mac background service) and `relay/` (the forwarding server), plus the `dist/` build that
`npx -y "github:JohanSardar/reflex#npx" mcp` runs. The iPad app is a separate write-up.

- **Happy** ([slopus/happy](https://github.com/slopus/happy)): an open-source app for Claude Code and Codex, with a
  CLI, a relay server and native mobile apps. It is the closest to Reflex in what it does.
- **Immich** ([immich-app/immich](https://github.com/immich-app/immich)): a self-hosted server with a CLI, a web app
  and a mobile app. It is the largest and most process-heavy of the three.
- **LocalSend** ([localsend/localsend](https://github.com/localsend/localsend)): a Flutter app on a Rust core, with
  a CLI and a signaling server. Like Reflex, its devices find each other nearby.

## At a glance

| Practice | Happy | Immich | LocalSend | Reflex before | Reflex now |
| --- | --- | --- | --- | --- | --- |
| Lint | none configured | ESLint, type-aware, `--max-warnings 0` | `flutter analyze`, clippy | none | Biome recommended rules, warnings fail |
| Formatting | none | Prettier, width 120 | `dart format --set-exit-if-changed` | none | Biome formatter, width 120, checked |
| Types | `strict` + `noImplicitReturns` | `strict` | Dart analyzer | `strict` (Link and Relay); the Agent layer separate | `strict` + unused/returns/override/fallthrough flags, one shared config |
| Tests | Vitest, unit + integration | Vitest unit/medium/e2e, Playwright | `flutter test`, `cargo test` | `node:test` against a real Link, run by hand | the same tests, on every PR on Linux and macOS |
| CI on PRs | none (on purpose) | many path-filtered jobs | 4 jobs | none for the Mac side | 6 jobs, free runners |
| Releases | manual workflow, smoke-installs the tarball | one version, prepared by a workflow | release-drafter, version-match check | `npx` branch copied from `main` | the same, plus version-match and dist/ checks on PRs |
| Logging | file-only debug log in the CLI; pino on the server | Nest logger, global error interceptor | `logging`, `tracing`, `thiserror`/`anyhow` | injected loggers, file logs, structured errors | unchanged (it already matched), now documented |
| Dependencies | one lockfile, `--frozen-lockfile` | Renovate, `.nvmrc`, mise pins | one lockfile per language, Dependabot for Actions | exact versions, one lockfile | the same, `npm ci` in CI, `engines`, Actions pinned by SHA, one unused dependency removed |
| Package docs | README + CLAUDE.md per package, `docs/` | developer docs site, package READMEs | AGENTS.md path table | short READMEs, partly change notes | READMEs with a code map, logs/errors and how to develop |

## 1. Code layout

**Happy.** A pnpm monorepo. The JavaScript packages are under `packages/`: `happy-cli`, `happy-server`, `happy-wire`
(shared schemas), `happy-push-server` and `happy-server-self-host`
([pnpm-workspace.yaml](https://github.com/slopus/happy/blob/main/pnpm-workspace.yaml)). The native iOS and Android
apps and a Rust port of the server sit beside them
([happy-server-rs/Cargo.toml](https://github.com/slopus/happy/blob/main/packages/happy-server-rs/Cargo.toml)).

**Immich.** One folder per product (`server/`, `web/`, `mobile/`, `machine-learning/`, `e2e/`, `docs/`) and small
packages under `packages/` ([packages/cli](https://github.com/immich-app/immich/tree/main/packages/cli), `sdk`,
`plugin-*`), tied together by [pnpm-workspace.yaml](https://github.com/immich-app/immich/blob/main/pnpm-workspace.yaml)
and a mise monorepo config ([mise.toml](https://github.com/immich-app/immich/blob/main/mise.toml)).

**LocalSend.** A Cargo workspace (`cli`, `packages/core`, `server`) beside a pub workspace (`app`, two packages)
([Cargo.toml](https://github.com/localsend/localsend/blob/main/Cargo.toml),
[pubspec.yaml](https://github.com/localsend/localsend/blob/main/pubspec.yaml)).
[AGENTS.md](https://github.com/localsend/localsend/blob/main/AGENTS.md) has a table of what each path is and which way
the dependencies point.

**Reflex.** An npm workspace with three packages, `agent/`, `link/` and `relay/`
([package.json](../../package.json)), next to `apps/ipad/`. Each package has a single job, and inside each the folders
are split by concern (`pairing/`, `sync/`, `storage/`, `transports/`, `adapters/` in the Link; `domain/`, `node/`,
`cloudflare/` in the Relay). **Now:** each package README has a path table like LocalSend's
([agent](../../agent/README.md), [link](../../link/README.md), [relay](../../relay/README.md)), and the four files
without a header comment have one.

## 2. How the server or CLI is separated from the app, and how the app finds it

**Happy.** The CLI and the server share one wire package,
[`@slopus/happy-wire`](https://github.com/slopus/happy/blob/main/packages/happy-wire/package.json). It exists because
the schemas used to be duplicated and drifted apart
([docs/happy-wire.md](https://github.com/slopus/happy/blob/main/docs/happy-wire.md)). The CLI pairs by printing a QR
code with its public key ([src/ui/auth.ts](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/ui/auth.ts)).
After that, everything goes through the server as a relay, encrypted on the client
([docs/encryption.md](https://github.com/slopus/happy/blob/main/docs/encryption.md)).

**Immich.** An OpenAPI spec is the contract
([open-api/](https://github.com/immich-app/immich/blob/main/open-api/immich-openapi-specs.json)). The TypeScript SDK
and the Dart client are generated from it, and a PR fails if the generated code is out of date
([test.yml](https://github.com/immich-app/immich/blob/main/.github/workflows/test.yml)). The CLI logs in with a server
URL and an API key ([auth.ts](https://github.com/immich-app/immich/blob/main/packages/cli/src/commands/auth.ts)).

**LocalSend.** The whole protocol is the Rust `core` crate, which has no Flutter dependency
([packages/core](https://github.com/localsend/localsend/blob/main/packages/core/Cargo.toml)). Both the app (through
flutter_rust_bridge) and the CLI ([cli/Cargo.toml](https://github.com/localsend/localsend/blob/main/cli/Cargo.toml))
use it. Peers find each other with UDP multicast and are identified by their certificate fingerprint.

**Reflex.** Short-lived surfaces (the MCP server, the CLI) talk to one long-lived Link over a local Unix socket
([agent/src/host/rpc.ts](../../agent/src/host/rpc.ts)). The Link holds the data and reaches the iPad over LAN,
peer-to-peer Wi-Fi or the Relay. The iPad pairs by typing a 6-digit code the agent gives out, checked without sending
it ([link/pairing/handshake.ts](../../link/pairing/handshake.ts)). This sits between LocalSend's nearby discovery and
Happy's relay. **Before:** the Agent layer imported the Send's types from the Link (`agent/src → link/storage`),
although the Link is meant to depend on the Agent layer and not the other way round. **Now:** the Send's shape lives
in [agent/src/store.ts](../../agent/src/store.ts), the Link imports it from there, and nothing in `agent/src` imports
`link/`. The relay's wire is versioned (`reflex-relay/v0`). Happy's lesson about one shared wire package applies too:
the iPad's Swift side copies the wire by hand, which a later ticket could check.

## 3. Lint and formatting

**Happy.** No lint or formatter config anywhere. `eslint` is a devDependency of the CLI, but nothing runs it
([happy-cli/package.json](https://github.com/slopus/happy/blob/main/packages/happy-cli/package.json)).

**Immich.** A type-aware ESLint flat config with typescript-eslint, unicorn and import rules
([server/eslint.config.mjs](https://github.com/immich-app/immich/blob/main/server/eslint.config.mjs)), run with
`--max-warnings 0`. Formatting is Prettier with a line width of 120
([server/.prettierrc](https://github.com/immich-app/immich/blob/main/server/.prettierrc)). Both run in CI, and a
label makes a bot reformat a PR ([fix-format.yml](https://github.com/immich-app/immich/blob/main/.github/workflows/fix-format.yml)).

**LocalSend.** `flutter_lints` plus extra rules
([analysis_options.yaml](https://github.com/localsend/localsend/blob/main/app/analysis_options.yaml)). CI runs
`dart format --set-exit-if-changed`, `flutter analyze` and clippy
([ci.yml](https://github.com/localsend/localsend/blob/main/.github/workflows/ci.yml)). Clippy warnings don't fail it,
and `cargo fmt` is left out because the tree isn't formatted yet.

**Reflex.** **Before:** nothing. **Now:** [Biome](https://biomejs.dev) (one pinned dependency for both lint and format)
with its recommended rules and a width of 120, configured per package like Immich's per-package ESLint configs
([agent/biome.json](../../agent/biome.json), [link/biome.json](../../link/biome.json),
[relay/biome.json](../../relay/biome.json)). `npm run lint` fails on any warning, as Immich's `--max-warnings 0` does.
No rule is turned off. The code was formatted once and every finding fixed:

- `return voidCall()` became a call and a `return`.
- Assignments inside conditions were taken out.
- `forEach` callbacks that returned values became `for` loops.
- `any` became a named `Json` type for wire objects ([agent/src/protocol.ts](../../agent/src/protocol.ts)), with one
  documented exception.
- Each `!` non-null assertion became a real check: `Catalog.pairedDevice` and `Catalog.knownAgent`, the typed code's
  `#liveTyped`, and the Relay passing the device that said hello.

Immich's type-aware ESLint rules (`no-floating-promises` and others) are the one thing not matched. They would bring
a second TypeScript toolchain beside the TypeScript 7 compiler this repo uses, for a codebase of about 7,700 lines.
Strict `tsc` (below) covers what they overlap with.

## 4. Type checking

**Happy.** `strict` plus `noImplicitReturns` in the CLI and the wire package; `noUnusedLocals`,
`noUnusedParameters` and `noFallthroughCasesInSwitch` are turned off explicitly
([happy-cli/tsconfig.json](https://github.com/slopus/happy/blob/main/packages/happy-cli/tsconfig.json)). The server
has only `strict` ([happy-server/tsconfig.json](https://github.com/slopus/happy/blob/main/packages/happy-server/tsconfig.json)).

**Immich.** `strict`, `nodenext` and `isolatedModules`, with unused code left to ESLint
([server/tsconfig.json](https://github.com/immich-app/immich/blob/main/server/tsconfig.json)). `tsc --noEmit` runs in
CI, on Windows too for the CLI.

**LocalSend.** `flutter analyze`, and `cargo check`/clippy for Rust
([ci.yml](https://github.com/localsend/localsend/blob/main/.github/workflows/ci.yml)).

**Reflex.** **Before:** `strict` everywhere, but the Agent layer had its own config, and the Link's lacked
`erasableSyntaxOnly`, although Node runs it by stripping types. **Now:** one shared [tsconfig.json](../../tsconfig.json)
that `agent/` and `relay/` extend, with `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUnusedLocals`,
`noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride` and `noFallthroughCasesInSwitch`. That is stricter
than Happy and Immich. Turning the flags on found dead code, now removed: unused imports, the Link's `#db` field, an
unused constant and parameter, and `Catalog.records()`, which had no callers.

## 5. Tests

**Happy.** Vitest, with a `unit` project and three serial integration projects
([vitest.config.ts](https://github.com/slopus/happy/blob/main/packages/happy-cli/vitest.config.ts)). Its guidance is
"No mocking - tests make real API calls" ([happy-cli/CLAUDE.md](https://github.com/slopus/happy/blob/main/packages/happy-cli/CLAUDE.md)).

**Immich.** Vitest in tiers. Unit tests, then *medium* tests against a real Postgres
([vitest.config.medium.mjs](https://github.com/immich-app/immich/blob/main/server/test/vitest.config.medium.mjs)),
then end-to-end tests against docker compose ([e2e/](https://github.com/immich-app/immich/tree/main/e2e)).

**LocalSend.** Flutter unit and widget tests ([app/test](https://github.com/localsend/localsend/tree/main/app/test/unit)),
Rust inline tests and integration tests ([packages/core/tests](https://github.com/localsend/localsend/tree/main/packages/core/tests)).

**Reflex.** `node:test`, with no test framework to install. The tests start a real Link in a temporary folder, the
way Happy's "no mocking" rule and Immich's medium tier ask
([link/test/](../../link/test)). **Before:** they ran only when someone remembered. **Now:** `npm test`, run on every
PR on Ubuntu and macOS with Node 22 (the oldest supported) and 24. Reflex proves the rest by using the real thing
(pairing, Send, `wait_for_user` on a Simulator), as Happy's contributing guide asks for videos and screenshots
([docs/CONTRIBUTING.md](https://github.com/slopus/happy/blob/main/docs/CONTRIBUTING.md)). No new tests were added just
to have more tests.

## 6. CI on every PR

**Happy.** None, on purpose: its [AGENTS.md](https://github.com/slopus/happy/blob/main/AGENTS.md) forbids `push` and
`pull_request` triggers because Actions minutes cost money. Checks run only when a release is cut
([release-happy-cli.yml](https://github.com/slopus/happy/blob/main/.github/workflows/release-happy-cli.yml)).

**Immich.** [test.yml](https://github.com/immich-app/immich/blob/main/.github/workflows/test.yml) runs on every PR. A
path filter picks the jobs: format, lint, types and tests per package, the CLI on Windows, generated clients up to
date, migrations and more. Actions are pinned by commit SHA.

**LocalSend.** [ci.yml](https://github.com/localsend/localsend/blob/main/.github/workflows/ci.yml) has four
`ubuntu-latest` jobs on every PR: format, analyze plus tests, Rust, and a packaging job that fails when the version
differs between files.

**Reflex.** **Before:** the only workflow copied `dist/` to the `npx` branch after a merge. **Now:**
[mac-side.yml](../../.github/workflows/mac-side.yml) runs on every PR that touches the Mac side, on GitHub's free
runners (free for public repositories, so Happy's cost reason doesn't apply):

- lint and formatting
- types
- one version everywhere ([agent/check-versions.mjs](../../agent/check-versions.mjs), after LocalSend's packaging job)
- `dist/` is the build of the sources, byte for byte, like Immich's generated-clients check
- the npx bundle stays under 1.5 MB
- the tests on four OS and Node pairs, each starting `dist/reflex.mjs`
- the Swift peer-to-peer helper builds

Actions are pinned by SHA, as Happy and Immich do. `npm run check` runs the same checks locally.

## 7. Releases and versioning

**Happy.** A manual workflow packs the CLI, smoke-installs the tarball outside the monorepo, publishes with npm
provenance, checks the publish and tags `cli-X.Y.Z`
([release-happy-cli.yml](https://github.com/slopus/happy/blob/main/.github/workflows/release-happy-cli.yml)).

**Immich.** One version across all packages, bumped by a dispatched workflow
([prepare-release.yml](https://github.com/immich-app/immich/blob/main/.github/workflows/prepare-release.yml)), with
release notes grouped by PR labels ([.github/release.yml](https://github.com/immich-app/immich/blob/main/.github/release.yml)).

**LocalSend.** The version lives in `pubspec.yaml`, is copied into the other files by hand, and CI checks they match.
release-drafter drafts the release ([release-drafter.yml](https://github.com/localsend/localsend/blob/main/.github/release-drafter.yml)).

**Reflex.** There are no tags or npm releases yet. Installs come from the `npx` branch, which
[npx-branch.yml](../../.github/workflows/npx-branch.yml) refreshes from `main` with `dist/reflex.mjs` and the
peer-to-peer helper. **Now:** Happy's "check what you ship" and LocalSend's version check happen on the PR, before the
merge. `dist/` must match the sources, the bundle must start, and the version must match in every `package.json` and
in `reflex --version`. Tagged releases with a changelog are the next step once the project starts versioning. That is
the owner's call, and this work published nothing.

## 8. Logging and errors

**Happy.** The CLI writes debug logs only to a file, so they never disturb the terminal Claude runs in
([src/ui/logger.ts](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/ui/logger.ts)). The server uses
pino ([sources/utils/log.ts](https://github.com/slopus/happy/blob/main/packages/happy-server/sources/utils/log.ts)).

**Immich.** A Nest logger with levels and request context
([logging.repository.ts](https://github.com/immich-app/immich/blob/main/server/src/repositories/logging.repository.ts)),
and a global [error interceptor](https://github.com/immich-app/immich/blob/main/server/src/middleware/error.interceptor.ts)
that turns unknown errors into a logged 500.

**LocalSend.** `package:logging` with `--verbose`
([init.dart](https://github.com/localsend/localsend/blob/main/app/lib/config/init.dart)), and `tracing`, `thiserror`
and `anyhow` in Rust, with a helper that prints the whole error chain
([util/error.rs](https://github.com/localsend/localsend/blob/main/packages/core/src/util/error.rs)).

**Reflex.** This already matched, so it is unchanged and now documented in the package READMEs:

- Like Happy, `reflex mcp` writes its wire log to a file and never to stdout, which carries MCP
  ([agent/src/surfaces/mcp.ts](../../agent/src/surfaces/mcp.ts)).
- Like Immich's interceptor, errors are structured: `ReflexError` gives an agent
  `{ reason, errors: [{ code, msg, fix }] }` ([agent/src/capabilities/index.ts](../../agent/src/capabilities/index.ts)).
  `LinkError` gives `{ reason, message, fix }`, and an unknown error is logged with its stack and returned as
  `internal` ([link/link.ts](../../link/link.ts)).
- Loggers are passed in rather than global, so the tests silence them.
- The Link logs a repeated refusal once per 10 minutes, with a count.

## 9. Dependency hygiene

**Happy.** One lockfile, installed with `--frozen-lockfile`, mostly caret ranges. No Renovate, Dependabot, `.nvmrc` or
`engines` ([package.json](https://github.com/slopus/happy/blob/main/package.json)).

**Immich.** Renovate ([renovate.json](https://github.com/immich-app/immich/blob/main/renovate.json)), Node pinned in
[.nvmrc](https://github.com/immich-app/immich/blob/main/.nvmrc), every tool pinned through mise, `engines` on the CLI,
and a minimum release age for new packages
([pnpm-workspace.yaml](https://github.com/immich-app/immich/blob/main/pnpm-workspace.yaml)).

**LocalSend.** One lockfile per language, toolchains pinned
([rust-toolchain.toml](https://github.com/localsend/localsend/blob/main/rust-toolchain.toml),
[.fvmrc](https://github.com/localsend/localsend/blob/main/.fvmrc)), and Dependabot for GitHub Actions only
([dependabot.yml](https://github.com/localsend/localsend/blob/main/.github/dependabot.yml)).

**Reflex.** Every dependency is pinned to an exact version, with one lockfile, which is stricter than Happy.
**Now:**

- CI installs with `npm ci`.
- `engines.node` says `>=22.18`, the first Node 22 that strips types without a flag, and CI tests that version line.
- Actions are pinned by SHA.
- `ajv`, listed in `agent/package.json` but never imported there, is removed.
- The new tool, Biome, is pinned to a release older than two weeks, in the spirit of Immich's minimum release age.

The npx install only downloads the `npx` branch (`dist/` and a small `package.json`), so none of the dev tools reach
users. The install is about 1.2 MB, as before. Not done, because those files are outside this work's folders: a
Dependabot config for Actions and npm (LocalSend's), and a `.nvmrc`.

## 10. Package-level docs

**Happy.** A README and a CLAUDE.md per package, and a [docs/](https://github.com/slopus/happy/tree/main/docs) folder on
protocol, encryption and architecture.

**Immich.** A developer docs site ([docs/docs/developer](https://github.com/immich-app/immich/tree/main/docs/docs/developer))
with architecture, setup and testing guides, and READMEs for the CLI and SDK packages.

**LocalSend.** A detailed [AGENTS.md](https://github.com/localsend/localsend/blob/main/AGENTS.md), a
[server/README.md](https://github.com/localsend/localsend/blob/main/server/README.md); no README in `cli/` or
`packages/core/`.

**Reflex.** Before, the READMEs were short and partly read as change notes ("No Rust kernel … remains"). Now each
package README says what the package is and how it fits with the others, maps every path, explains logs and errors,
and says how to develop and check it. Every source file opens with a comment saying what it is, and stale comments
pointing at the removed `link/sharing.ts` are fixed. The repository-wide docs ([ARCHITECTURE.md](../ARCHITECTURE.md),
[SPEC.md](../SPEC.md)) stay where they are.

## Verdict

Measured against Happy's CLI and server, Reflex's Mac side now has more checks: lint, format, strict types with the
unused-code flags, tests on every PR, a check that the shipped bundle is the build of the sources, a version-match
check, and pinned Actions. Happy runs none of these on PRs. Against Immich, Reflex is smaller but follows the same
habits that fit a project its size: warnings fail lint, one formatter, tests against the real thing, a generated
artifact checked in CI, SHA-pinned Actions and per-package docs. It doesn't need Immich's release tooling, Renovate,
CodeQL or multi-tier e2e suites yet. What's left is noted above: Dependabot, `.nvmrc`, tagged releases with a
changelog, and a check that the iPad's copy of the wire matches the Link's.
