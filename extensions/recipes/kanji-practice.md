---
kind: recipe
name: kanji-practice
summary: One kanji or hanzi to practise: a model in a guide box, three practice boxes in a Region, and a "Check my strokes" button.
---
# kanji-practice

Places the prompt, a model of the character in a guide box, and a Region holding three practice
boxes: the first with the character faint to trace, the other two empty. The Region's button sends
only the strokes written inside it (`trigger: "region"`, `region: "practice"`). Each stroke's
Mark has a `target` in its box's terms (`kind: "box"`, fractions of the side), so you can judge
stroke order from `start` and `end`, and proportion from `box`. read_me("kanji") says how to give
the feedback.

Wait with `wait_for_user(region: "practice")`. Apply it once per character; a second one gets fresh
IDs, listed in the result.

## Params

```json params
{
  "type": "object",
  "properties": {
    "character": {
      "type": "string",
      "description": "One kanji or hanzi.",
      "minLength": 1,
      "maxLength": 2
    },
    "reading": {
      "type": "string",
      "description": "Its reading, such as えい / ei.",
      "maxLength": 40,
      "default": ""
    },
    "meaning": {
      "type": "string",
      "maxLength": 60,
      "default": ""
    },
    "strokes": {
      "type": "integer",
      "minimum": 1,
      "maximum": 40,
      "description": "Its stroke count."
    },
    "button": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40,
      "default": "Check my strokes"
    }
  },
  "required": [
    "character",
    "strokes"
  ],
  "additionalProperties": false
}
```

## Template

```json template
[
  {"op": "add", "type": "text", "id": "prompt", "text": "Write {{character}} {{reading}} {{meaning}}: {{strokes}} strokes. Trace the first box, then write it twice on your own. Mind the stroke order.", "size": "m", "w": 1040},
  {"op": "add", "type": "embed", "id": "model", "template": "guide-box", "w": 220, "h": 220, "at": {"below": "prompt", "gap": 20}, "params": {"character": "{{character}}", "show": "model", "label": "Model"}},
  {"op": "add", "type": "region", "id": "practice", "title": "Practice", "send_button": "{{button}}", "w": 780, "h": 310, "at": {"right_of": "model", "gap": 40}},
  {"op": "add", "type": "embed", "id": "box-1", "template": "guide-box", "w": 220, "h": 220, "at": {"inside": "practice", "gap": 40}, "params": {"character": "{{character}}", "show": "trace", "label": "Box 1"}},
  {"op": "add", "type": "embed", "id": "box-2", "template": "guide-box", "w": 220, "h": 220, "at": {"right_of": "box-1", "gap": 20}, "params": {"show": "empty", "label": "Box 2"}},
  {"op": "add", "type": "embed", "id": "box-3", "template": "guide-box", "w": 220, "h": 220, "at": {"right_of": "box-2", "gap": 20}, "params": {"show": "empty", "label": "Box 3"}}
]
```

## Example

```json example
{"character": "永", "reading": "えい / ei", "meaning": "eternity", "strokes": 5, "button": "Check my strokes"}
```
