---
kind: recipe
name: review-legend
summary: A legend that tells the person how to review a plan by hand, with a Send button for their review.
---
# review-legend

A small note that explains the markup gestures (circle, arrow, strike, write, speak) and a Region with a "Send review" button. Put it beside a plan you drew: `recipe("review-legend", {}, at: {right_of: "<your frame or first node>"})`.

## Params

```json params
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "maxLength": 80, "default": "How to review" }
  },
  "additionalProperties": false
}
```

## Template

```json template
[
  { "op": "add", "type": "note", "id": "legend", "color": "yellow", "w": 280, "text": "{{title}}\n◯ circle what you mean\n→ arrow from one to another\n— strike out what should go\n✎ write a word next to it\n🎙 hold the mic and say why" },
  { "op": "add", "type": "region", "id": "legend-send", "title": "Done?", "send_button": "Send review", "w": 280, "h": 110, "at": { "below": "legend", "gap": 16 } }
]
```
