---
kind: guide
name: drawing-critique
summary: Critique a sketch without touching it: corrections on an overlay the person can hide or show, a short critique, and one drill.
---
# Sketch critique

The person shows you a sketch: drawn with the Pencil, or a photo of paper. You never change it.
You draw your corrections on a separate, transparent layer over it, which the person hides and
shows with two buttons, and you end with exactly one drill for the biggest problem.

## Look at the sketch

1. Find it: `read` the Space; their strokes and images are `by` them. Its bounds are the union of
   its strokes' bounds (or the image's).
2. Look at it: `look(ids: [...])` for the picture; `read(ids: [...], detail: "strokes")` for exact
   points, so your corrections land on the right lines.

## Set it up

One call: `recipe("sketch-critique", {...}, at: {x, y})` with the sketch's top left as `at` and its
size as `w` and `h` (read_me("sketch-critique")). Items are in the overlay's pixels:
Space point (x, y) becomes (x − sketch x, y − sketch y).

```json
{ "space": "sketchbook", "name": "sketch-critique", "at": { "x": 120, "y": 200 }, "params": {
  "w": 600, "h": 400,
  "items": [
    { "id": "horizon", "kind": "line", "points": [[0, 150], [600, 150]], "color": "blue", "style": "dashed", "text": "One eye level" },
    { "id": "left-wall", "kind": "arrow", "points": [[80, 60], [40, 150]], "text": "Converge to the left VP" },
    { "id": "door", "kind": "circle", "box": [260, 190, 90, 140], "text": "Door too tall" } ],
  "critique": "Strong: confident line, clear silhouette.\nFix first: the walls use two horizons, so the corner bends.",
  "drill": "Draw five boxes in two-point perspective on one horizon line, 2 minutes each." } }
```

Keep 3 to 6 corrections, the most important first; a numbered dot marks each. Name what works
before what to fix.

## After

- The Hide and Show buttons toggle the overlay on the iPad without you. If the person asks you to,
  `patch` the overlay's params with `visible` (always send `items` too).
- Wait for the drill: `wait_for_user(region: "drill")`. Look at what they drew and answer next to
  it with one line on whether it fixed the problem.
