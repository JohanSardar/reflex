# Extensions

What Agents read and reuse without a new tool or an app release (ADR-0006).
Built-in content uses the same rungs as anyone else's.

| Folder | Kind | Format |
|---|---|---|
| `guides/` | Guide (rung 0) | One Markdown file. Front matter `name` and `summary`; the body is what `read_me(name)` returns. |
| `recipes/` | Recipe (rung 1) | One Markdown file. Front matter `name` and `summary`, a `## Params` section with a fenced JSON Schema, and a `## Template` section with a fenced JSON list of `apply` ops. The rest is the Guide `read_me(name)` returns. |

In a template, a string that is exactly `"{{name}}"` becomes that parameter's
value with its type, and `{{name}}` inside a longer string is replaced by its
text (protocol/README.md). `recipe` places the template's first op at its `at`.

`read_me("index")` lists these, every built-in Element type (its Guide is made
from the protocol schema), and the Recipes and Embed Templates Agents saved to
the person's Library with `define`.
