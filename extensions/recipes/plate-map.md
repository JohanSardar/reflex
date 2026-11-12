---
kind: recipe
name: plate-map
summary: A lab plate map the person taps and talks over, with the notebook entry beside it.
---
# plate-map

Places the plate (read_me("plate"): wells by ID with their sample and group), a Markdown notebook
entry beside it that you fill in after each Send, and a note on how to mark it up. The person taps
wells with the Pencil, circles or strikes rows, holds the mic and says what they see ("row C
contaminated"), and presses Send. read_me("lab-notebook") says how to turn that into the entry.

## Params

```json params
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "maxLength": 120,
      "default": "Plate 1"
    },
    "rows": {
      "type": "integer",
      "minimum": 1,
      "maximum": 32,
      "default": 8
    },
    "columns": {
      "type": "integer",
      "minimum": 1,
      "maximum": 48,
      "default": 12
    },
    "groups": {
      "type": "array",
      "maxItems": 12,
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          },
          "color": {
            "type": "string",
            "maxLength": 7
          }
        },
        "required": [
          "name"
        ],
        "additionalProperties": false
      },
      "default": []
    },
    "wells": {
      "type": "object",
      "default": {},
      "description": "By well ID: {sample, group, label, color, flag}."
    },
    "notebook": {
      "type": "string",
      "description": "The notebook entry so far, in Markdown.",
      "maxLength": 8000,
      "default": "## Notebook\n\n_The entry appears here after you Send._"
    }
  },
  "additionalProperties": false
}
```

## Template

```json template
[
  {"op": "add", "type": "embed", "id": "plate", "template": "plate", "w": 620, "h": 470, "params": {"title": "{{title}}", "rows": "{{rows}}", "columns": "{{columns}}", "groups": "{{groups}}", "wells": "{{wells}}"}},
  {"op": "add", "type": "text", "id": "notebook", "markdown": true, "text": "{{notebook}}", "w": 480, "at": {"right_of": "plate", "gap": 40}},
  {"op": "add", "type": "note", "id": "how", "color": "yellow", "w": 620, "text": "Tap wells with the Pencil, or circle or strike a row. Hold the mic and say what you see (\"row C contaminated\"), then Send.", "at": {"below": "plate", "gap": 20}}
]
```

## Example

```json example
{"title": "Plate 3: MIC assay", "rows": 8, "columns": 12, "groups": [{"name": "E. coli", "color": "blue"}, {"name": "control", "color": "grey"}], "wells": {"A1": {"sample": "E. coli 0.5 µg/mL", "group": "E. coli"}, "H12": {"sample": "blank", "group": "control"}}, "notebook": "## Plate 3\n\n_Waiting for your read-out._"}
```
