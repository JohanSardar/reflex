# Contributing to Reflex

Help make drawing, speaking and sending to an agent feel immediate and dependable. Documentation fixes, reproducible bug reports and focused code changes are welcome. For user setup, start with the [README](README.md#connect).

## Before making a change

Search [existing issues](https://github.com/JohanSardar/reflex/issues) first. Explain the problem and expected result. Discuss changes to pairing, approval, encryption, Send delivery or the relay before implementing a new design. Report vulnerabilities [privately](SECURITY.md).

Keep each PR focused. Preserve the one-paste install, nearby/code pairing, Send delivery and the agent’s `wait_for_user` loop. No artwork or generated UI should be presented as a real app screenshot. Use the hand-drawn arrow in `assets/icon.png`; the old red R is retired.

## Development setup

Use a Mac with Git and Node.js 22 or later. From a checkout:

```sh
npm install --no-audit --no-fund
npm run typecheck
```

There is no root lint script. Check the package you change for additional checks. The [agent](agent/README.md), [Link](link/README.md) and [relay](relay/README.md) guides explain their entry points. The [iPad guide](apps/ipad/README.md#build) covers Xcode, XcodeGen and the Simulator; the app requires iPadOS 26.

For experiments, use a separate Reflex profile so you don’t pair with or revoke your everyday devices:

```sh
REFLEX_HOME=/tmp/reflex-dev node agent/bin/reflex.mjs connect
```

That starts a separate Link. Don’t publish its pairing code, credentials or data. To stop that development Link:

```sh
REFLEX_HOME=/tmp/reflex-dev node agent/bin/reflex.mjs link stop
```

Changes to the agent or Link also need the prebuilt CLI refreshed with `npm run build`. Commit the resulting `dist/reflex.mjs`. The [npx workflow](.github/workflows/npx-branch.yml) updates the small install branch when its watched build/helper paths change on main. It does not publish to npm.

## Show that it works

Run the existing checks relevant to your change and include their command and result in the PR. Don’t weaken checks to make them pass. Prefer using the real app or a real protocol client over adding tests that mirror the implementation.

For a user flow, follow it from installation through the result in the recipient’s agent session. For pairing or delivery changes, include a Send, a reconnect/restart and the acknowledgement behavior. For UI changes, include an actual Simulator or device screenshot. State which device and version you used, and what you did not verify. Never use another contributor’s running Simulator; create a separate one.

For docs, copy commands from the rendered page, check relative links and external destinations, and review GitHub’s rendering at desktop and narrow widths. Clearly distinguish unavailable beta distribution from a broken link.

## Pull requests

Target `main`. Lead with what was broken or missing and the resulting behavior. Include evidence, any remaining limitations, and a linked issue when there is one. If you used an AI assistant, disclose it and verify its work yourself. You are responsible for the change.

This project is [MIT licensed](LICENSE). Keep third-party notices intact. A source PR does not authorize deployments, DNS changes, paid services, package publishing or store releases.
