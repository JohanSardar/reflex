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
                                                                                └▶ SvgRenderer (headless look, Send crops)
```

The first time an Agent calls, the Link asks the person: Allow on the iPad, or
`y` in the Link's terminal. The Agent waits (up to two minutes per call) and
sees no Space content until it is approved.

- `src/protocol.ts`: the 11 tools, their text from `protocol/tool-text`,
  their schemas from `protocol/generated/tools`, and Ajv validators.
  All eleven work on both surfaces; the CLI names them in `reflex --help`
  (`read_me` is `reflex docs read`, `recipe` is `reflex recipes apply`,
  `exec` is `reflex elements exec`, `revert` is `reflex elements revert`,
  `request_attention` is `reflex spaces attention`).
- `src/capabilities/`: the capability table, one implementation behind both
  surfaces. `normalize.ts` repairs common op mistakes before validating.
  `bundle.ts` projects a frozen Send into a Send Bundle: the kernel's Marks
  (`Space.marks`), the transcript with each Mark's ID where it was drawn,
  crops, the person's changes and added files. `index.ts` also runs the
  `set` and `apply_recipe` Behavior actions as the Element's owner, and plays
  the person for `reflex dev person` on a Link started with `--dev`.
- `src/extensions.ts`: the built-in Recipes `recipe` applies (from
  [extensions/recipes](../extensions/recipes/)) and the Element type Guides
  `read_me("<type>")` returns, built from the protocol schema.
- `src/exec.ts`: the `exec` sandbox (QuickJS in WebAssembly, no clock,
  network or files, 5 s and 64 MB).
- `src/store.ts`: the §6 interfaces (`SpaceStore`, `Inbox`, `Assets`). The
  Link implements them on its storage.
- `src/render.ts`: the `Renderer` interface and the headless SVG→PNG
  renderer (resvg) `look` uses without an iPad: pictures from the asset
  store, Ink with pressure, Markdown headings and lists, file cards.
- `src/host/`: the local RPC (newline-delimited JSON over
  `$REFLEX_HOME/agent.sock`, with the Link's 0600 `rpc.key`): `client.ts` for
  the surfaces, `server.ts` for the Link. Each Agent also presents a
  credential it keeps in `$REFLEX_HOME/agents/` (0600), which is what the
  person approves.
- `src/surfaces/`: `mcp.ts` (stdio MCP server) and `cli.ts`.
- `src/library.ts`: the person's Library. `define` ops are checked like any
  extension before they are saved in the Space of kind `library`;
  `read_me("index")` lists every Library entry, and `read_me(<name>)` returns it.
- `src/extensions/`: extensions as files (`files.ts`) and their contract checks
  (`checks.ts`, `adapter.ts`), shared by `define` and `reflex test`.
- `src/author/`: the author kit (`reflex create`, `reflex test`, `reflex dev`),
  on an in-memory Space (`memory.ts`, `sandbox.ts`).
- `src/web/server.ts`: serves the web viewer (`apps/web`) and syncs kernel
  replicas to it; the Link and `reflex dev` both use it.

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

To have Sends pushed into a Claude Code session as new turns, so the Agent hears
from the person without sitting in `wait_for_user`, add `--channel` and start
Claude Code with channels on (a research preview, stdio only):

```sh
claude --dangerously-load-development-channels server:reflex \
  --mcp-config '{"mcpServers":{"reflex":{"type":"stdio","command":"node","args":["/path/to/reflex/agent/bin/reflex.mjs","mcp","--channel"]}}}'
```

Claude Code asks once to confirm the development channel. Each Send then
arrives as a `<channel source="reflex" space=… send=… kind=… from=…>` turn
holding the Send Bundle (its images are PNG files, in `images[].file`). An Agent
that is in `wait_for_user` still gets the Send there, and a Send whose push
fails stays in the Inbox for the next `wait_for_user`. `reflex mcp --channel`
opens no push target for other harnesses, or for a Claude Code session started
without `--channels`/`--dangerously-load-development-channels`, because Claude
Code would drop the push without saying so. See
[link/adapters](../link/adapters/contract.ts) for how pushes are kept.

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

## Author kit

For people and Agents who extend Reflex (ARCHITECTURE §5). These commands work
offline and need no Link.

```sh
reflex create recipe service-card        # or guide | embed | adapter; writes a working example
reflex test service-card.md              # the contract checks for its kind, then its saved examples
reflex dev service-card.md               # the playground in your browser (--no-open, --port <n>)
```

| Kind | Files | What `reflex test` checks |
|---|---|---|
| Guide | `<name>.md` with front matter `kind: guide` | name, summary, a heading, an example, size |
| Recipe | `<name>.md` with `kind: recipe` and fenced ```` ```json params ````, ```` ```json template ```` (and ```` ```json example ````) blocks | the params schema is in the protocol's subset; every `{{param}}` is declared and used; the filled template is applied to a fresh kernel Space, and its errors and lints are reported |
| Embed Template | `<name>/reflex.json`, `index.html`, `params.schema.json`, `guide.md` | params; every host the HTML loads from is allowed (its `allow` list or an approved CDN) and on TLS; it uses only the bridge; it registers Anchors |
| Send Adapter | `<name>/reflex.json`, `adapter.ts` (default export `{ name, config, deliver(bundle, { config, fetch, log }) }`) | it loads; `config` matches its schema; `deliver` handles the example Send Bundle against a recording `fetch`, over TLS |

`reflex dev` opens the web viewer on an in-memory Space with the extension on it
(a Recipe applied with its example parameters, an Embed Template saved and added
as an Embed). It reloads on every save and has three panes: what the Agent reads
(the calls a stand-in Agent made and their results), what a Send produces (draw
with the mouse, press Send: the Send Bundle and its images, the adapter's
requests, and what each Embed's Anchor resolver answered), and the contract
checks, lints and Anchors. **Save example** writes the last Send's strokes and
the Marks and Anchors they produced to `examples/`; `reflex test` replays each one
on a fresh Space and fails if the Marks change.

An Agent climbs the same ladder without the CLI: `apply`'s `define` op runs the
same Recipe and Embed checks. Errors reject the batch; warnings come back as lints.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `REFLEX_HOME` | `~/.reflex/link` | The Link's profile directory: its socket, `rpc.key`, Agent credentials, `mcp.log` |
| `REFLEX_AGENT_NAME` | From the harness | The Agent's display name; its identity is derived from it. `--agent` overrides it for the CLI |
| `REFLEX_PROGRESS_S` | `15` | Seconds between progress notifications during `wait_for_user` |
| `REFLEX_CHANNEL` | unset | `1` is the same as `reflex mcp --channel` |
| `REFLEX_MAX_WAIT_S` | 280 for Codex, none otherwise | The longest `wait_for_user` the MCP surface holds, kept under the harness's hard tool timeout |

Without a name, an MCP Agent is called "<harness> · <cwd basename>",
taken from the client's `clientInfo`. A CLI Agent is called "Codex CLI · …",
"Claude Code CLI · …" or "CLI · …", taken from the environment.

## Differences from the protocol

- An Element an answer adds without `at` (apply with `in_reply_to`) is placed
  next to the Send's first Mark, as `at: {near: "m1"}` would.
- The CLI adds a `file` path to `look` results, Send Bundle images and
  files `read` returns, because a shell can't receive image or file blocks.
  The schemas list it as CLI-only.
- MCP returns a non-text file from `read` as an embedded resource block.
