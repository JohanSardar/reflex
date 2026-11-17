# T29 verification

Date: November 16, 2026. This is a documentation/community-files change. No app, protocol, package, distribution bundle or workflow code changed. No sol-loop was run because no code changed. Followed the agent-testing skill: existing checks and real client use, no new tests.

## Research

Read the public GitHub pages of Happy, Immich and LocalSend, their source READMEs, contribution guides, licenses, templates, selected workflows and component guides. Compared their practices to the baseline and resulting Reflex docs in [the research write-up](../../research/github-front-pages.md). References are pinned to inspected revisions where possible. This is not a source-code audit; T30/T31 own runtime quality work.

## Commands and actual results

| Check | Result |
| --- | --- |
| `npm install --no-audit --no-fund` | Passed: 146 packages added. npm noted three install scripts not yet approved; none were approved by this task. |
| `npm run typecheck` | Passed for root, agent and relay. There is no root lint script. No package code changed. |
| `xcodegen generate --spec apps/ipad/project.yml` | Passed; no tracked file changes. |
| `xcodebuild -project apps/ipad/Reflex.xcodeproj -scheme Reflex -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/reflex-t29-build CODE_SIGNING_ALLOWED=NO build` | `BUILD SUCCEEDED`. Build-only check, not a UI or device run. |
| README’s exact `claude mcp add reflex -- npx -y "github:JohanSardar/reflex#npx" mcp` | Passed in a fresh temporary project and `CLAUDE_CONFIG_DIR`. Normal Mac HOME was retained; existing user config was untouched. |
| `claude mcp get reflex` in that project/config | `Status: ✔ Connected`, stdio command `npx`, arguments `-y github:JohanSardar/reflex#npx mcp`. |
| Real `npx -y "github:JohanSardar/reflex#npx" mcp`, using a fresh npm cache and isolated `REFLEX_HOME` | JSON-RPC initialization succeeded in 5.9 s, server `reflex` 0.1.0. `tools/list` returned `connect, wait_for_user`. |
| Real MCP `connect` | Successful response with `code`, `expires_in_s`, `tell_the_person`, `next`; `isError: false`. Pairing code kept private. An initial validator incorrectly rejected the display space between digit groups; source inspection confirmed the intentional `123 456` display format. Correcting the check to ignore that space yielded `Six-digit pairing code returned: True` on a follow-up call. |
| Published install contents | The downloaded install contained the 1.1 MB CLI and 225 KB nearby Wi-Fi helper, with no iPad source. No bundle changed. This was a single cold download, not a performance benchmark. |
| `link status`, `link agents`, `link stop` through the published npx CLI, on the isolated profile | Passed. Status showed LAN and peer-to-peer listeners, zero paired devices and one pending receiver. Stop succeeded. |
| Codex config | TOML syntax and values checked against the current MCP implementation and CLI help. Did not launch an authenticated fresh Codex session or change the person’s config. |
| Relative docs/image links and pinned reference paths | 152 link/image targets checked against local files and the downloaded GitHub reference trees; no missing paths. External page/fragment checks are described below; this is not a claim that every reference project’s installation command was executed. |
| `git diff --check` | Passed. |

No new test suite was added or needed for Markdown/SVG/community templates. This branch’s baseline only has a main-push npx publishing workflow, not per-PR test CI. Package source is unchanged; package suites were not run as a substitute for the blocked user-flow check.

## Browser and visual evidence

Opened Happy, Immich and LocalSend on public GitHub. The T3 preview browser could read pages, but screenshot capture failed twice: **“The browser is not producing screenshot frames. For a desktop tab, show or restore the T3 Code window and try again.”** Switched to an isolated agent-browser session as permitted by the browser fallback rule. Captured Happy’s front page and Reflex’s baseline while logged out. No competing project’s screenshot was added to this repository.

The root README uses [the actual T25 iPad Simulator screenshot](../t25/restored-native-page.png), with an explicit earlier-capture caption and [provenance](../t25/verification.md). It shows native strokes, the connected Link and Send controls. It is not a new capture from T29. No drawing, product UI or screenshot was fabricated or retouched.

## Link and repository settings checks

- Opened the actual [TestFlight invite](https://testflight.apple.com/join/R81n88Re) in a logged-out browser. Apple displayed: **“This beta isn’t accepting any new testers right now.”** The README records this; successful installation is not claimed. The build submission date comes from the ticket, not an independent App Store Connect check.
- Opened the README’s [Node download page](https://nodejs.org/en/download): loaded correctly.
- Set repository description to “Draw, write and speak on your iPad. Send it to Claude Code or Codex on your Mac.”
- Set topics to `ipad`, `apple-pencil`, `claude-code`, `codex`, `mcp`, `model-context-protocol`, `end-to-end-encryption`, `swift`, `typescript`.
- Enabled private vulnerability reporting so SECURITY.md’s report destination is usable. Rechecked the setting using GitHub’s API.
- MIT license added as standard root `LICENSE`. Default-branch sidebar detection is a post-merge check; this PR must not be merged by this worker.

All three issue-template YAML files parsed successfully. The README’s Codex TOML parsed with the expected command, arguments and 300-second timeout.

The published npx branch’s existing package metadata still says `UNLICENSED` and contains an older source-account URL. T29 is restricted from changing package/distribution files; root MIT licensing is provided here, but distribution metadata needs the package owner’s follow-up.

## Dedicated device and blocked end-to-end check

Created **Reflex T29 iPad**, UDID `09F0D971-CB1D-4626-BEB9-946EBA875282`, iOS 26.4, iPad Pro 11-inch (M5), without opening or using another worker’s Simulator.

`device_open` returned **“No device 09F0D971-CB1D-4626-BEB9-946EBA875282 on 'This machine' (hostId local). Call device_list for current ids.”** Refreshed `device_list` as instructed; it still omitted the new device. Retried `device_open` once, got the same error, and stopped device operations as required. No UI automation through simctl, ssh or another session was used.

Therefore **not checked**: fresh Claude conversation saying “connect my iPad”, code entry in the T29 Simulator, live pairing, a real Send reaching that agent, fresh app screenshots, nearby versus relay pairing, speech transcription, offline/restart delivery. Prior T25 evidence is linked for provenance only and does not count as T29 verification.

## Guardrails

- Behavior unchanged by this diff: only root/community docs and images changed. Pairing, Send, wait loops, relay and iPad code were not edited.
- One-paste command preserved and actual registration/initialization checked. Install contents remain small; no source or build changes added install work.
- Same-Wi-Fi/nearby six-digit pairing remains documented and source untouched, but cannot be claimed live-verified in this run.
- No npm publication, image push, release, tag, deployment or DNS action. No paid service or trial. No password prompt or approval dialog was invoked.
- No key, token, private board content or live pairing code was printed or committed. The only UI evidence reused is already-public synthetic test ink.

## Outstanding acceptance

Current-app screenshots and the full new-user pairing/Send test remain blocked on device-tool discovery. Public default-branch README and MIT sidebar recognition remain pending merge. Do not call the ticket’s full polish/accuracy acceptance complete on the strength of the docs or typecheck alone.
