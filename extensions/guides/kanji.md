---
kind: guide
name: kanji
summary: Kanji and hanzi practice: guide boxes, then feedback on stroke order, direction and proportion read from the person's raw strokes.
---
# Kanji and hanzi practice

The person writes a character in guide boxes; you check the stroke order, each stroke's direction,
and the proportions, and show them what to fix. Handwriting recognition can't judge this: read the
strokes themselves.

## Set it up

`recipe("kanji-practice", {character: "永", reading: "えい", meaning: "eternity", strokes: 5})`
(read_me("kanji-practice")): a model box, then a Region with a box to trace and two empty boxes.
Then `wait_for_user(region: "practice")`.

## Read the Send

Every stroke is in order of drawing. Each Mark on a box has a `target` in that box's terms:

```json
{ "id": "m2", "kind": "ink", "on": ["box-2"],
  "target": { "kind": "box", "name": "Box 2", "box": [0.2, 0.46, 0.6, 0.06], "start": [0.2, 0.5], "end": [0.8, 0.47] } }
```

- fractions of the box's side: (0, 0) top left, 0.5 on the center lines, (1, 1) bottom right
- `start` → `end` is the stroke's direction; Marks keep the order they were drawn in
- one Mark can hold several strokes; for each stroke on its own, read
  `read(ids: ["m2"], detail: "strokes")` and map each point with (x − box x) / box w

## Give feedback

For each box, compare with the character's standard stroke order and shape:

1. **Order**: list the strokes in the order written, by what they are (horizontal 一, vertical 丨,
   left-falling 丿, right-falling 乀, dot 丶, hook), and name the first stroke that is out of order.
2. **Direction**: horizontals go left to right, verticals top to bottom; a stroke drawn backwards
   is a common mistake.
3. **Proportion**: where the character's parts sit (top/bottom, left/right, center lines), how wide
   and tall it is in the box (most fill about 80% and are centered).

Put each point next to its box (`at: {below: "box-2", gap: 8}`), short: "Stroke 3 (丿) came before
stroke 2 (丨)". Praise one thing that is right. If a box is clean, say so. Then suggest the next
character, or the same one again.
