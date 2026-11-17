# GitHub front pages and project standards

Research date: November 16, 2026. Scope: newcomer presentation, distribution, component boundaries, documentation, contributor tooling and visible quality practices. This is a source/documentation review, not an independent audit of these products’ security or correctness. No competing project’s copy, artwork or app UI is reused in Reflex.

The repositories have changed since the ticket was written. In particular, Happy now leads with Happy Engineering and a desktop app, and its mobile clients are native Swift and Kotlin. The observations below describe the inspected source, rather than assuming its earlier React Native layout.

## Sources and method

Read the rendered public GitHub pages, READMEs, repository file trees, contribution guides, licenses, issue templates and selected workflows/component guides. GitHub’s repository, topics and community-profile APIs supplied sidebar metadata and distinguished local files from inherited community defaults. Pin substantive observations to the inspected revisions:

| Project | Inspected revision | Public front page | Sidebar metadata |
| --- | --- | --- | --- |
| Happy | [`1d6d88c`](https://github.com/slopus/happy/tree/1d6d88c5e14cbfb98cad76881acd7ff171edb50c) | [slopus/happy](https://github.com/slopus/happy) | [Repository API](https://api.github.com/repos/slopus/happy), [topics](https://api.github.com/repos/slopus/happy/topics) |
| Immich | [`ff445d5`](https://github.com/immich-app/immich/tree/ff445d5fda8bf396e769df8977c316726dc25c9c) | [immich-app/immich](https://github.com/immich-app/immich) | [Repository API](https://api.github.com/repos/immich-app/immich), [topics](https://api.github.com/repos/immich-app/immich/topics) |
| LocalSend | [`d1e6198`](https://github.com/localsend/localsend/tree/d1e6198f401939a9b76854f406f7dbb27d67a808) | [localsend/localsend](https://github.com/localsend/localsend) | [Repository API](https://api.github.com/repos/localsend/localsend), [topics](https://api.github.com/repos/localsend/localsend/topics) |
| Reflex baseline | [`51de789`](https://github.com/JohanSardar/reflex/tree/51de789) | [Baseline README](https://github.com/JohanSardar/reflex/blob/51de789/README.md) | Description was empty; topics were empty; no root license. |

Live links and metadata may change after this research. A missing repository file is not proof that a project has no equivalent policy elsewhere.

## 1. Front page

**Happy.** Its [README](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/README.md) opens with a centered name/tagline, a product demo video and download buttons. A short “What you get” list explains models, subscriptions, open source, mobile encryption and multiplayer. Resource links and a repository map follow. It answers “what can I do?” before explaining internals. The playful tagline alone is less specific than the feature list; the sidebar supplies the concrete Claude/Codex positioning.

**Immich.** Its [README](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/README.md) combines a recognizable logo, explicit self-hosted photo/video tagline and large product screenshot. It quickly routes users to installation, documentation and a working demo. The mobile/web feature matrix clarifies capability differences; the backup warning appears before users entrust photos to it. Translation, activity and contributor sections come later.

**LocalSend.** Its [README](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md) starts with CI/translation/packaging badges and a plain description: nearby file/message transfer without internet. A contents list leads to screenshots, downloads, operation, dependencies and setup. It is longer than Happy’s page but explicitly signposted. Troubleshooting names real local-network failure modes.

**Reflex comparison.** The baseline had the core purpose in one sentence but no logo, screenshot or app link; most of the page explained relay internals and developer commands. The new [README](../../README.md) leads with the hand-drawn arrow, a specific action/result tagline, the TestFlight button, a real Simulator capture and the copyable connection command. Relay details move to a linked guide. The screenshot is an earlier native-app verification capture with provenance, not a new T29 run or staged Pencil artwork. Fresh current-app imagery remains a quality gap until the dedicated Simulator is accessible.

## 2. Downloads and badges

**Happy.** The [README’s download block](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/README.md) separates desktop from mobile with custom light/dark SVG buttons and links directly to Apple and Google listings. Store buttons include ratings. The original CLI has its own `npm install -g happy` instructions lower down, avoiding the impression that mobile installation also installs a desktop runtime.

**Immich.** The [front page](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/README.md) uses license and community badges, and sends installation to its docs. Mobile distribution has a reusable [download partial](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/docs/docs/partials/_mobile-app-download.md), embedded in the [mobile guide](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/docs/docs/features/mobile-app.mdx). Its [quick start](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/docs/docs/overview/quick-start.mdx) separates server setup from mobile use. A front page need not contain every store badge if the next destination is obvious.

**LocalSend.** Its [Download section](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md#download) is a platform/channel matrix: app stores, package managers and standalone artifacts. It explains the recommendation to use stores/package managers because the app has no auto-update. The compatibility table and [distribution ownership guide](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/CONTRIBUTING.md#distribution) resolve “which build should I use?” and “who maintains it?”.

**Reflex comparison.** The baseline provided only the Mac MCP install. Now the iPad TestFlight action is directly above setup, with an explicit iPadOS minimum and beta review status. The custom blue badge is ordinary linked SVG text, not a copied or falsely official App Store badge. No release, rating, CI or audit badge claims a status Reflex has not earned. On November 16 the [public invitation](https://testflight.apple.com/join/R81n88Re) displayed **“This beta isn’t accepting any new testers right now.”** The submitted beta is not yet a verified install path. Keep that limitation visible; don’t replace it with a fake App Store link.

## 3. App, local runtime and server boundaries

**Happy.** The [repository table](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/README.md#how-happy-fits-together) explicitly distinguishes this mobile/CLI/relay monorepo from the desktop app, agent runtime and website repos. Component guides identify the [native iOS app](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-ios/README.md), [CLI](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-cli/README.md) and [encrypted sync server](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/packages/happy-server/README.md). The server guide separates hosted defaults from optional self-hosting, and describes persistent storage and configuration. Happy wraps agent harnesses and synchronizes sessions; Reflex delivers iPad Sends into an existing MCP harness. These are related workflows, not interchangeable protocols.

**Immich.** The [architecture guide](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/docs/docs/developer/architecture.mdx) maps the mobile app, web client and backend. The [quick start](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/docs/docs/overview/quick-start.mdx) makes the server a prerequisite and walks the client toward that endpoint. The [mobile guide](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/mobile/README.md) is developer-facing, separate from user installation. This is a self-hosted media service with mobile clients, not a relay-only design.

**LocalSend.** Its [How It Works and dependency sections](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md#how-it-works) describe peer communication over REST/HTTPS and link the [protocol repository](https://github.com/localsend/protocol). Normal local transfer requires no central service. The same README treats the CLI as a separate terminal client, while its [server guide](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/server/README.md) covers a signaling server. “No central server for local transfer” should not be read as “there is no server code in the repo.”

**Reflex comparison.** The new root map distinguishes iPad, MCP/CLI, Mac Link, relay and the small distribution branch. The [privacy guide](../privacy.md) explains iPad → Link → approved receiver and the AI-provider boundary. [Advanced setup](../relay.md) keeps self-hosting optional. Reflex’s relay forwards live encrypted connections; it is not Immich’s durable photo server or Happy’s session store. Existing component READMEs remain owned by their code packages.

## 4. Documentation and navigation

**Happy.** The [resource row](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/README.md#resources) routes users to the website/docs and developers to a contribution guide. Its [docs index](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/docs/README.md) and package READMEs hold deeper implementation information. The docs website lives in a separate, explicitly linked repository.

**Immich.** Its [docs tree](https://github.com/immich-app/immich/tree/ff445d5fda8bf396e769df8977c316726dc25c9c/docs) separates overview, installation, features and developer material. The [developer setup](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/docs/docs/developer/setup.md) and architecture pages answer different needs from the user quick start. Docs have their own [build workflow](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/docs-build.yml).

**LocalSend.** Its [README](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md) retains practical setup, a troubleshooting matrix and build sections on one page; the [contribution guide](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/CONTRIBUTING.md) holds translations and distribution ownership. Protocol documentation is linked separately. Pinning Flutter with `.fvmrc` addresses a real version mismatch problem in source builds.

**Reflex comparison.** The baseline linked architecture/spec but lacked a user docs entry point. The new [docs index](../README.md) separates using, building and research. Troubleshooting covers project-scoped registration, Codex timeouts, local-network permissions, expired codes and stopped wait loops. Privacy describes storage, recipient access and metadata; the relay guide retains the former README’s advanced instructions. Older research/evidence is labeled historical rather than silently treated as current setup.

## 5. Contributing, security and templates

**Happy.** Its [contribution guide](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/docs/CONTRIBUTING.md) prioritizes bugs, UI, features and then refactors. It demands a short problem statement, focused PRs, real screenshots/video/log evidence and discussion before protocol/encryption changes. It explicitly supports AI-assisted workflows. The inspected [`.github` tree](https://github.com/slopus/happy/tree/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/.github) has no repository-local issue or PR template; no repository-local `SECURITY.md` appeared in the inspected tree. Don’t invent these as universal Happy practices.

**Immich.** Its [contribution guide](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/CONTRIBUTING.md) emphasizes small focused PRs, prior discussion and complete templates. It rejects LLM-generated contributions and communication except specified translation use; this is materially different from Happy. The [bug form](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/ISSUE_TEMPLATE/bug_report.yaml) asks for server and mobile versions, platform, reproduction and redacted configuration. The [issue routing config](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/ISSUE_TEMPLATE/config.yml) sends questions and features elsewhere; the [PR template](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/pull_request_template.md) structures submissions. Its [security.txt](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/web/static/.well-known/security.txt) points to private GitHub advisories and a security email, distinguishing product security from an instance administrator’s responsibility. Its [community API](https://api.github.com/repos/immich-app/immich/community/profile) also identifies an organization-level code of conduct.

**LocalSend.** The [contribution guide](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/CONTRIBUTING.md) covers development, translations, tests, distribution maintainers and private security email. It restricts AI contributions with exceptions for bug fixes, very small changes or demonstrated expertise. Separate [bug](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/ISSUE_TEMPLATE/bug_report.yml) and [feature](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/ISSUE_TEMPLATE/feature_request.yml) forms and [routing links](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/ISSUE_TEMPLATE/config.yml) channel reports. There was no repository-local PR template in the inspected tree.

**Reflex comparison.** The baseline lacked these files. New [CONTRIBUTING](../../CONTRIBUTING.md), [SECURITY](../../SECURITY.md), [issue forms](../../.github/ISSUE_TEMPLATE/) and [PR template](../../.github/pull_request_template.md) provide focused contribution guidance, environment/reproduction prompts, evidence requirements and private-report routing. Private vulnerability reporting was enabled and checked through GitHub’s API. Reflex adopts accountable verification and AI disclosure; it does not copy another project’s AI policy, promise response times or advertise a bounty.

## 6. License

**Happy:** [MIT](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/LICENSE), linked in the front-page resources and visible in GitHub’s sidebar.

**Immich:** [AGPL-3.0](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/LICENSE), also advertised near the top of its README. This is not the same permission model as MIT.

**LocalSend:** [Apache-2.0](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/LICENSE), detected by GitHub. It is permissive but distinct from MIT.

**Reflex comparison.** No baseline license granted reuse permission. The user chose MIT; the new root [LICENSE](../../LICENSE) uses that standard text and is linked from README and contribution guidance. GitHub’s default-branch license detection cannot be verified until this PR is merged. Don’t assume adding a badge changes GitHub’s actual license recognition.

## 7. Description and topics

The source links in the opening metadata table expose these settings directly; the public front pages render them in the sidebar.

| Project | Description at inspection | Topics at inspection | Reflex comparison |
| --- | --- | --- | --- |
| Happy | “Orchestrate Claude, Codex and Grok in one app. Open-source (MIT), reuses the subscriptions you already pay for.” | `agent-orchestration`, `ai-agents`, `claude-code`, `claude-desktop`, `codex`, `codex-cli`, `coding-agents`, `grok`, `hacktoberfest` | Names the supported agents and value. Reflex now names iPad, the input actions, Claude Code/Codex and Mac. |
| Immich | “High performance self-hosted photo and video management solution.” | `backup-tool`, `mobile-app`, `photo-gallery`, `photos`, `self-hosted`, `videos`, `flutter`, `nestjs`, `nodejs`, `google-photos-alternative`, `svelte`, `sveltekit`, `google-photos`, `photos-management`, `typescript`, `javascript` | Combines problem-space and stack discovery. Reflex uses relevant device, protocol and agent topics without claiming broader platforms. |
| LocalSend | “An open-source cross-platform alternative to AirDrop” | `flutter`, `file-sharing`, `dart`, `flutter-apps` | A recognizable comparison and restrained topics. Reflex describes its own workflow instead of borrowing an inaccurate AirDrop comparison. |

Reflex’s description is now **“Draw, write and speak on your iPad. Send it to Claude Code or Codex on your Mac.”** Topics: `ipad`, `apple-pencil`, `claude-code`, `codex`, `mcp`, `model-context-protocol`, `end-to-end-encryption`, `swift`, `typescript`. These are repository settings, not files; they were applied and read back separately from the PR.

## 8. Visible code-quality and helper practices

These observations concern explicit practices and automation. Stars, badges and a tidy README are not a code-quality audit.

| Reference evidence | Practice | Reflex action / boundary |
| --- | --- | --- |
| Happy [contribution rules](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/docs/CONTRIBUTING.md) | Real flow evidence, focused changes, review before risky architectural changes. | Require real usage evidence and explicit limits in contribution/PR guidance. Runtime fixes belong to T30/T31. |
| Happy [manual release workflow](https://github.com/slopus/happy/blob/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/.github/workflows/release-happy-cli.yml) and [workflow tree](https://github.com/slopus/happy/tree/1d6d88c5e14cbfb98cad76881acd7ff171edb50c/.github/workflows) | Distribution builds are explicit; at this snapshot do **not** assume automatic per-PR CI from the project’s popularity. | Preserve the existing small npx build. Add no publishing or paid workflow. T30/T31 own package checks/workflows. |
| Immich [static analysis](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/static_analysis.yml), [test workflow](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/test.yml), [OpenAPI check](https://github.com/immich-app/immich/blob/ff445d5fda8bf396e769df8977c316726dc25c9c/.github/workflows/check-openapi.yml) | Stack-specific checks and generated API drift checks; docs also have their own build gate. | Document the actual root typecheck, not an invented lint command. Preserve source/build responsibility in package guides. |
| LocalSend [CI](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/.github/workflows/ci.yml) | Format/analyze/tests for Flutter, Rust clippy/tests and packaging/version consistency. Comments explicitly identify areas not format-clean. | Report existing limitations honestly. Don’t claim tests or formatting are clean without executing the relevant check. |
| LocalSend [version guidance](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/README.md#getting-started) and [distribution map](https://github.com/localsend/localsend/blob/d1e6198f401939a9b76854f406f7dbb27d67a808/CONTRIBUTING.md#distribution) | Name tool versions and who maintains each distribution path. | State Node 22+, iPadOS 26+, repo/component owners and how npx is built. No unsupported OS claims or new registries. |

A deeper source audit of agent/Link/relay and Swift is intentionally outside this PR’s ownership; T30 and T31 run concurrently. This document does not certify that Reflex’s code matches those projects’ quality.

## Iteration and acceptance

1. **Baseline:** purpose sentence existed, but no app destination, product image, root license, support routing or sidebar metadata. Advanced internals obscured the first successful Send.
2. **First pass:** add identity, TestFlight, screenshot, exact setup, docs index and community files. Separate iPad installation from MCP registration and the optional relay.
3. **Accuracy pass:** verify project-local Claude registration with a fresh config, retain Codex’s 300-second timeout, make provider access and unencrypted local storage explicit, report TestFlight’s actual unavailable state, and describe workflow path triggers accurately.
4. **Visual pass:** inspect logged-out GitHub rendering against Happy and narrow-width wrapping. Keep the app button and quick-start link above the large screenshot. Use actual app evidence with provenance. Do not fabricate a polished Pencil board.
5. **Remaining acceptance:** the dedicated T29 Simulator was created but the device tools could not discover it, blocking fresh UI screenshots and the full pairing/Send flow. The public default page will remain the old README until merge. Those are outstanding checks, not passed requirements.

The written structure now answers purpose, app acquisition, connection, trust and repo ownership. Full “as polished and proven as the references” acceptance still depends on the blocked app check, current screenshots and post-merge default-page/license verification. See the [verification record](../evidence/t29/verification.md) for concrete output and limits.
