---
kind: recipe
name: cad-review
summary: A 3D model next to its feature tree, with a note on how to redline it, for a design review by hand.
---
# cad-review

Places a title, the 3D model (`model`: a .glb, .gltf or .usdz path on this computer, or an https URL),
its feature tree beside it (the `feature-tree` Embed, one row per feature) and a short note under the
model on how to review: turn it, grab a part to move it, circle what should change and write the change
beside it, sketch a new feature and write its size, then Send. read_me("cad") says how to read what comes
back and answer.

Give each feature the `part` it made, as the model's part names (they come back in `repaired` and in
`read(ids: ["model"], detail: "full")`), so a Mark on the model and a Mark on the tree lead to the
same feature.

## Params

```json params
{
  "type": "object",
  "properties": {
    "model": { "description": "The model: a file path on the Link's computer (/…, ~/…) or an https URL.", "type": "string", "minLength": 1, "maxLength": 4096 },
    "title": { "type": "string", "minLength": 1, "maxLength": 80, "default": "Design review" },
    "features": {
      "description": "The feature tree, top to bottom. Each row: id, name, and optionally kind, part, depth, dims, status and note (read_me(\"feature-tree\")).",
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "minLength": 1, "maxLength": 100 },
          "name": { "type": "string", "minLength": 1, "maxLength": 80 },
          "kind": { "type": "string", "enum": ["body", "sketch", "pad", "pocket", "rib", "hole", "fillet", "chamfer", "pattern", "mirror", "shell", "other"] },
          "part": { "type": "string", "maxLength": 256 },
          "depth": { "type": "integer", "minimum": 0, "maximum": 8 },
          "dims": { "type": "string", "maxLength": 120 },
          "status": { "type": "string", "enum": ["ok", "changed", "new", "suppressed", "error"] },
          "note": { "type": "string", "maxLength": 200 }
        },
        "required": ["id", "name"],
        "additionalProperties": false
      }
    }
  },
  "required": ["model", "features"],
  "additionalProperties": false
}
```

## Template

```json template
[
  { "op": "add", "type": "text", "id": "title", "text": "{{title}}", "size": "l", "w": 980 },
  { "op": "add", "type": "embed", "id": "model", "model": "{{model}}", "w": 640, "h": 480, "params": { "title": "{{title}}", "camera": { "yaw": 30, "pitch": 30, "zoom": 1 } }, "at": { "below": "title", "gap": 16 } },
  { "op": "add", "type": "embed", "id": "tree", "template": "feature-tree", "w": 320, "h": 480, "params": { "title": "Features", "features": "{{features}}" }, "at": { "right_of": "model", "gap": 20 } },
  { "op": "add", "type": "note", "id": "how", "color": "yellow", "w": 640, "text": "Turn the model with one finger. Hold a part, then drag it to move it.\n◯ Circle a part or a feature and write the change beside it\n✎ Sketch a new feature on the model and write its size\nThen press Send.", "at": { "below": "model", "gap": 16 } }
]
```

## Example

```json example
{ "model": "/Users/ana/cad/motor-bracket.glb", "title": "Motor bracket", "features": [
  { "id": "base", "name": "Base plate", "kind": "pad", "part": "base_plate", "dims": "120 × 80 × 8 mm" },
  { "id": "pocket-1", "name": "Pocket", "kind": "pocket", "part": "pocket_1", "depth": 1, "dims": "60 × 40 × 4 mm, 30 mm from the outline" }
] }
```
