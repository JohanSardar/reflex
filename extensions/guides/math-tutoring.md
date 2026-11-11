---
kind: guide
name: math-tutoring
summary: Tutor math and physics by hand: set a problem, grade the person's handwritten working line by line, and give hints beside the Ink.
---
# Math tutoring

The person works a problem by hand in a Region and presses its "Check my work" button. You get their working line by line, mark each line in the margin, and give hints next to the Ink. They learn by fixing it themselves, so never hand over the full solution unless they ask.

## Set the problem

```json
{ "name": "check-my-work", "space": "algebra", "params": { "problem": "3x - 7 = 2x + 5", "prompt": "Solve for x. One step per line." } }
```

`recipe("check-my-work", …)` places the prompt, the problem typeset from LaTeX (`problem`), and a Region `work` with the button. One problem per call; a second call gets fresh IDs (`work-2`), listed in the result. Then `wait_for_user(region: "work")`.

## Read their work

A Send from the Region (`trigger: "region"`) carries only what is inside it. Its handwriting comes back as one `writing` Mark per line, top to bottom:

```json
{ "id": "m2", "kind": "writing", "line": 2, "text_guess": "3x - 2x = 5 - 7", "confidence": 0.86, "bounds": [39, 238, 294, 26], "image": 1 }
```

- `text_guess` is the iPad's reading. Image 1 shows the whole Region: check a line there when `confidence` is under about 0.8, when a guess makes no sense, or before you call something an error. Misread symbols (`-` and `=`, `x` and `×`, `5` and `s`) are common.
- On a second Check, the lines already graded come back too, with `earlier: true`, so the line numbers hold. Grade the lines without it.
- A line with `kind: "ink"` wasn't read: read it from the image.
- Raw strokes: `read(ids: ["m2"], detail: "strokes")`.

## Grade step by step

Check each line against the line before it, not against the final answer. The question for line k is: does it follow from line k−1?

1. Find the first line that doesn't follow. Everything before it is right.
2. Decide what kind of mistake it is:
   - **A slip**: the method is right but one operation went wrong: a sign flipped when moving a term across, a dropped negative, 7 + 5 written as 13, a term copied wrong. The person knows what to do. Name the move and where, not the fix: "Check the sign of 7 when it crosses the =."
   - **A gap in understanding**: the method itself is wrong, or the same kind of mistake repeats: subtracting from one side only, dividing one term but not the others, squaring a sum term by term, treating mass as weight. Point at the idea, with a question or a smaller case: "What has to happen to both sides when you subtract 2x?"
3. Lines after the mistake that follow correctly from it show good method. Mark them as consistent rather than wrong, and say the error carried through.
4. For a physics problem, also check units on each line and that the quantities match the situation.

When every line follows and the answer is right, say so briefly, and offer a harder problem.

## Mark the margin

Answer with `apply(in_reply_to: <send>)`. Put marks just right of each line, by the line's Mark ID, never over the Ink:

```json
[
  { "op": "add", "type": "text", "text": "✓", "color": "green", "size": "l", "at": { "right_of": "m1", "gap": 24 } },
  { "op": "add", "type": "text", "text": "✗", "color": "red", "size": "l", "at": { "right_of": "m2", "gap": 24 } },
  { "op": "add", "type": "note", "text": "Check the sign of 7 when it crosses the =.", "color": "yellow", "at": { "right_of": "m2", "gap": 70 } },
  { "op": "add", "type": "text", "text": "follows from line 2", "color": "grey", "size": "s", "at": { "right_of": "m3", "gap": 24 } }
]
```

- One hint per mistake, on the line where it happened, short enough to read at a glance. One hint at a time works best: fix the first error, then Check again.
- To show math in a hint, add a `math` Element with LaTeX next to the note.
- Then `wait_for_user(region: "work", after: <send>)`. When they correct a line, they write the fix below it or beside it and press Check again.

## Watch mode

With `watch: true` (the Recipe's param, or `patch` `set: {watch: true}` on the Region), you also get snapshots of the Region while the person writes: `kind: "watch"`, with the same lines, and `user_still_writing: true` when they were mid-flow. Snapshots are debounced and budgeted, and a newer one replaces one you haven't read.

- A snapshot is not their turn. Usually say nothing; never grade every line as it appears.
- Step in only when a line is wrong and they have written past it, or have stopped for a while on it. Use a light touch: a small "?" or a short hint beside that line. When `user_still_writing` is true, wait for the next snapshot unless the mistake is blocking them.
- Acknowledge each snapshot with `wait_for_user(after: <send>)`, as for any Send. The Region's own Send button still carries the full work when they are done; grade properly then.
- Turn it off with `patch` `set: {watch: false}` when you no longer need it.

## Regions

A Region's rules are fields: `ink: false` keeps the person's Ink out (an answer key or a worked example), `agents_read_only: true` keeps every Agent out (the person's private scratch space), `watch` turns watch mode on, and `send_button` is its button's label.
