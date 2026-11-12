# Operations

## 1. The eleven tools

An Agent has exactly eleven tools (SPEC §11), each with an input and an output schema in [`../schema/`](../schema/) and a description in [`../tool-text/`](../tool-text/):

`list_spaces`, `open_space`, `read`, `look`, `apply`, `exec`, `wait_for_user`, `read_me`, `recipe`, `request_attention`, `revert`.

Plugins never add tools. Over MCP each is a tool whose `inputSchema` is `generated/tools/<tool>.input.json` (every `$ref` inlined) and whose result is one JSON text block, followed by any images in the order the JSON's `images` lists them. On the CLI (`reflex <noun> <verb> --json`) the result is the last line on stdout. The server instructions are `tool-text/instructions.md`.

## 2. `apply`

One `apply` is one atomic batch: every op succeeds, or nothing changes. [`apply.input.schema.json`](../schema/apply.input.schema.json):

| `op` | What |
|---|---|
| `add` | a new Element of the Agent's, by its own ID; one variant per type |
| `patch` | changes one of the Agent's own Elements (§3) |
| `remove` | removes the Agent's own Elements |
| `arrange` | lays several out (`layout`, `gap`, `columns`, `align`; `tree` follows their connectors) and lets Reflex compute the positions |
| `focus` | points the Agent's own view, the one `look` renders by default; it never moves the person's screen (that is `request_attention`) |
| `define` | saves a Recipe or an Element template to the Library |

- `request` (a request ID) makes a batch idempotent: the same ID with the same ops returns the first result with `duplicate: true`; with different ops it fails with `request_reused`. Request IDs are the Agent's own, and idempotent within one Space: the same ID in another Space is another batch. (An `add` of a built-in template also defines it in the Library Space under `<request>.builtin`, so there a reused ID with other templates fails with `request_reused`.)
- `in_reply_to` names the Send the batch answers (§6); `look: true` returns a crop of the result.
- An `add` whose ID exists already fails with `duplicate_id`; a `patch` or `remove` of something that isn't the Agent's fails with `not_yours`; an ID nobody has, with `unknown_id`.

## 3. Patches

A `patch` is a set of explicit field operations on one Element, each key one operation: `set` (fields to new values), `unset`, `text_insert` and `text_delete` (by UTF-16 offset), `list_insert`, `list_move` and `list_remove`, `map_put` and `map_delete` (on `data` and other open maps). Each has a defined merge with concurrent edits, so an Agent SHOULD insert text rather than set the whole of it.

## 4. Errors

[`error.schema.json`](../schema/error.schema.json): every failure is `{ok: false, reason, errors: [{code, msg, fix, op?, path?}], next?}`.

- `reason` is one stable code; a batch with several failing ops uses `batch_rejected` and lists every one, not only the first.
- Every error carries `fix`, a sentence the Agent can act on, and may carry `next`, calls to try.
- Over MCP an error is the result text with `isError: true`; on the CLI it is the single JSON line on stderr and a non-zero exit.
- A minor version MAY add codes. An Agent MUST treat an unknown code as its `fix` says.

## 5. A person's intents

A device writes what the person does as **intents**, which the kernel applies as the person ([`intent.schema.json`](../schema/intent.schema.json), tagged by `intent`):

| `intent` | What |
|---|---|
| `add_stroke` | one Ink stroke, by an ID the device chooses: points `[x, y, t_ms, pressure]` with `t` from the stroke's start |
| `move` | the person dragged Elements, by `[dx, dy]`; the owner's Agent sees `changes: [{kind: "moved", by}]` |
| `erase`, `remove` | the person erased whole strokes or removed Elements (the two are the same) |
| `erase_precise` | the pixel eraser cut a stroke: it is replaced by what is left of it |
| `set_state` | an Embed saved state, or the person entered values in a Panel; the keys given replace those keys |
| `library_rename`, `library_delete` | changes the person's Library |
| `add`, `patch` | the person's own non-Ink Elements, with the apply op's fields and `intent` in place of `op` |

The kernel takes them as `apply_user_intent(person, device, intent, now_ms)`: it stamps the person and device from its arguments, never from the intent, and records each intent as one undo step for that person. Undo and redo are the kernel's `undo(person, device)` and `redo(person, device)`, not intents.

A device MUST write each intent when the person does it, with the time it happened: the gaps between strokes are what group them into Marks (send-bundles.md §2). A stroke is the person's for good: Agents can never change or remove it.

## 6. Acknowledging a Send

`wait_for_user` delivers each Send once. The Agent acknowledges it with `after: <send>` on its next `wait_for_user`, or `in_reply_to: <send>` on `apply`, `exec` or `recipe`. An unacknowledged Send comes back on the next `wait_for_user` with `redelivered: true`. A push (send-bundles.md §6) counts as a delivery once the receiver acknowledges it.
