---
kind: recipe
name: sketch-critique
summary: Corrections on a transparent overlay over the person's sketch (never touching it), Show and Hide buttons, your critique, and one drill to practise.
---
# sketch-critique

Lays an overlay of corrections exactly over the person's sketch, with Hide corrections and Show
corrections buttons under it that toggle the overlay on the iPad with no round trip, your critique
beside it, and one drill below: a prompt and a Region with a Done button.

Pass `at: {x, y}` of the sketch's top left and its size as `w` and `h` (read the sketch's strokes
or image for its bounds), so the overlay lines up. Every coordinate in `items` is in the overlay's
own pixels: Space point (x, y) is (x − sketch x, y − sketch y). Items are the overlay Embed's
(read_me("overlay")). Wait for the drill with `wait_for_user(region: "drill")`.
read_me("drawing-critique") says how to critique.

## Params

```json params
{
  "type": "object",
  "properties": {
    "w": {
      "type": "integer",
      "minimum": 40,
      "maximum": 4000,
      "description": "The sketch's width."
    },
    "h": {
      "type": "integer",
      "minimum": 40,
      "maximum": 4000,
      "description": "The sketch's height."
    },
    "items": {
      "type": "array",
      "minItems": 1,
      "maxItems": 60,
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9_-]{0,39}$"
          },
          "kind": {
            "type": "string",
            "enum": [
              "line",
              "arrow",
              "path",
              "circle",
              "rect",
              "note"
            ]
          },
          "points": {
            "type": "array",
            "maxItems": 200,
            "items": {
              "type": "array",
              "items": {
                "type": "number"
              },
              "minItems": 2,
              "maxItems": 2
            }
          },
          "box": {
            "type": "array",
            "items": {
              "type": "number"
            },
            "minItems": 4,
            "maxItems": 4
          },
          "at": {
            "type": "array",
            "items": {
              "type": "number"
            },
            "minItems": 2,
            "maxItems": 2
          },
          "text": {
            "type": "string",
            "maxLength": 80
          },
          "color": {
            "type": "string",
            "maxLength": 7
          },
          "style": {
            "type": "string",
            "enum": [
              "solid",
              "dashed"
            ]
          },
          "width": {
            "type": "number",
            "minimum": 1,
            "maximum": 12
          }
        },
        "required": [
          "kind"
        ],
        "additionalProperties": false
      },
      "description": "The corrections, in the overlay's pixels."
    },
    "critique": {
      "type": "string",
      "description": "What works, what to fix and why, in a few short lines.",
      "minLength": 1,
      "maxLength": 1500
    },
    "drill": {
      "type": "string",
      "description": "One exercise for the main problem, such as 'Draw five boxes in two-point perspective, 2 minutes each.'",
      "minLength": 1,
      "maxLength": 300
    }
  },
  "required": [
    "w",
    "h",
    "items",
    "critique",
    "drill"
  ],
  "additionalProperties": false
}
```

## Template

```json template
[
  {"op": "add", "type": "embed", "id": "corrections", "template": "overlay", "w": "{{w}}", "h": "{{h}}", "params": {"visible": true, "items": "{{items}}"}},
  {"op": "add", "type": "shape", "id": "hide-corrections", "shape": "rounded", "fill": "tint", "color": "grey", "text": "Hide corrections", "w": 180, "h": 44, "at": {"below": "corrections", "gap": 16}, "behaviors": [{"on": "tap", "do": "set", "target": "corrections", "set": {"params": {"visible": false, "items": "{{items}}"}}}]},
  {"op": "add", "type": "shape", "id": "show-corrections", "shape": "rounded", "fill": "tint", "color": "red", "text": "Show corrections", "w": 180, "h": 44, "at": {"right_of": "hide-corrections", "gap": 12}, "behaviors": [{"on": "tap", "do": "set", "target": "corrections", "set": {"params": {"visible": true, "items": "{{items}}"}}}]},
  {"op": "add", "type": "note", "id": "critique", "color": "yellow", "w": 340, "text": "{{critique}}", "at": {"right_of": "corrections", "gap": 40}},
  {"op": "add", "type": "text", "id": "drill-prompt", "text": "Drill: {{drill}}", "size": "m", "w": 760, "at": {"below": "hide-corrections", "gap": 32}},
  {"op": "add", "type": "region", "id": "drill", "title": "Drill", "send_button": "Done", "w": 760, "h": 380, "at": {"below": "drill-prompt", "gap": 12}}
]
```

## Example

```json example
{"w": 600, "h": 400, "items": [{"id": "horizon", "kind": "line", "points": [[0, 150], [600, 150]], "color": "blue", "style": "dashed", "text": "Eye level"}, {"id": "door", "kind": "circle", "box": [260, 190, 90, 140], "text": "Door too tall"}], "critique": "Good: confident lines, clear silhouette.\nFix: the two walls don't share a horizon, so the corner bends.", "drill": "Draw five boxes in two-point perspective on one horizon, 2 minutes each."}
```
