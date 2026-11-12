# Elements

## 1. Spaces

A **Space** is one canvas: a named document (`space_name`: lowercase letters, digits and `-`). Its `kind` is `space` for a canvas, or `library` for the person's Library. A Space has a size (`infinite`, `pages` or `width`), set when it is created (`open_space`), and holds Elements, Sends, history and settings.

## 2. Elements

An **Element** is one thing on the canvas. [`element.schema.json`](../schema/element.schema.json) is the full shape, tagged by `type`:

| `type` | What |
|---|---|
| `text`, `note`, `math` | words; `math` is LaTeX |
| `shape`, `connector` | boxes, ellipses, lines; a connector joins two Elements and follows them |
| `image`, `file` | an asset by its SHA-256 hash, with its name and MIME type |
| `frame`, `region` | a container; a Region is an area that sends what is drawn in it on its own |
| `embed` | a live view: a model, a document, a template with `params`, that answers where strokes land on it (§5) |
| `ink` | a person's or Agent's stroke: points `[x, y, t_ms, pressure]`, width, colour |
| `extension` | any other type name, with `type_version` and open `props` |

A reader MUST keep an extension's `props` as they are, fields it doesn't know included, and SHOULD draw an `extension` it can't render as a placeholder at its bounds.

[`scene-item.schema.json`](../schema/scene-item.schema.json) is the compact view in outlines and Bundles; `by` there is a display name, or `"you"` for the reading Agent's own.

## 3. IDs and ownership

- An Element's **owner** is a principal: a person (`p_…`) or an Agent (`a_…`), from the authenticated context, never from arguments (ADR-0008).
- **IDs are scoped to their owner.** An Agent chooses its own Elements' IDs and sees them bare (`plan`). Everyone else sees them as `<agent>:<id>` (`a_claude:plan`). A person's strokes have IDs their device chooses.
- Only an Element's owner changes or removes it. A person may move or erase anything, which the Agent sees as `changes` in its next Bundle (send-bundles.md §1). A kernel MUST refuse a change by anyone else (operations.md §4, membership.md §4).

## 4. Coordinates

- **Each reader has its own coordinates.** Every Agent has one stable integer coordinate space per Space, whose origin never moves (ADR-0007). Positions an Agent writes and reads are in its own space; `look` and Bundle images say which bounds they cover.
- Placement (`at`) is a relation to an Element or a Mark (exactly one of `right_of`, `left_of`, `above`, `below`, `near`, `inside`, with an optional `gap`), which Reflex resolves when applied, or an absolute top-left corner (`x`, `y`).
- Integers are bounded inside ±(2^53 − 1). **Text ranges are UTF-16 code units**, everywhere.

## 5. Behaviors, Panels, Embeds

- A **Behavior** (`common.schema.json#/$defs/behavior`) pairs one trigger (`on`: a tap, a long press, an Embed's event) with one action (`do`): `set` fields on a target, `send` or `notify` with a payload, `open_panel`, `apply_recipe`. A device that sees a trigger fire writes a Send with `trigger: "behavior"` (`element`, `on`); the kernel freezes it as an `action` that is delivered to no Agent. The Link then runs its `set` and `apply_recipe` as the Element's owner (an `apply` patch with `set`, or the Recipe, under a request ID fixed by the Send), so only an Agent-owned Element's actions run, and only while that Agent is approved. The Agent sees what changed in the person's next Send (`changes` of kind `behavior`).
- A **Panel** is a small form of components (`panel_component`) the device shows; its values come back in a Send (`values`).
- An **Embed** answers where strokes land on it. A device asks the Embed which part of it each stroke covers and writes the answers into the raw Send as `embed_anchors`, each an Anchor (`common.schema.json#/$defs/anchor`) whose `kind` says which fields apply: `text` with a range, `data` with rows and points, `part` of a model, `local` bounds, and so on. `surface: "writing"` says the strokes are writing on the Embed (a guide box, a form field), not marks on it: they stay one Mark on that Embed.

## 6. Recipes and the Library

A **Recipe** is a named list of `apply` ops with `{{param}}` placeholders. A string that is exactly `"{{name}}"` becomes the parameter's value with its type; inside a longer string it becomes its text. `define` ops save Recipes and Element templates to the person's Library Space, which the person can rename or delete (operations.md §5).
