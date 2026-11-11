---
name: check-my-work
summary: A problem, a writing Region and a "Check my work" Send button.
---
# check-my-work

Places a problem statement and a Region below it where the person writes their working. The Region has a "Check my work" button: pressing it sends what they wrote in it, as a Send with `trigger: "region"` and `region: "work"`.

Wait for it with `wait_for_user(region: "work")`, then grade step by step with notes placed next to their lines.

## Params

```json
{
  "type": "object",
  "properties": {
    "problem": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "button": { "type": "string", "maxLength": 40, "default": "Check my work" }
  },
  "required": ["problem"],
  "additionalProperties": false
}
```

## Template

```json
[
  { "op": "add", "type": "text", "id": "problem", "text": "{{problem}}", "size": "l", "w": 900 },
  { "op": "add", "type": "region", "id": "work", "title": "Your work", "send_button": "{{button}}", "w": 900, "h": 600, "at": { "below": "problem", "gap": 32 } }
]
```
