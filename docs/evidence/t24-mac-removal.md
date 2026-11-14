# T24 evidence

Archive: `archive/canvas-v0` pushed to GitLab at `b6ec634c74d8ea7576c0003903aed61d8b6352a9` before edits.

## Commands and results

- `npm install --no-audit --no-fund`: passed. No publishing.
- `sh kernel/wasm/build.sh`: passed after relocating the retained Rust validation table into the kernel. This preserves the current iPad's document-carried Sends until T25.
- `npm run typecheck`: passed for root/Link, agent and Relay. No lint script exists.
- `node --test link/test/reapprove.test.ts link/test/self-approve.test.ts link/test/stop.test.ts link/test/terminal-queue.test.ts`: six passed initially; the terminal self-approval test exposed its obsolete `--no-web` invocation. Removed that flag and reran only the failed test: passed (465 ms).
- `node --test link/test/asset-frame.test.ts link/test/asset-backpressure.test.ts`: both passed (17 MiB live peer transfer and 24 MiB backpressure transfer; 10.8 seconds total).
- `git diff --check`: passed after trimming trailing blank lines.

The deleted checks require intentionally removed authoring, sharing, web-viewer or cloud-session features. Kernel trace fixtures remain untouched.

## Real client use

A temporary program used the actual Link, LAN transport, pairing handshake, kernel document client, agent RPC client, channel connection and HTTP webhook. It paired as an iPad, approved a receiver through that encrypted session, froze Sends on its own document and synced them to the Link. No Mac-side fake-person or agent-writing API was used. The program restarted the Link to prove durable redelivery and connected two forwarding clients concurrently to a real Node Relay.

Output (ephemeral device IDs omitted):

```text
PASS paired iPad client → encrypted LAN document sync → approved wait_for_user: send-1 Please review these notes
PASS removed canvas writing tool rejected: Unknown tool 'apply'. Use wait_for_user.
PASS Claude Code channel receiver: send-2
PASS webhook HTTP receiver: send-3 signature v1=[redacted]
PASS Link restart: unacknowledged Send redelivered: send-3
PASS removed low-level writing, sharing, cloud grants and Library RPCs rejected
PASS Relay signed authentication + simultaneous device connections + binary forwarding; cloud log endpoint 404
PASS real receiver workflow complete
PASS real MCP initialize + tools/list: ["wait_for_user"]
```

The MCP check used the SDK's stdio client against `node agent/bin/reflex.mjs mcp`, including initialize and tools/list.

## Setup use

Ran the real `reflex setup --home <temporary-profile> --bin <temporary-bin> --no-claude --no-codex --no-wait`. Existing personal harness settings were not modified. It exited zero, built the Apple peer-to-peer helper, started the background Link, and displayed the iPad pairing instructions. `reflex link status --json` showed LAN port 7420, zero paired devices/agents and Relay disabled for this isolated profile. `reflex link stop` stopped it successfully. Temporary profiles and receivers were cleaned up.

No iPad application UI was driven: the iPad app belongs to T25. Its real wire/client behavior was exercised by the program above. No Relay deployment, DNS changes, tags, releases or npm publishing occurred.
