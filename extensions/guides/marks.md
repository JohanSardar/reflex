---
kind: guide
name: marks
summary: How the person's Ink comes back in a Send: Mark kinds, Anchors, the transcript, files and taps.
---
# Marks: what the person drew

Every group of strokes the person drew since their last Send is one Mark in `marks`, with an ID (`m1`, `m2`, …) that holds for that Send.

| kind | fields | means |
|---|---|---|
| `circle` | `on` | They circled these Elements. |
| `arrow` | `from`, `to` | An arrow from one Element to another. Either end can be missing when it starts or ends in empty space. |
| `strike` | `on` | A line through it: drop it, or it is wrong. |
| `underline` | `on` | Emphasis. |
| `check`, `cross` | `on` | Accept or reject. |
| `writing` | `text_guess`, `confidence`, `near` | Handwriting, read on the iPad. `near` is the Element or Mark it sits beside. |
| `ink` | `near`, `note` | Not recognized. Look at its image, or read its raw strokes. |

- In a Send from a Region (`trigger: "region"`, or a `watch` snapshot), handwriting comes as one `writing` Mark per line, top to bottom, with `line` and `stroke_count`; lines an earlier Send from that Region carried come again with `earlier: true`. read_me("math-tutoring") shows how to grade them.
- `bounds` is where the Mark is, in your coordinates. `image` names the image that shows it.
- When a target moved after the Mark was drawn, the Mark has `moved_since_marked: true` and `marked_at` (where it was).
- `target` says where inside an Embed the Mark points, when the Embed could tell.
- Raw strokes: `read(ids: ["m3"], detail: "strokes")`.

## What they said

`said` is the iPad's transcript. When they spoke while drawing, Mark IDs sit where they drew each Mark: "merge these [m1] [m2] into one service".

## What they changed

`changes` lists what they moved, erased, edited or added since their last Send, values entered in Panels, and files: `added_file` with `file` and `mime`. A photo or a PDF page is an image Element and comes with an image; any other file is read with `read(ids: [id], detail: "full")`, which returns its text.

## Kinds of Send

- `send`: their turn is over. Answer, then `wait_for_user(after: <send>)`.
- `tap`: a `notify` Behavior fired on `element`, with its `payload`. Their turn goes on.
- `watch`: a snapshot of a watched Region; `user_still_writing` says whether they are mid-stroke.

Place answers next to Marks with `at: {near: "m1"}` (or `right_of`, `below`, …) in `apply(in_reply_to: <send>)`.
