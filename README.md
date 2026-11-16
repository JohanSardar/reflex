# Reflex

Send your marks, words and screen from an iPad to Claude Code or Codex on your Mac. The agent answers in its own session; it cannot draw or edit the canvas.

## Connect

Add Reflex to your agent with one line (Node 22 or newer):

```sh
claude mcp add reflex -- npx -y "github:jujdontbudge/reflex#npx" mcp
```

Other MCP harnesses (Codex, Cursor, …) take the same server command: `npx -y github:jujdontbudge/reflex#npx mcp`. In Codex, set `tool_timeout_sec = 300`.

Then tell your agent "connect my iPad" (in Codex, "connect my iPad to Reflex"). It gives you a 6-digit code. Open Reflex on the iPad, tap **Pair with Mac**, and type it. The iPad finds the Mac on the same Wi-Fi, and typing the code also lets that agent in. Codes work once, for 10 minutes, and stop working after 5 wrong tries.

Sends then reach the agent through `wait_for_user`, in a plain `claude` session with no flags. The agent keeps waiting for the next Send by itself.

### Pushed Sends (optional, local)

Claude Code can also have each Send pushed in as a new turn, through a channel. Claude Code only loads channels from Anthropic's allowlist without a flag, so this needs a local setup:

```sh
node agent/bin/reflex.mjs setup          # from a checkout: PATH, Claude Code and Codex config, the Link
claude --dangerously-load-development-channels server:reflex
```

## Receive a Send

```sh
reflex connect
reflex wait --timeout 0 --json
reflex mcp [--channel]
reflex link status
reflex pair                              # the live pairing code, from a terminal
```

`connect` gives the pairing code and `wait_for_user` receives Sends. An approved receiver can register a signed webhook with `reflex adapters add webhook --url <url>`. Acknowledge a Send with `wait_for_user(after: '<send>', timeout_s: 0)` and answer in your session.

`dist/reflex.mjs` is the whole CLI in one file, so `npx` can run it from GitHub with nothing to install. Rebuild it with `npm run build` after changing `agent/` or `link/`, and commit it. After a merge to `main`, a GitHub Action copies it to the `npx` branch, which holds only that file and `package.json` so the one-line install downloads about 1 MB.

## Repository

- `apps/ipad/`: iPad app, owned by T25 during the cut-down.
- `agent/`: MCP/CLI receivers and local RPC client.
- `link/`: pairing, approval, Mac connection, durable Inbox and delivery.
- `relay/`: authenticated forwarding of live encrypted device connections.

No agent writing API, shared Spaces/invites, web viewer, author kit, protocol package, conformance suite, encrypted cloud log or cloud agent session remains. The full earlier product is preserved on GitLab branch `archive/canvas-v0`.

## Checks

```sh
npm install --no-audit --no-fund
npm run typecheck
```

There is no lint script. See [architecture](docs/ARCHITECTURE.md), [spec](docs/SPEC.md) and package READMEs. Relay changes are source-only: deploying reflex.eilmer.si requires the person's approval. Never change relay.eilmer.si DNS.
