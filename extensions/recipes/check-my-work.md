---
kind: recipe
name: check-my-work
summary: A LaTeX problem, a writing Region below it and a "Check my work" Send button.
---
# check-my-work

Places a short prompt, the problem typeset from LaTeX, and a Region below them where the person writes their working by hand. The Region's "Check my work" button sends only what they wrote inside it, as a Send with `trigger: "region"` and `region: "work"`, and its handwriting comes back line by line: one `writing` Mark per line, top to bottom, each with `line`, `text_guess`, `confidence` and `bounds`.

Wait for it with `wait_for_user(region: "work")`, then grade line by line: read_me("math-tutoring") says how. Pass `watch: true` to also get snapshots while they write (`kind: "watch"`); turn it off later with `patch` `set: {watch: false}`.

Apply it once per problem; a second one gets fresh IDs (`problem-2`, `work-2`, …), listed in the result.

## Params

```json params
{
  "type": "object",
  "properties": {
    "problem": { "description": "The problem in LaTeX, such as 3x - 7 = 2x + 5.", "type": "string", "minLength": 1, "maxLength": 2000 },
    "prompt": { "description": "What to do, in words.", "type": "string", "minLength": 1, "maxLength": 400, "default": "Solve it. Write each step on its own line." },
    "button": { "type": "string", "minLength": 1, "maxLength": 40, "default": "Check my work" },
    "watch": { "description": "Send snapshots of the Region while the person writes.", "type": "boolean", "default": false }
  },
  "required": ["problem"],
  "additionalProperties": false
}
```

## Template

```json template
[
  { "op": "add", "type": "text", "id": "prompt", "text": "{{prompt}}", "size": "m", "w": 900 },
  { "op": "add", "type": "math", "id": "problem", "latex": "{{problem}}", "size": "l", "w": 900, "at": { "below": "prompt", "gap": 12 } },
  { "op": "add", "type": "region", "id": "work", "title": "Your work", "send_button": "{{button}}", "watch": "{{watch}}", "w": 900, "h": 600, "at": { "below": "problem", "gap": 28 } }
]
```

## Example

```json example
{ "problem": "3x - 7 = 2x + 5", "prompt": "Solve for x. One step per line.", "button": "Check my work", "watch": false }
```
