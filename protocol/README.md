# Reflex Protocol v1

The public contract every Agent, client, Link, Relay and kernel builds on: JSON Schemas for every message, one hand-written example of each, generated types, the hand-written text Agents read, and the written spec in [`spec/`](spec/README.md). The conformance profiles are in [`tests/conformance/`](../tests/conformance/README.md). Vocabulary follows [GLOSSARY.md](../GLOSSARY.md); the design is in [ARCHITECTURE.md §4, §5 and §9](../docs/ARCHITECTURE.md).

Version 1.0.0. What changes in a minor or a major version is in [spec/versioning.md](spec/versioning.md); what changed is in [CHANGELOG.md](CHANGELOG.md); how it is released is in [RELEASE.md](RELEASE.md).

## What's here

| Path | What |
|---|---|
| `spec/` | What the messages mean and the rules the schemas can't express: Elements, operations, Send Bundles, identity, shared Spaces, transports, versioning. |
| `schema/` | JSON Schema 2020-12, the source of truth. One `<tool>.input` and `<tool>.output` per tool, the shared shapes, and the wire messages below. |
| `examples/` | One correct example per message, written by hand: `<schema>.json`, or `<schema>.<t>.json` for each message of a wire schema. `check` fails if a message has none. |
| `tool-text/` | `instructions.md` (the server instructions, always loaded, under about 400 tokens) and one description per tool. Hand-written, never generated from the schemas. |
| `generated/` | Self-contained copies of the tool, error, Element and Send Bundle schemas with every `$ref` inlined, for surfaces that need one document per schema (an MCP tool's `inputSchema`), `rust/protocol.rs`, the kernel's serde types, and `ts/protocol.d.ts`, TypeScript types for every schema. Don't edit; run `npm run build -w @reflex/protocol`. |
| `scripts/check.mjs` | Compiles every schema, enforces the rules below, validates the examples, and checks `generated/`. |
| `scripts/gen-rust.mjs` | Generates `generated/rust/protocol.rs` from the schemas: one struct or enum per object, enum and `oneOf`, with each union's variant picked by its `const` fields. The wire schemas are left out: the kernel doesn't speak them. |
| `scripts/gen-ts.mjs` | Generates `generated/ts/protocol.d.ts`: a type for each schema (`ApplyInput`, `SendBundle`, `Session`, …), for each shared definition, and for each `oneOf` variant (`SessionSync`, `IntentAddStroke`). |

Shared schemas:

| Schema | What |
|---|---|
| `common` | IDs, bounds, principals, placement (`at`), the `data` map, Behaviors, Panels, Anchors. |
| `element` | One Element as `read(detail: "full")` returns it, and the scene JSON renderers draw from. `type` discriminates. |
| `scene-item` | The compact view of an Element in outlines and Send Bundles, with `by`. |
| `apply.input` | The `apply` batch: `add`, `patch`, `remove`, `arrange`, `focus`, `define`. |
| `send-bundle` | What one Send reads like to the Agent. |
| `raw-send` | What a device writes when the person presses Send or fires a Behavior: strokes, words with times, handwriting hints, crops. The kernel freezes it and the Link turns it into a Send Bundle. |
| `error` | What every tool returns on failure: stable codes, each error with a `fix`. |
| `intent` | What a person's device writes through the kernel: strokes, moves, erasing, state (spec/operations.md §5). |

Wire schemas, one `oneOf` tagged by `t`:

| Schema | What |
|---|---|
| `handshake` | The plain frames that open every Path (spec/transports.md §3). |
| `session` | The header of each encrypted session message (§4). |
| `relay` | The Relay's JSON messages (§6). |
| `viewer` | The viewer API's event stream (§7). |
| `webhook` | The body of a Send pushed to a webhook (spec/send-bundles.md §6). |

Element IDs: an Agent's own Elements appear to it under its own IDs, and to everyone else as `<agent>:<id>`.

The eleven tools are fixed (SPEC §11): `list_spaces`, `open_space`, `read`, `look`, `apply`, `exec`, `wait_for_user`, `read_me`, `recipe`, `request_attention`, `revert`. Plugins never add tools.

## Check

`protocol/` is part of the root npm workspace.

```sh
npm install                              # at the repo root
npm run check -w @reflex/protocol        # schemas compile, rules hold, examples validate, generated/ is current
node tests/conformance/run.ts --reflex   # every conformance profile, against Reflex's own implementations
npm run build -w @reflex/protocol        # rewrite generated/ (including the kernel's Rust types) after a schema change
npm run typecheck -w @reflex/protocol
```

## Schema rules (ARCHITECTURE §9)

`check` enforces these:

- **JSON Schema 2020-12, restricted.** No `anyOf`, `allOf`, `if`/`then`/`else`, `patternProperties`, `dependentSchemas` or dynamic refs. `not` appears only as `not: {enum}`, to keep extension type names apart from built-ins.
- **One level of `oneOf`** on any path, following `$ref`s, because some harnesses' strict tool modes handle deep unions badly. The `apply` ops list is that one level; Behaviors, Panel components, Marks, changes and Anchors are flat objects whose `kind`, `on` or `do` field says which other fields apply.
- **No recursive schemas.**
- **Every integer is bounded** inside ±(2^53 − 1), the range Rust, Swift and JavaScript all represent exactly.
- **Every object that lists its properties is closed** (`additionalProperties: false`), so a typo is an error the Agent can fix rather than a field silently ignored. The open maps are deliberate: `data`, `props`, `params`, `payload`, `state`, `values`.

Conventions the schemas can't express:

- **Text ranges are UTF-16 code units**, at every boundary.
- **Coordinates are the reading Agent's own.** Each Agent has one stable integer coordinate space per Space with an origin that never moves (ADR-0007). `look` and Send images say which bounds they cover.
- **IDs are scoped to the Agent that chose them**, so two Agents never collide. Reflex shows each Agent IDs that are unique for it.
- **Owners are principals**, a person (`p_…`) or an Agent (`a_…`), from the authenticated context and never from arguments (ADR-0008). In a principal object exactly one of `person` and `agent` is set. Projections for the model show `by` (a display name, or `"you"`); full Elements carry `owner`.
- **Every Send names its person** in `from`, and a Bundle in a shared Space carries only that person's Marks.
- **Recipe templates** are lists of `apply` ops. A string that is exactly `"{{name}}"` becomes that parameter's value with its type; `{{name}}` inside a longer string is replaced by its text.
- **Errors.** Over MCP an error is the result text with `isError` set; on the CLI it is the single JSON line on stderr. `reason` is the stable code and `next` the calls or commands to try.
- **Acknowledgement.** A Send is acknowledged by `after` on `wait_for_user` or `in_reply_to` on `apply`, `exec` or `recipe`. Otherwise it comes back with `redelivered: true`.
- **Images.** Over MCP, images follow the JSON text block in the order `images` lists them (for `look` and `apply(look: true)`, the single crop follows).

## Versioning

Semver ([spec/versioning.md](spec/versioning.md)). A minor version adds optional fields, enum values, error codes or session messages; a major version changes meaning. Wire identifiers (`reflex-link/v0`, `reflex-relay/v0`, `v=0`) keep their spelling in v1. Each schema's `$id` is `https://reflex.eilmer.si/protocol/v1/<name>.schema.json`, where a Relay serves it (spec/transports.md §8). Extension Elements carry `type_version`.

## For the tickets building on this

- **Kernel (T2):** the serde types are generated from `schema/` (`scripts/gen-rust.mjs`). `element` is a union tagged by `type` (`#[serde(tag = "type")]`), with `extension` as the fallback for any other type name. Unknown extension `props` are kept as raw JSON.
- **iPad canvas (T3):** `examples/read.output.full.json` is a scene with every built-in type to draw from.
- **Agent layer (T4):** register each tool with `tool-text/<tool>.md` as its description and `generated/tools/<tool>.input.json` as its `inputSchema`; send `tool-text/instructions.md` as the server instructions.
