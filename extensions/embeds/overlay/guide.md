# overlay

A transparent layer of corrections laid exactly over the person's sketch, photo or drawing. The
original underneath is never touched: Agents never edit the person's Ink, and this Embed only
draws on top of it. The person's Pencil still draws through it. read_me("sketch-critique") sets
one up with Show and Hide buttons and a drill in one call.

Place it with the same bounds as the sketch: read the sketch's strokes (or the image's bounds),
then add the overlay `at: {x, y}` of their top left with their `w` and `h`. Every coordinate in
`items` is in the overlay's own pixels: a point at Space (x, y) is at (x − overlay x, y − overlay y).

```json
{ "op": "add", "id": "fixes", "type": "embed", "template": "overlay", "at": { "x": 120, "y": 200 }, "w": 640, "h": 420,
  "params": { "visible": true, "items": [
    { "id": "horizon", "kind": "line", "points": [[20, 140], [600, 140]], "color": "blue", "style": "dashed", "text": "Eye level" },
    { "id": "door", "kind": "circle", "box": [300, 180, 80, 120], "text": "Door too tall" },
    { "id": "roof", "kind": "arrow", "points": [[420, 60], [470, 100]], "color": "orange", "text": "Converge here" } ] } }
```

Each item gets a numbered dot with its note. Keep notes to a few words; put the reasons in a note
Element beside the sketch.

## Toggle it

`patch` `set: {params: {...}}` with `visible: false` hides the corrections, `true` shows them.
`set.params` replaces all params, so always send `items` too. Two buttons with `set` Behaviors let
the person toggle it themselves, with no round trip (read_me("sketch-critique")).

## What a Mark on it says

A Mark the person draws over a correction names it: `{"kind": "correction", "items": ["door"],
"label": "correction door \"Door too tall\""}`. Elsewhere on the overlay it is
`{"kind": "local", ...}`: read the Mark's strokes to see what they drew.
