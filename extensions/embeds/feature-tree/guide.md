# feature-tree

A CAD model's feature tree, drawn as a native-looking list next to the model: one row per feature,
indented by `depth`, with an icon for its `kind`, its key dimensions, and a tag when it changed.
It needs no network. Place it next to a 3D Embed (read_me("cad-review") sets up both in one call):

```json
{ "op": "add", "id": "tree", "type": "embed", "template": "feature-tree", "w": 320, "h": 460,
  "params": { "title": "Motor bracket", "features": [
    { "id": "base", "name": "Base plate", "kind": "pad", "part": "base_plate", "dims": "120 × 80 × 8 mm" },
    { "id": "pocket-1", "name": "Pocket", "kind": "pocket", "part": "pocket_1", "depth": 1, "dims": "60 × 40 × 4 mm" } ] } }
```

- `id` is what a Mark on the row reports; `part` names the model part the feature made, so you
  can tie a Mark on the model to its feature.
- `status`: `changed` or `new` tags the row, `suppressed` greys it out, `error` shows it in red.
  `note` is a short line under it, such as "offset 10 mm from outline (was 15)".

## What a Mark on it says

A circle, arrow tip, strike or writing on a row names that feature:

```json
{ "id": "m4", "kind": "circle", "on": ["tree"],
  "target": { "kind": "data", "rows": ["pocket-1"], "label": "feature Pocket (pocket, part pocket_1)" } }
```

## Update it

`patch` its `params` with the whole new list (`set.params` replaces all of them):

```json
{ "op": "patch", "id": "tree", "set": { "params": { "title": "Motor bracket", "features": [ "…every row, changed ones with status and note…" ] } } }
```
