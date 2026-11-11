# @reflex/agent

The Agent layer: the MCP server and the `reflex` CLI that Agents use to work in
a Space (ARCHITECTURE §4, SPEC §11–§12). Both surfaces are thin. They forward
each call to the running **Reflex Link** (`reflex link`), which hosts the
capability table on its durable Spaces, Inbox and assets
([link/agent-host.ts](../link/agent-host.ts)). A surface never starts the Link:
without it, every call answers `unavailable` and says to run `reflex link`.

```
claude / codex ──MCP stdio──▶ reflex mcp ─┐                                     ┌▶ kernel (WASM): durable Spaces (SQLite journal)
claude / codex ──shell──────▶ reflex …   ─┴─ agent.sock + rpc.key + credential ─▶ Link: Core ─┼▶ durable Inbox, assets
                                                                                └▶ SvgRenderer (look, Send crops)
```

The first time an Agent calls, the Link asks the person: Allow on the iPad, or
`y` in the Link's terminal. The Agent waits (up to two minutes per call) and
sees no Space content until it is approved.

- `src/protocol.ts`: the 11 tools, their text from `protocol/tool-text`,
  their schemas from `protocol/generated/tools`, and Ajv validators.
  Six tools work here: `list_spaces`, `open_space`, `read`, `look`, `apply`
  and `wait_for_user`. The rest return `unavailable` ("not yet available").
- `src/capabilities/`: the capability table, one implementation behind both
  surfaces. `normalize.ts` repairs common op mistakes before validating.
  `bundle.ts` projects a frozen Send into a Send Bundle.
- `src/store.ts`: the §6 interfaces (`SpaceStore`, `Inbox`, `Assets`). The
  Link implements them on its storage.
- `src/render.ts`: the `Renderer` interface and a basic SVG→PNG renderer
  (resvg). The full headless renderer is T8.
- `src/host/`: the local RPC (newline-delimited JSON over
  `$REFLEX_HOME/agent.sock`, with the Link's 0600 `rpc.key`): `client.ts` for
  the surfaces, `server.ts` for the Link. Each Agent also presents a
  credential it keeps in `$REFLEX_HOME/agents/` (0600), which is what the
  person approves.
- `src/surfaces/`: `mcp.ts` (stdio MCP server) and `cli.ts`.

It runs as TypeScript on Node 26 (type stripping); there is no build step.
Run `npm install` at the repo root, and build the kernel's WASM once
(`npm run build -w @reflex/kernel`).

## Connect a harness

Claude Code:

```sh
claude mcp add reflex -- node /path/to/reflex/agent/bin/reflex.mjs mcp
# or, for one session:
claude --mcp-config '{"mcpServers":{"reflex":{"type":"stdio","command":"node","args":["/path/to/reflex/agent/bin/reflex.mjs","mcp"]}}}'
```

Codex (`~/.codex/config.toml`, or the same keys as `-c` flags):

```toml
[mcp_servers.reflex]
command = "node"
args = ["/path/to/reflex/agent/bin/reflex.mjs", "mcp"]
tool_timeout_sec = 300   # Codex cuts every call at this; progress does not extend it
```

To use the CLI, put `agent/bin` on the PATH or call
`node agent/bin/reflex.mjs`. Every command's `--help` works offline and prints
the same tool text the MCP surface sends.

See [docs/harness-notes.md](../docs/harness-notes.md) for what each harness
does with a long `wait_for_user`.

## Try it

```sh
reflex link                              # in its own terminal: the Link, with a pairing code for the iPad
reflex spaces create demo                # the Link asks you to approve this Agent: answer y

reflex elements apply demo --ops '[{"op":"add","id":"n-auth","type":"shape","shape":"rect","text":"Auth service"}]'
reflex look demo                         # writes a PNG under $TMPDIR/reflex/ and prints its path
reflex wait --timeout 300                # an Agent waiting for the person: circle something on the iPad and press Send
```

Without an iPad, start the Link with `reflex link --dev`; then
`reflex dev person circle demo "Auth service"` and
`reflex dev person send demo --said "what's missing here?"` play the person.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `REFLEX_HOME` | `~/.reflex/link` | The Link's profile directory: its socket, `rpc.key`, Agent credentials, `mcp.log` |
| `REFLEX_AGENT_NAME` | From the harness | The Agent's display name; its identity is derived from it. `--agent` overrides it for the CLI |
| `REFLEX_PROGRESS_S` | `15` | Seconds between progress notifications during `wait_for_user` |
| `REFLEX_MAX_WAIT_S` | 280 for Codex, none otherwise | The longest `wait_for_user` the MCP surface holds, kept under the harness's hard tool timeout |

Without a name, an MCP Agent is called "<harness> · <cwd basename>",
taken from the client's `clientInfo`. A CLI Agent is called "Codex CLI · …",
"Claude Code CLI · …" or "CLI · …", taken from the environment.

## Differences from the protocol

- An Element an answer adds without `at` (apply with `in_reply_to`) is placed
  next to the Send's first Mark, as `at: {near: "m1"}` would.
- The CLI adds a `file` path to `look` results and to Send Bundle images,
  because a shell can't receive image blocks.
- Agent Element IDs are kept as `<agent>/<id>` in the kernel and shown to
  other Agents as `<agent>:<id>`, because `/` is not allowed by the protocol's
  ID pattern.
