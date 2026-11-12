---
kind: guide
name: cad
summary: Review a CAD part by hand: a 3D model beside its feature tree; read redlines, moved parts and sketched features, then answer or update the tree.
---
# CAD review

The person reviews a design the way they would redline a print: they turn the model, move a part,
circle a pocket and write "offset 10 mm from outline" beside it, or sketch a rib and write its size.
You get each mark tied to the part or feature it names, with the handwriting read, and you answer
on the canvas or change the feature tree.

## Set it up: one call

```json
{ "name": "cad-review", "space": "bracket", "params": {
  "model": "/Users/ana/cad/motor-bracket.glb", "title": "Motor bracket",
  "features": [
    { "id": "base", "name": "Base plate", "kind": "pad", "part": "base_plate", "dims": "120 × 80 × 8 mm" },
    { "id": "pocket-1", "name": "Pocket", "kind": "pocket", "part": "pocket_1", "depth": 1, "dims": "60 × 40 mm, 30 mm from the outline" },
    { "id": "wall", "name": "Wall", "kind": "pad", "part": "wall", "dims": "120 × 50 × 8 mm" },
    { "id": "boss-1", "name": "Boss", "kind": "pad", "part": "boss_1", "dims": "Ø 18 × 22 mm" } ] } }
```

`recipe("cad-review", …)` places the model (`model`), its tree (`tree`) and a note on how to review.
The result's `repaired` lists the model's parts; give each feature the `part` it made. Then
`wait_for_user()`.

## Read the review

Each group of strokes is one Mark. What it points at is in `target`:

- On the model, `{"kind": "part", "part": "pocket_1", "parts": [...], "camera": {...}}`: the part
  under the Mark, the likeliest first, and how the person was looking. Find the feature whose
  `part` it is.
- On the tree, `{"kind": "data", "rows": ["pocket-1"], "label": "feature Pocket (pocket, part pocket_1)"}`.
- Writing is a `writing` Mark with `text_guess`. Writing on the model also has a part `target`; the
  writing beside a circle is the note on what the circle names: pair them by `near` and by `bounds`.
  Check the image when `confidence` is under about 0.8: mm, Ø and ± are often misread.
- A sketched feature is a few lines (often `ink`, or an `arrow` or `strike` with a part `target`) with
  a number written beside it. Read its size and place from the image and the Mark's `bounds`, and
  which face it sits on from the part its strokes land on.
- A part the person moved comes in `changes` as `embed_state` with `part:<name>`, `position` and
  `moved_by` (in the model's units: a .glb is in metres, so 0.01 is 10 mm).

## Answer

Reply with `apply(in_reply_to: <send>)`:

- Update the tree: `patch` the `tree` Embed with all its features, the changed ones with
  `status: "changed"` (or `"new"` for a sketched feature) and a `note` saying what changed.
- Show which part you mean: `patch` the model's `params.parts`, such as
  `{"pocket_1": {"highlight": "orange"}}` (read_me("3d")); keep `title` and `camera` in `params`.
- Put a short answer next to each Mark: `{ "op": "add", "type": "note", "text": "…", "at": { "near": "m1" } }`.
  Say what you understood ("Pocket: offset 10 mm from the outline, so 100 × 60 mm") and anything
  that doesn't fit, such as a wall a new offset would make too thin.

Then `wait_for_user(after: <send>)`.
