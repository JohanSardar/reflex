# Reflex Protocol v1 conformance

Named **profiles**, each a set of fixtures and traces that an implementation of one part of Reflex must pass. The spec is [`protocol/spec/`](../../protocol/spec/README.md); the schemas are [`protocol/schema/`](../../protocol/schema/). Every message an implementation sends is checked against its schema, every check names what it found, and a run ends with `n/m checks passed`.

```sh
node tests/conformance/run.ts --reflex                     # every profile, against Reflex's own implementations
node tests/conformance/run.ts --reflex drawing relay       # some of them
node tests/conformance/run.ts viewer --impl "<command>"    # yours
node tests/conformance/run.ts relay --url https://relay.example.com
```

It needs Node 24 or later, `npm install` at the repo root, and the kernel built (`npm run build:kernel-wasm`). The viewer profile's Reflex implementation needs Chrome (`CHROME` names it); the Workers Relay runs under local `wrangler dev`.

| Profile | For | The runner is | The implementation is driven by | Reflex's |
|---|---|---|---|---|
| `kernel` | a Space engine | two devices | a driver | `kernel/` as WASM |
| `viewer` | a client that shows Spaces | the host serving the viewer API | a driver | the web viewer (`apps/web`) in headless Chrome |
| `drawing` | a client that writes Ink and Sends | the Link it pairs with | a driver | a Link (`reflex link --dev`) drawing as its person |
| `send-adapter --role sender` | something that pushes Sends to a webhook | the webhook receiver | a driver | the Link's webhook adapter |
| `send-adapter --role receiver` | a webhook receiver | the Link pushing Sends | a driver, or `--url` | `agent/examples/webhook-claude.ts` |
| `relay` | a Relay | the person's devices | a driver, or `--url` | `relay/node`, and `relay/cloudflare` under `wrangler dev` |

## Drivers

An implementation is driven through a **driver**: a command, written in any language, that reads one JSON request per line on stdin and writes one JSON answer per line on stdout.

```
→ {"id": 7, "do": "intent", "space": "plan-review", "intent": {...}}
← {"id": 7, "ok": true}
← {"id": 8, "ok": false, "error": "why"}
```

Answers may come in any order; anything else goes to stderr, which the runner shows when a check fails. When stdin closes, the driver stops what it started and exits. `tests/conformance/impl/` has Reflex's drivers; `lib/driver.ts`'s `serve()` is the other end, for one written in TypeScript.

### kernel

The runner keeps named replicas in the implementation, as many as a trace needs.

| Request | Answer |
|---|---|
| `create {replica, space, kind?}` | a new empty replica |
| `agent {replica, agent, request, batch, now}` | `{result}`: an Agent's `apply` batch (operations.md §2), as the kernel's apply result |
| `intent {replica, person, device, intent, now}` | `{result}`: one person's intent (operations.md §5) |
| `undo`, `redo {replica, person, device, now}` | `{result}` |
| `freeze {replica, person, device, raw, now}` | `{result}`: the frozen Send (send-bundles.md §1) |
| `marks {replica, send, viewer}` | `{result}`: the Send's Marks for `viewer: {agent}` (send-bundles.md §2), or `null` |
| `scene {replica, query?}` | `{result}`: the scene, as `read` returns it |
| `sync_message {replica, peer}` | `{msg}`: the next sync message to `peer`, base64, or `null` |
| `receive {replica, peer, msg, writers?}` | `{result?}`: takes a sync message; with `writers`, checked (membership.md §4) |
| `restart {replica}` | saves and loads the replica, as after a crash |
| `state {replica}` | `{digest, heads}` |

Checks: the traces in `tests/traces/` (convergence, undo, Agent rules), then every scenario over two replicas the way a Link and an iPad run it (§Fixtures), and that a receiver with no writers refuses a person's strokes.

### viewer

| Request | Answer |
|---|---|
| `open {url, key, space}` | connects to the viewer API at `url` with the viewer key, and shows `space` |
| `drawn {space}` | `{ids}`: the Element IDs it draws for that Space now |
| `status {}` | `{status}`: `live`, `connecting`, `offline` or `bad_key` |

Checks: it draws every scenario's Elements; it draws a change made while it watches; it answered sync and none of its replies were refused (it wrote nothing); it stops with `bad_key` on a wrong key.

### drawing

| Request | Answer |
|---|---|
| `pair {code}` | pairs with the `reflex://pair` code (identity.md §3) |
| `ids {space}` | `{ids}`: the Element IDs its replica of the Space holds |
| `intent {space, intent}` | writes one intent as the person, now |
| `send {space, raw}` | freezes a raw Send as the person, now |

Checks: it pairs over TCP; it syncs every Space; for each scenario it draws in real time, sends, and the runner, as its Link, gets the frozen Send and groups the same Marks the fixture names; every frame it sent is a v1 handshake or session message; every change was its person's; it answers a ping.

### send-adapter

`--role sender`:

| Request | Answer |
|---|---|
| `target {url}` | `{secret}`: adds a webhook target for an Agent, pointing at `url` |
| `space {space, setup}` | `{agent?}`: the Agent makes the Space and applies the setup batches. `agent` is the ID the person's side gives its Elements, if not `a_claude` |
| `intent`, `send` | as in `drawing` |

Checks: three scenarios' Sends arrive as one signed request each, with the headers, the body and the Bundle valid; a 503 is tried again after about 1 s with the same delivery ID and the next attempt, and stops at a 2xx; a 400 is not tried again.

`--role receiver`:

| Request | Answer |
|---|---|
| `start {secret}` | `{url}`: starts listening, checking signatures with `secret` |
| `taken {}` | `{deliveries}`: the delivery IDs it acted on, in order |

Or `--url <url>` with `REFLEX_WEBHOOK_SECRET`, and the last check is skipped. Checks: it acknowledges a signed Send, Region Send and watch Send; it acknowledges a repeat; it turns away a wrong signature and a timestamp 10 minutes old; it acted on each valid delivery once.

### relay

| Request | Answer |
|---|---|
| `start {}` | `{url}`: a fresh Relay, with no logs, at this http(s) origin |

Or `--url`. Checks: the challenge and a bad hello (4403); welcome; presence; a frame forwarded with the device ID rewritten; `undeliverable`; `close`; a log's append, read and token rules; `log.watch` and `log.new`; assets over HTTP; ping; a device going offline; every message valid; the schemas at `/protocol/v1/`.

## Fixtures

`scenarios/NN-*.json` are the 13 scenarios of SPEC §16. Each is:

```
{ scenario, title, spec, space,
  setup: [{ops}],                                      the Agent's apply batches, as Agent a_claude
  sends: [{ draw: [...], raw: {...}, expect: {...} }], what the person draws, then the raw Send
  elements: [...] }                                    every Element the setup makes, by the Agent's own ID
```

An implementation in another language follows these rules, not `lib/fixtures.ts`:

- **The person** is `p_4c1e9a7b2d30` ("Ana"); the Agent is `a_claude`; the setup happens at `T0 = 1762862400000`. In `draw`, `move` and `raw`, the Agent's Elements are named as everyone but it sees them, `a_claude:<id>`.
- **Strokes.** Each `draw` entry is written (its stroke ends, its intent's `now`) 1000 ms after the previous one, or `after_ms` after it. The first Send's first entry is 1000 ms after `T0`; each later Send's, 1000 ms after the Send before it.
  - `{id, ellipse: [cx, cy, rx, ry]}`: 25 points at angles `2πi/24`, `i = 0..24`, each rounded to an integer;
  - `{id, points: [[x, y], ...]}`: the polyline;
  - `{ids, letters: [x, y]}`: one stroke per ID, each a letter whose top-left is `(x + 16i, y)`, through `(2,0) (2,12) (2,24) (8,22) (12,16) (8,12) (2,14)` from it, 300 ms after the one before;
  - `{move: [ids], by: [dx, dy]}`: a `move` intent.
  
  Every polyline is sampled as a Pencil does: a point every 4 px or less along each segment (`ceil(length / 4)` steps, each rounded to 0.1), 4 ms apart, pressure 0.6. Each stroke is `add_stroke` with width 3 and colour `red`. The Send is 1000 ms after the last stroke.
- **Marks.** `expect.marks` is the Marks in order, each with at least the fields given; `on` compares as a set. Where how strokes group is the implementation's choice, `expect.every` is what every Mark must have, and `expect.strokes` the strokes they hold together, in order. `expect.frozen` is fields the frozen Send must have.
