# Extensions

What Agents read and reuse without a new tool or an app release (ADR-0006).
Built-in content uses the same rungs as anyone else's.

| Folder | Kind | Format |
|---|---|---|
| `guides/` | Guide (rung 0) | One Markdown file. Front matter `name` and `summary`; the body is what `read_me(name)` returns. |
| `embeds/` | Embed Template (rung 2) | A folder: `reflex.json` (`kind: "embed"`, `name`, `summary`, an example), `index.html`, `params.schema.json`, `guide.md`. `reflex test extensions/embeds/<name>` checks it. An Agent adds it with `add embed {template: name, params}`; Reflex saves the built-in copy to the person's Library on first use, so every device can draw it. |
| `recipes/` | Recipe (rung 1) | One Markdown file. Front matter `name` and `summary`, a `## Params` section with a fenced JSON Schema, and a `## Template` section with a fenced JSON list of `apply` ops. The rest is the Guide `read_me(name)` returns. |

| `models/` | Built-in 3D models | A `.glb` an Agent places as `model: "builtin:<name>"` (`builtin:heart`), with the script that makes it. |

An Embed Template whose HTML has `<meta name="reflex-background" content="transparent">` is drawn
with no background or border, on the iPad and the web viewer, so what lies under it shows through
(`overlay` uses it to sit over a sketch).

In a template, a string that is exactly `"{{name}}"` becomes that parameter's
value with its type, and `{{name}}` inside a longer string is replaced by its
text (protocol/README.md). `recipe` places the template's first op at its `at`.

`read_me("index")` lists these, every built-in Element type (its Guide is made
from the protocol schema), and the Recipes and Embed Templates Agents saved to
the person's Library with `define`.

## Scenarios

SPEC §16's scenarios and what each one uses:

| Scenario | Guide | Recipe | Embed Templates |
|---|---|---|---|
| 2 Math tutor | `math-tutoring` | `check-my-work` | |
| 6 UI / HTML prototype | `ui-review` | | `prototype` |
| 7 Writing / paper markup | `writing-review` | | `document` |
| 8 Morning experiment review | `experiment-review` | `experiment-board` | `chart`, `table` |
| 9 Kanji / hanzi | `kanji` | `kanji-practice` | `guide-box` |
| 10 Sketch critique | `drawing-critique` | `sketch-critique` | `overlay` |
| 11 3D anatomy | `anatomy` | `anatomy-quiz` | 3D Embed, `builtin:heart` |
| 12 Weekly planning / journal | `planning` | `week-planner` | |
| 13 Lab plate map | `lab-notebook` | `plate-map` | `plate` |
