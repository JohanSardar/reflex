# @reflex/agent

The Agent layer: the MCP server and the `reflex` CLI that Agents use to work in
a Space (ARCHITECTURE §4, SPEC §11–§12). Both surfaces are thin. They forward
each call to one long-lived **host** process, which holds the Spaces in the Rust
kernel (through its WASM build) and holds the Inbox. A surface starts the host
when none is running. Until T6 connects the Link, the host is the stand-in: its
Spaces and Inbox are in memory and are lost when it exits.

```
claude / codex ──MCP stdio──▶ reflex mcp ─┐
claude / codex ──shell──────▶ reflex …   ─┼─ Unix socket + token ─▶ host: Core (capabilities) ─▶ kernel (WASM)
reflex dev person … (stand-in iPad)      ─┘                                                    ─▶ MemorySpaces, MemoryInbox, SvgRenderer
```

- `src/protocol.ts`: the 11 tools, their text from `protocol/tool-text`,
  their schemas from `protocol/generated/tools`, and Ajv validators.
  Six tools work here: `list_spaces`, `open_space`, `read`, `look`, `apply`
  and `wait_for_user`. The rest return `unavailable` ("not yet available").
- `src/capabilities/`: the capability table, one implementation behind both
  surfaces. `normalize.ts` repairs common op mistakes before validating.
  `bundle.ts` projects a frozen Send into a Send Bundle.
- `src/store.ts`: the §6 interfaces (`SpaceStore`, `Inbox`) and their
  in-memory implementations. T6 plugs in T5's durable ones.
- `src/render.ts`: the `Renderer` interface and a basic SVG→PNG renderer
  (resvg). The full headless renderer is T8.
- `src/host/`: the host process and the local RPC (newline-delimited JSON
  over `$REFLEX_HOME/host.sock`, with a 0600 token).
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
reflex spaces create demo
reflex elements apply demo --ops '[{"op":"add","id":"n-auth","type":"shape","shape":"rect","text":"Auth service"}]'
reflex look demo                         # writes a PNG under $TMPDIR/reflex/ and prints its path
reflex wait --timeout 300 &              # an Agent waiting for the person
reflex dev person circle demo "Auth service"
reflex dev person send demo --said "what's missing here?"
```

`reflex dev person` plays the person until the iPad connects. It can circle or
underline an Element (by ID or by its text) and press Send.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `REFLEX_HOME` | `~/.reflex/dev` | Profile directory: socket, token, logs (`host.log`, `mcp.log`) |
| `REFLEX_AGENT_NAME` | From the harness | The Agent's display name; its identity is derived from it. `--agent` overrides it for the CLI |
| `REFLEX_PERSON_NAME` | `You` | The stand-in person's name |
| `REFLEX_PROGRESS_S` | `15` | Seconds between progress notifications during `wait_for_user` |
| `REFLEX_MAX_WAIT_S` | 280 for Codex, none otherwise | The longest `wait_for_user` the MCP surface holds, kept under the harness's hard tool timeout |

Without a name, an MCP Agent is called "<harness> · <cwd basename>",
taken from the client's `clientInfo`. A CLI Agent is called "Codex CLI · …",
"Claude Code CLI · …" or "CLI · …", taken from the environment.

## Differences from the protocol

- The CLI adds a `file` path to `look` results and to Send Bundle images,
  because a shell can't receive image blocks.
- Agent Element IDs are kept as `<agent>/<id>` in the kernel and shown to
  other Agents as `<agent>:<id>`, because `/` is not allowed by the protocol's
  ID pattern.
