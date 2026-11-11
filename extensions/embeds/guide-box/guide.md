# guide-box

A square writing box with dashed center lines (田), red border, on cream paper. Use it for kanji,
hanzi, kana or letter practice. read_me("kanji-practice") sets up a model and three boxes in one
call.

```json
{ "op": "add", "id": "box-1", "type": "embed", "template": "guide-box", "w": 220, "h": 220,
  "params": { "character": "永", "show": "trace", "label": "Box 1" } }
```

`show`: `model` draws the character, `trace` draws it faint to write over, `empty` leaves only the
guide lines. The character is drawn in a Mincho (serif) face at about 82% of the box.

## What a Mark on it says

Each stroke the person draws in the box is placed in the box's own terms: fractions of its side,
0 at the top left, 0.5 on the center lines, 1 at the bottom right.

```json
"target": { "kind": "box", "name": "Box 1", "box": [0.18, 0.12, 0.62, 0.08],
  "start": [0.18, 0.16], "end": [0.8, 0.13], "label": "Box 1: x 0.18–0.8, y 0.12–0.2" }
```

`start` and `end` are where the stroke began and ended, so their order and direction show stroke
order. For the full path, `read(ids: [<mark>], detail: "strokes")`: points are in your coordinates;
subtract the box's top left and divide by its side (`w`) to compare them.
