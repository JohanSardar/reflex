# Troubleshooting

[Back to the quick start](../README.md#connect)

## TestFlight says the beta is unavailable

The [public invitation](https://testflight.apple.com/join/R81n88Re) is correct. The build was submitted for Apple’s beta review on November 16, 2026. A working invitation does not mean Apple has approved the build, or that there are open testing slots. You need TestFlight and iPadOS 26 or later. Developers can [build the iPad app](../apps/ipad/README.md#build).

## Claude Code doesn’t see Reflex

Run the README’s install command in the same folder where you start Claude Code. The default MCP registration is local to that project. Start a new session after adding it. Check the registration:

```sh
claude mcp get reflex
```

It should show a stdio server with command `npx`, arguments `-y github:JohanSardar/reflex#npx mcp`, and a connected status. You need Node.js 22 or later, Git and internet access for the first download. Allow the MCP tool calls if your harness asks.

## Codex times out or doesn’t see Reflex

Use the exact `[mcp_servers.reflex]` block in the [quick start](../README.md#codex), including `tool_timeout_sec = 300`. Keep only one block with that name. Start a new session after editing the configuration. Ask explicitly to “connect my iPad to Reflex”.

## The code fails or expires

Ask your agent to connect again and use the new code. Codes are single-use, expire after ten minutes and close after five failed attempts. Enter the code from the intended agent; entering it approves that receiver too.

Start with both devices on the same Wi-Fi. Allow Reflex under **Settings → Privacy & Security → Local Network** on your iPad. Guest Wi-Fi isolation, VPNs and firewalls can block discovery; the relay fallback also needs internet access. If you intentionally disabled the relay, there is no remote fallback.

## Paired, but the agent doesn’t receive a Send

Tap **Send**, then look in the agent session for its answer. Drawing alone does not transmit strokes. Ask the agent to call `wait_for_user` if it stopped waiting. A plain Claude Code session uses that tool; automatic push between turns is an [optional channel setup](relay.md#pushed-sends-optional-local).

Check the Link on your Mac:

```sh
npx -y "github:JohanSardar/reflex#npx" link status
npx -y "github:JohanSardar/reflex#npx" link agents
```

The intended agent needs approval. If you reinstall the iPad app, pair it again. To restart the Link without deleting its data:

```sh
npx -y "github:JohanSardar/reflex#npx" link stop
```

Then ask your agent to connect again; the next tool call starts the Link on demand.

## Still stuck

[Open a bug report](https://github.com/JohanSardar/reflex/issues/new/choose) with OS versions, harness/version, the exact command, expected result and what happened. Include a screenshot with private board content removed. Don’t attach the Reflex profile, credentials, live pairing codes or unredacted logs. Use [private security reporting](../SECURITY.md) for vulnerabilities.
