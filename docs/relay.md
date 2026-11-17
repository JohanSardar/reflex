# Relay and advanced connections

[Back to the quick start](../README.md#connect) · [Privacy and security](privacy.md)

The default relay needs no setup. This guide is for running your own relay or enabling optional Claude Code push channels.

## Pushed Sends (optional, local)

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
4. Once the code checks out, the devices swap their keys and move to your own room on the relay. Your Sends then travel over the authenticated, encrypted device connection.

**What device encryption protects.**

- **Content.** Everything between the iPad and the Mac is sealed with keys only those two devices have. The relay passes on bytes it can't open. If it changed one, the device would refuse the frame.
- **The code.** It never crosses the relay. Only CPace values do, and they show nothing about it.
- **Names.** Device and person names never cross the relay in the open. The relay does see device public keys, which are not secret: the key exchange needs them.
- **Impostors.** Every connection must sign a fresh challenge with its device key, and paired devices check the expected peer key. Protect the private keys stored on your devices.
- **Strangers in your room.** Someone who joins your room hears nothing about who is there and can't reach anyone. Devices hear only from devices they chose to hear from.

What a relay does see: when devices connect, from which address, and how many bytes they send.

### Run your own relay

On any machine that's always on (your Mac works too), run one command (Node 22 or newer, and [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the free tunnel, `brew install cloudflared`):

```sh
npx -y "github:JohanSardar/reflex#npx" relay --tunnel
```

It prints the relay's address, like `wss://some-words.trycloudflare.com`. Use the actual printed address in place of the example below. If Reflex is already registered in this project, first remove that registration with `claude mcp remove reflex -s local`, then add it again with the relay setting:

```sh
claude mcp add reflex -e REFLEX_RELAY=wss://some-words.trycloudflare.com -- npx -y "github:JohanSardar/reflex#npx" mcp
```

In Codex, add `env = { REFLEX_RELAY = "wss://some-words.trycloudflare.com" }` under `[mcp_servers.reflex]` in `~/.codex/config.toml`. If a Link is already running, stop it once so the agent restarts it with the setting: `npx -y "github:JohanSardar/reflex#npx" link stop`.

Nothing changes on the iPad. You still type just the code. Your Mac also waits on the default relay, but only to tell the iPad where your relay is.

A quick tunnel's address changes every time it starts. For a fixed address, run the relay without `--tunnel` behind HTTPS on your own domain, for example `caddy reverse-proxy --from relay.example.com --to :8787`, and use `REFLEX_RELAY=wss://relay.example.com`. The iPad needs `wss://`. `REFLEX_RELAY=off` turns the relay off, and then pairing and Sends work only nearby.

How Reflex compares with croc and Happy: [research/relay-croc-happy.md](research/relay-croc-happy.md).
