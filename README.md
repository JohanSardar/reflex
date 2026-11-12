<img src="assets/icon.svg" width="64" height="64" alt="">

# Reflex

Created in [T3 Code](https://t3.codes).

Reflex is a Pencil-first iPad canvas that AI agents reach over MCP or a CLI.

- Source: https://gitlab.com/johansardar/reflex (`git clone https://gitlab.com/johansardar/reflex.git`)
- Protocol: [protocol/](protocol/) and [docs/SPEC.md](docs/SPEC.md)

## Use it

You need a Mac with Node 26 and git, and the Reflex Canvas app on your iPad.

```sh
git clone https://gitlab.com/johansardar/reflex.git && cd reflex
node agent/bin/reflex.mjs setup
```

1. **Run setup.** It installs what it needs and puts `reflex` on your PATH. It adds Reflex to Claude Code and Codex if you have them, and starts the Reflex Link in the background. Then it shows a QR code.
2. **Scan.** On the iPad, open Reflex Canvas, tap Connect, then Scan the QR code. The terminal says "Paired with …".
3. **Tap Allow.** Start Claude Code (`claude`) or Codex and ask it to draw something on your iPad. The first time, the iPad asks "Allow … to use your Spaces?". Tap Allow.

That's all. `reflex pair` shows a new code at any time, from any terminal. A second iPad paired with it syncs your Spaces, but approving Agents stays with the first (so an Agent can't pair a device of its own and approve itself); your first iPad hears of each new one. The Link keeps running when you close the terminal, and `reflex mcp` starts it again after a restart. `reflex link stop` stops it.

For Sends pushed into Claude Code as new turns, start it with `claude --dangerously-load-development-channels server:reflex`.

### If it doesn't connect

1. **The iPad says "This Mac's Link changed. Scan its code again."** The Link on your Mac was reset or reinstalled, so it has a new identity. Run `reflex pair` and scan the code. Spaces the iPad kept from before stay on the iPad only.
2. **The iPad says "Offline" and never connects.** Your Wi-Fi keeps devices apart (common on campus, hotel and guest networks), or the iPad is on another network. Setup builds the peer-to-peer Wi-Fi helper on a Mac with Xcode's command-line tools (`xcode-select --install`), so the iPad reaches the Mac directly with Wi-Fi on and no shared network. Keep both near each other, then run `reflex link stop` and `reflex pair`. `reflex link status` shows each path.
3. **The Agent keeps saying it's waiting for approval.** The question is on the iPad, under "Allow … to use your Spaces?". Open Reflex Canvas and tap Allow; the Agent gets in on its next call. If the iPad shows no question, it may be paired with an older Link (see 1). `reflex link agents` lists what the Link is waiting for, and `~/.reflex/link/link.log` says why each connection was refused and what to do.
