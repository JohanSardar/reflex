# Harness notes: what Claude Code and Codex do with a long `wait_for_user`

Measured on 2026-11-10 on macOS (Darwin 25.5) with **Claude Code 2.1.322** and
**Codex CLI 0.167.0**. Each harness ran against the T4 Agent layer (`reflex mcp`,
MCP SDK 1.32.2) in its own profile. Each row below comes from one real run.
`agent/src/surfaces/mcp.ts` logs every message the harness sends: initialize,
`_meta`, `notifications/cancelled` and stdin closing. It also logs every
progress notification it sends back. The host logs when a wait starts, is
cancelled, or loses its client. The quotes are taken from those logs and the
harness output. Re-check the numbers when either harness updates. They are not
guarantees.

## Summary

|                                     | Claude Code 2.1.322 | Codex 0.167.0 |
| ----------------------------------- | ------------------- | ------------- |
| MCP protocol it asks for            | `2025-11-25` (sends `server/discover` first, then `initialize`) | `2025-06-18` |
| Sends a progressToken               | Yes, on every `tools/call`, plus `_meta["claudecode/toolUseId"]` | Yes, on every `tools/call`, plus `_meta["x-codex-turn-metadata"]` |
| Default hard timeout per call       | Very large: about 27 h, above `wait_for_user`'s 3600 s maximum | **300 s** |
| Idle timeout (no response or progress) | 30 min for stdio (5 min for remote servers) | None |
| Progress extends the idle timeout   | **Yes** | No idle timeout to extend |
| Progress extends the hard timeout   | No | **No** |
| Change the hard timeout             | Per-server `"timeout"` (ms) in the MCP config, or `MCP_TOOL_TIMEOUT` (ms) | `tool_timeout_sec` on the server (`-c mcp_servers.reflex.tool_timeout_sec=900`) |
| Change the idle timeout             | Per-server `"timeout"`, or `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms; 0 disables) | n/a |
| On timeout                          | Hard: `notifications/cancelled`, reason `SdkError: Request timed out`. Idle: no cancel; it closes the server's pipe | `notifications/cancelled`, reason `MCP request cancelled by caller`, then a tool error |
| User cancel (Esc)                   | `notifications/cancelled`, reason `AbortError: user-cancel`; the server stays connected | `notifications/cancelled`, reason `MCP request cancelled by caller`; the server stays connected |
| Harness killed mid-wait             | stdin closes, the MCP process exits, and the host drops the wait. The Send stays in the Inbox for the next session | Same |
| What it does with the 26 KB `apply` schema | Defers MCP tools behind ToolSearch, so a schema is paid for only when the Agent loads that tool | Code mode: the Agent calls MCP tools from a JS `exec` tool. First-turn input was the same with and without Reflex (about 14.0k tokens) |

## Claude Code 2.1.322

**Binding.** It sends `server/discover` first. The SDK answers method-not-found,
and Claude Code then sends `initialize` with `protocolVersion: "2025-11-25"`.
clientInfo is `claude-code` (title "Claude Code"), and capabilities are `roots`
and `elicitation`. The 1.32.2 SDK accepts 2025-11-25 and answers with it.

**Timeouts.** These come from reading the binary and were confirmed by the runs
below:
- The hard limit is the per-server `timeout` (ms) if it is set, else
  `MCP_TOOL_TIMEOUT`, else a default of about 1e8 ms. It is capped at 2^31−1.
- The idle timeout is `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, with a default of
  30 min for stdio servers and 5 min for remote ones; 0 disables it. A
  per-server `timeout` also lifts it for that server.

| Run | Setting | Progress every | Result |
| --- | ------- | -------------- | ------ |
| c1 | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=20000` | 5 s | The full `timeout_s: 60` ran to `still_waiting`, with 12 progress notifications. **Progress resets the idle timer.** |
| c2 | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=20000` | 30 s | Aborted about 30 s in: *"MCP server "reflex" tool "wait_for_user" sent no response or progress for 30s; aborting. … set a per-server "timeout" (ms) … otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally (0 disables)."* It sent **no** `notifications/cancelled`; it closed the connection, and the host logged `client_closed` with the wait held. I set 20 s but it reported 30 s, so 30 s looks like a floor. |
| c3 | `MCP_TOOL_TIMEOUT=20000` | 5 s | `notifications/cancelled` `{"reason":"SdkError: Request timed out"}` at 20.0 s, despite 4 progress notifications. The Agent saw "timed out after 20s". **Progress does not extend the hard limit.** |
| Esc | Interactive session in tmux, Esc pressed mid-wait | 5 s | `notifications/cancelled` `{"reason":"AbortError: user-cancel"}`. The server stayed connected, and the host returned the wait as cancelled. |
| kill -9 | `claude` killed mid-wait | 5 s | The MCP process saw stdin close and exited. The host logged `client_closed` and `wait_cancelled`. A Send pressed afterwards stayed in the Inbox. A new `claude -p` session read it with `wait_for_user(timeout_s: 0)` (`s_d31bd709cf`, `redelivered: false`, because it was never delivered). |
| flow | Defaults, `REFLEX_PROGRESS_S=15` | 15 s | The Agent drew a diagram, called `look`, then `wait_for_user(timeout_s: 600)`. It held for 228.7 s with 16 progress notifications until the person circled "Auth service" and pressed Send. It answered beside the circle with `in_reply_to`, waited again, and got `still_waiting` after 30 s. |

**The schema.** Claude Code put the reflex tools behind ToolSearch. The Agent's
first step was
`ToolSearch select:mcp__reflex__apply,mcp__reflex__look,…`. The 43 KB of
tools/list (26 KB of it is `apply`'s input schema) is not in every request; the
Agent pays for it once it loads the tools.

## Codex 0.167.0

**Binding.** It sends `initialize` with `protocolVersion: "2025-06-18"`.
clientInfo is `codex-mcp-client` (title "Codex"), and capabilities are
`elicitation` and `experimental["codex/auth-change"]`. It does not send
`server/discover`. The binary also contains `2025-11-25` and `2026-07-28`
strings, but this build asks for 2025-06-18. The 1.32.2 SDK accepts it and
answers with it.

**Timeouts.** Every MCP call has one hard limit, `tool_timeout_sec`. When the
limit passes, Codex sends `notifications/cancelled`
`{"reason":"MCP request cancelled by caller"}`, and the Agent sees
*"tool call failed for `reflex/wait_for_user` … timed out awaiting tools/call
after Ns"*.

| Run | Setting | Progress every | Result |
| --- | ------- | -------------- | ------ |
| x1 | Defaults | 5 s | `timeout_s: 150` completed with `still_waiting`. |
| x2 | `tool_timeout_sec=240` | 5 s | `timeout_s: 150` completed. |
| x3 | `tool_timeout_sec=20` | 5 s | Cancelled at 20.0 s, despite progress. **Progress does not extend it.** |
| x4 | Defaults | none | `timeout_s: 150` completed with no progress, so there is **no idle timeout**. |
| x5 | Defaults | 15 s | `timeout_s: 900` was cancelled at **300.0 s**, after 19 progress notifications. **The default is 300 s.** |
| Esc | Interactive session in tmux, Esc pressed 9 s into a wait | 5 s | `notifications/cancelled` `{"reason":"MCP request cancelled by caller"}`. The server stayed connected. |
| kill -9 | `codex` killed 12 s into a wait | 5 s | The MCP process saw stdin close and exited. The host logged `client_closed` and `wait_cancelled`. A Send pressed afterwards was queued for that Agent. |

**Code mode.** In Codex 0.167 code mode is on by default; it is not set in this
machine's `config.toml`. The model doesn't call MCP tools directly. It writes
JavaScript for an `exec` tool, such as
`ALL_TOOLS.find(x => /open_space$/.test(x.name))` and
`tools[load("reflex_wait_tool")]({...})`. A long `wait_for_user` turns into a
background "cell" that the model polls with a `wait` tool. The 300 s limit
still applies to the MCP call under it. First-turn input was 14,035 tokens with
Reflex configured and 13,966–14,061 tokens without it. So, as with Claude Code,
the tool schemas are not in every request.

Codex followed the server instructions and called `read_me` first. It got
"not yet available" and went on, because the error's `fix` says to.

## Claude Code channels (push), 2.1.322

Measured on 2026-11-11 with T15's `reflex mcp --channel`, from the binary and
one interactive session in tmux against `reflex link --dev`.

- **Turning it on.** The server declares `capabilities.experimental["claude/channel"] = {}`.
  The session must also name it: `--channels <entries>` for approved channel
  plugins, or `--dangerously-load-development-channels server:<name>` for a
  server from the MCP config, which shows a confirmation dialog at startup.
  Claude Code skips the channel without telling the server when: the server is
  not in that list ("not in --channels list for this session"), the provider is
  Bedrock, Vertex or Foundry, an org policy lacks `channelsEnabled: true`
  (claude.ai Teams and Enterprise default off), or the connection negotiated a
  "modern" protocol revision with no unsolicited-notification path. With
  `2025-11-25` it registered: the debug log says
  `MCP server "reflex": Channel notifications registered`.
- **The message.** `notifications/claude/channel` with
  `{ content: string, meta?: Record<string, string> }`. Meta keys must match
  `^[a-zA-Z_][a-zA-Z0-9_]*$`; others are dropped. Claude Code queues it as a
  prompt with priority "next", shown as
  `<channel source="reflex" space="plan" send="s_…" kind="send" from="…">…</channel>`.
  Content is text only, so the surface writes the Bundle's crops to PNG files and
  puts their paths in `images[].file`.
- **No receipt.** Claude Code doesn't answer a channel notification. The surface
  counts a push as done once it is written to the pipe; the Agent acknowledges
  it the usual way (`in_reply_to`, `after`).
- **The run.** Claude drew a diagram and ended its turn, having called only
  `open_space` and `apply`. The person circled "Auth service" and pressed Send
  48 s later. The push was written 22 ms after the Send, Claude Code started a
  turn with it, and Claude answered beside the circle with
  `apply(in_reply_to)` (receipt `acknowledged`). It never called
  `wait_for_user`. Two more Sends went the same way.
- **Killed mid-push.** `claude` was killed with SIGKILL 5 ms after a push was
  written to it. The MCP process exited, the Link logged `channel_closed` and
  marked the target offline, and the Send stayed `delivered` but unacknowledged.
  A new `claude -p` session read it with `wait_for_user(timeout_s: 0)`, flagged
  `redelivered: true`.

## What this decides

**Timeout policy.**
- Send progress during every wait. Claude Code's idle timeout is reset only by
  progress, and the remote default is 5 min. The host sends one every 15 s
  (`REFLEX_PROGRESS_S`).
- Progress doesn't extend either harness's hard limit, so a wait has to end
  under that limit on its own. Codex's default is 300 s. The MCP surface
  therefore holds a Codex `wait_for_user` for at most 280 s
  (`MAX_WAIT_S` in `agent/src/surfaces/mcp.ts`; override with
  `REFLEX_MAX_WAIT_S`). The Agent gets `still_waiting` and calls again,
  instead of a harness error. Claude Code's default hard limit is far above
  the 3600 s maximum, so its waits are not capped.
- A wait that ends for any of these reasons (Esc, timeout, pipe closed) never
  takes the Send. A Send pressed while no Agent is waiting stays in the Inbox
  and is returned by the next `wait_for_user`, including `timeout_s: 0`. Both
  harnesses showed this.

**Which binding ships first.** Ship the current SDK (1.32.2), which supports
2025-11-25 and earlier. Claude Code asks for 2025-11-25 and Codex for
2025-06-18, and the SDK serves both. Neither harness needs anything newer.
Claude Code's `server/discover` probe falls back cleanly when the server
doesn't implement it.

**Push.** Sends reach a Claude Code session by channel when it was started
with channels on and `reflex mcp --channel`; `wait_for_user` and the Inbox stay
the guarantee for everything else (ADR-0002). Because Claude Code drops a
channel it skipped without telling the server, the surface opens no push
target unless the session's command line has a channels flag.

**The 26 KB `apply` schema.** Neither harness puts it in every request: Claude
Code defers it behind ToolSearch, and Codex reaches tools through code mode.
Trimming it is not urgent for these two. A harness without deferral would pay
about 11k tokens per request for the whole tool list.
