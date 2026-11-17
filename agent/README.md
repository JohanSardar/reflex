# Reflex agent receiver (`agent/`)

The part of Reflex an AI agent talks to: the `reflex` command, its MCP server (`reflex mcp`) and its CLI. It
receives the person's Sends from the iPad through the Link (`link/`) and hands them to Claude Code, Codex or any MCP
client. Its tools are `connect` (a 6-digit code to type on the iPad) and `wait_for_user` (the next Send). Agents can't
write to the canvas.

```sh
node agent/bin/reflex.mjs setup                  # first time: register Reflex with Claude Code and Codex, start the Link
node agent/bin/reflex.mjs mcp                    # the MCP server a harness runs
node agent/bin/reflex.mjs mcp --channel          # the same, and Sends pushed into Claude Code between waits
node agent/bin/reflex.mjs wait --timeout 0 --json
node agent/bin/reflex.mjs --help
```

People don't run these from a checkout. They paste `npx -y "github:JohanSardar/reflex#npx" mcp`, which runs
`dist/reflex.mjs`: everything here and in `link/` bundled into one file by `build.mjs`.

## How it fits together

Each MCP server or CLI command is a short-lived _surface_. It connects to the Link, the one long-lived process, over a
local Unix socket, presents the Agent's credential and forwards each tool call. The Link runs the capability table and
decides who may call it. The surfaces never touch the database or the iPad themselves.

| Path                         | What it is                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/reflex.mjs`             | The `reflex` entry point. `reflex link`, `reflex relay` and `reflex setup` load `link/` and `relay/`; every other command is a surface.                                             |
| `src/protocol.ts`            | The MCP contract: the tool names, their descriptions and input schemas, and the server instructions.                                                                                |
| `src/store.ts`               | What the Agent layer needs from its host: the Send's shape, the Inbox and the asset store.                                                                                          |
| `src/capabilities/`          | The capability table (`Core`) and the bundle a Send becomes for an agent (marks, targets, words, crops).                                                                            |
| `src/host/`                  | The local RPC between the surfaces and the Link: frames (`rpc.ts`), the surface side (`client.ts`), the Link side (`server.ts`), and starting the Link when none runs (`start.ts`). |
| `src/surfaces/`              | The MCP stdio server (`mcp.ts`) and the CLI (`cli.ts`).                                                                                                                             |
| `examples/webhook-claude.ts` | A webhook receiver that starts a Claude turn for each Send.                                                                                                                         |
| `build.mjs`                  | Builds `dist/reflex.mjs`.                                                                                                                                                           |

The Agent layer doesn't import the Link: `link/agent-host.ts` plugs the Link's storage into it.

## Logs and errors

`reflex mcp` writes what the harness does on the wire to a log file in the Link's home folder (`logPath()` in
`src/host/rpc.ts`), never to stdout, which carries the MCP protocol. A tool that fails returns
`{ ok: false, reason, errors: [{ code, msg, fix }], next }` as its result (`ReflexError`), so the agent reads what went
wrong and what to do. The CLI prints the answer on stdout and a one-line JSON error on stderr, and exits 0 on success,
1 on failure, 2 on a usage error and 130 when cancelled.

## Developing

From the repository root: `npm ci`, then `npm run check` runs every check CI runs on a PR (lint and formatting with
Biome, strict types, the tests, one version everywhere, and `dist/` being the build of the sources). `npm run format`
fixes the formatting. After changing anything here or in `link/`, run `npm run build` and commit `dist/` with it.
