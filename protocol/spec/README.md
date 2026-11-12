# Reflex Protocol v1

Reflex Protocol v1 is what a program must speak to take part in Reflex: to be an Agent that writes into a person's Space, a client that shows or draws in one, a Link that holds Spaces, a Relay that carries them, or a receiver that Sends are pushed to. The schemas in [`../schema/`](../schema/) are the source of truth for every message's shape. These pages say what the messages mean, the order they go in, and the rules the schemas can't express. Words follow [GLOSSARY.md](../../GLOSSARY.md).

**MUST**, **MUST NOT**, **SHOULD** and **MAY** are used as in RFC 2119.

| Page | What |
|---|---|
| [elements.md](elements.md) | Spaces, Elements, IDs, ownership, coordinates |
| [operations.md](operations.md) | The eleven tools: `apply` and its ops, patches, errors, acknowledgement; a person's intents |
| [send-bundles.md](send-bundles.md) | From a person's Send to a Bundle: raw Sends, Marks, Anchors, delivery, the webhook push |
| [identity.md](identity.md) | People, devices and Agents; pairing; approving Agents |
| [membership.md](membership.md) | Shared Spaces: share records, invites, roles, who may write what, key epochs |
| [transports.md](transports.md) | The handshake, the session messages, LAN, peer-to-peer, the Relay, the viewer API, where the schemas live |
| [versioning.md](versioning.md) | What v1 promises, and how it changes |

## The parts, and who speaks what

```
 Agent ──MCP / CLI──▶ Link ◀──session──▶ iPad / drawing client
  (operations.md)      │  ◀──session──▶ other Links (yours, or a member's)
                       │  ──viewer API─▶ web viewer
                       │  ──webhook───▶ Send Adapter receiver
                       └──relay wire──▶ Relay ◀── devices away from home, cloud Agents
```

- An **Agent** never sees the wire. It calls eleven tools ([operations.md](operations.md)) over MCP or the `reflex` CLI, and gets Send Bundles ([send-bundles.md](send-bundles.md)).
- A **client** (an iPad, a tablet, a browser) holds full replicas of Spaces and syncs them with the Link. Every client embeds a **kernel**, the engine that keeps a Space: Reflex's is `kernel/` (Rust, as WASM and UniFFI). Protocol v1 does not specify the kernel's storage or sync encoding: two clients interoperate by embedding the same kernel, which is published with each protocol release. What a client writes into it *is* specified: Elements ([elements.md](elements.md)) and a person's intents ([operations.md §5](operations.md#5-a-persons-intents)).
- A **Link** is the always-on host for one person. It pairs devices, hosts Agents, and pushes Sends.
- A **Relay** forwards sealed frames between a person's devices and keeps each Space as a log it can't read.

## Conformance

`tests/conformance/` holds the conformance suite: named **profiles**, each a set of fixtures (the 13 scenarios of SPEC §16) and traces, and a runner that checks an implementation against one. An implementation claims a profile by passing it:

| Profile | For | Pages |
|---|---|---|
| `kernel` | a Space engine | elements, operations §5, send-bundles §2–3 |
| `viewer` | a client that shows Spaces | transports §7, membership §4 |
| `drawing` | a client that writes Ink and Sends | identity §3, transports §3–4, operations §5, send-bundles §1 |
| `send-adapter` (receiver, sender) | the webhook push, either end | send-bundles §6 |
| `relay` | a Relay | transports §6, §8 |

See [`tests/conformance/README.md`](../../tests/conformance/README.md) for how to run them.
