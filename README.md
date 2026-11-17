# Reflex

Send your marks, words and screen from an iPad to Claude Code or Codex on your Mac. The agent answers in its own session; it cannot draw or edit the canvas.

## Connect

Add Reflex to your agent with one line (Node 22 or newer):

```sh
claude mcp add reflex -- npx -y "github:JohanSardar/reflex#npx" mcp
```

Other MCP harnesses (Codex, Cursor, …) take the same server command: `npx -y github:JohanSardar/reflex#npx mcp`. In Codex, set `tool_timeout_sec = 300`.

Then tell your agent "connect my iPad" (in Codex, "connect my iPad to Reflex"). It gives you a 6-digit code. Open Reflex on the iPad, tap **Pair with Mac**, and type it. The iPad looks for the Mac on the same Wi-Fi and nearby first. If the Mac isn't there, it looks through the relay, so the Mac can be anywhere. Typing the code also lets that agent in. Codes work once, for 10 minutes, and stop working after 5 wrong tries.

Sends then reach the agent through `wait_for_user`, in a plain `claude` session with no flags. The agent keeps waiting for the next Send by itself.

### Pushed Sends (optional, local)

Claude Code can also have each Send pushed in as a new turn, through a channel. Claude Code only loads channels from Anthropic's allowlist without a flag, so this needs a local setup:

```sh
node agent/bin/reflex.mjs setup          # from a checkout: PATH, Claude Code and Codex config, the Link
claude --dangerously-load-development-channels server:reflex
```

## The relay: pairing from anywhere

When the iPad and the Mac aren't on the same network, they meet through a relay. The free default is `wss://reflex.eilmer.si` and needs no setup.

**How it works.**
1. While a code is live, your Mac waits in the relay's pairing room. That room is shared by everyone and its name says nothing about any code.
2. The iPad joins the room and tries the code you typed with each Mac waiting there.
3. Each try runs CPace, a password check made for this: both sides prove they know the code without sending it or anything that reveals it. A Mac with a different code counts it as one wrong try, and after 5 its code stops working.
4. Once the code checks out, the devices swap their keys and move to your own room on the relay. Your boards and Sends then go back and forth there.

**Why the relay can't read anything.**
- **Content.** Everything between the iPad and the Mac is sealed with keys only those two devices have. The relay passes on bytes it can't open. If it changed one, the device would refuse the frame.
- **The code.** It never crosses the relay. Only CPace values do, and they show nothing about it.
- **Names.** Device and person names never cross the relay in the open. The relay does see device public keys, which are not secret: the key exchange needs them.
- **Impostors.** Nobody can pose as your Mac or iPad. Every connection must sign a fresh challenge with its device key, and your devices accept only each other's keys.
- **Strangers in your room.** Someone who joins your room hears nothing about who is there and can't reach anyone. Devices hear only from devices they chose to hear from.

What a relay does see: when devices connect, from which address, and how many bytes they send.

### Run your own relay

On any machine that's always on (your Mac works too), run one command (Node 22 or newer, and [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the free tunnel, `brew install cloudflared`):

```sh
npx -y "github:JohanSardar/reflex#npx" relay --tunnel
```

It prints the relay's address, like `wss://some-words.trycloudflare.com`. Give that address to the Mac with one setting in your agent's MCP config:

```sh
claude mcp add reflex -e REFLEX_RELAY=wss://some-words.trycloudflare.com -- npx -y "github:JohanSardar/reflex#npx" mcp
```

In Codex, add `env = { REFLEX_RELAY = "wss://some-words.trycloudflare.com" }` under `[mcp_servers.reflex]` in `~/.codex/config.toml`. If a Link is already running, stop it once so the agent restarts it with the setting: `npx -y "github:JohanSardar/reflex#npx" link stop`.

Nothing changes on the iPad. You still type just the code. Your Mac also waits on the default relay, but only to tell the iPad where your relay is.

A quick tunnel's address changes every time it starts. For a fixed address, run the relay without `--tunnel` behind HTTPS on your own domain, for example `caddy reverse-proxy --from relay.example.com --to :8787`, and use `REFLEX_RELAY=wss://relay.example.com`. The iPad needs `wss://`. `REFLEX_RELAY=off` turns the relay off, and then pairing and Sends work only nearby.

How Reflex compares with croc and Happy: [docs/research/relay-croc-happy.md](docs/research/relay-croc-happy.md).

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

No agent writing API, shared Spaces/invites, web viewer, author kit, protocol package, conformance suite, encrypted cloud log or cloud agent session remains. The full earlier product is preserved on branch `archive/canvas-v0`.

## Checks

```sh
npm install --no-audit --no-fund
npm run typecheck
```

There is no lint script. See [architecture](docs/ARCHITECTURE.md), [spec](docs/SPEC.md) and package READMEs. Relay changes are source-only: deploying reflex.eilmer.si requires the person's approval. Never change relay.eilmer.si DNS.
