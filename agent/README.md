# Reflex agent receiver

MCP and CLI surfaces for receiving iPad Sends from the Mac Link. The sole tool is `wait_for_user`; there are no canvas writing or authoring tools.

```sh
node agent/bin/reflex.mjs setup
node agent/bin/reflex.mjs wait --timeout 0 --json
node agent/bin/reflex.mjs mcp
node agent/bin/reflex.mjs mcp --channel
```

The agent presents a stable credential and waits for approval. Acknowledge a Send with `after` on a later wait, and answer in your own session. Claude Code channels can push Sends between waits. Register webhooks with `reflex adapters add webhook --url <url>`; see `examples/webhook-claude.ts`.

Local RPC reconnects after a Link restart. The kernel-backed Send projection and fallback renderer remain for today's iPad; T25 replaces these. No web or MCP App viewer remains. Check with `npm run typecheck` from the root.
