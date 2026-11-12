---
kind: guide
name: grading
summary: Help a teacher grade a scanned paper: propose marks as a tappable overlay, read which they accepted, struck out or wrote themselves, and score it against the rubric.
---
# Teacher grading

You propose marks on a student's scanned paper; the teacher decides. They tap a proposed mark to
accept it, strike one out to reject it, and write their own beside an answer. When they tap
"Send grades", you score the paper against the rubric from what they decided, never from your
proposals alone.

## Set it up: two calls

1. `recipe("grade-paper", {"paper": "/path/to/scan.pdf", "title": "Quiz 3 · Maya", "rubric": "…"})`
   places the paper (`paper`), the rubric, a note on how to grade and the "Send grades" button.
   `read(ids: ["paper"], detail: "full")` gives the paper's `bounds`; look at it (`look`) to find each
   answer on the page, and place your marks in those coordinates.
2. One `apply` with your proposed marks, each next to the answer it is about. Give each one:
   - red text, short: "✗ −1 sign error", "✓ 2/2", "½ missing units".
   - `data`: the question, the rubric criterion, the points it gives or takes, and `status: "proposed"`.
   - a tap that accepts it: `set` turns it green and sets `status: "accepted"`. `set.data` replaces the
     whole map, so repeat every field.

```json
{ "space": "quiz-3", "ops": [
  { "op": "add", "id": "pm-q1", "type": "text", "text": "✓ 2/2", "color": "red", "size": "m",
    "at": { "x": 700, "y": 210 },
    "data": { "question": "q1", "criterion": "q1", "points": 2, "of": 2, "status": "proposed" },
    "behaviors": [ { "on": "tap", "do": "set", "set": { "color": "green",
      "data": { "question": "q1", "criterion": "q1", "points": 2, "of": 2, "status": "accepted" } } } ] },
  { "op": "add", "id": "pm-q2", "type": "text", "text": "✗ −1 used d, not r", "color": "red", "size": "m",
    "at": { "x": 640, "y": 470 },
    "data": { "question": "q2", "criterion": "q2", "points": 1, "of": 2, "status": "proposed" },
    "behaviors": [ { "on": "tap", "do": "set", "set": { "color": "green",
      "data": { "question": "q2", "criterion": "q2", "points": 1, "of": 2, "status": "accepted" } } } ] }
] }
```

Place marks in the margin beside the answer, never over the student's writing, so the teacher can
strike one without touching the answer. Then `wait_for_user()`.

## Read the teacher's decisions

The "Send grades" tap is a full Send (`trigger: "behavior"`, `payload.grading`). In it:

- **Accepted**: `changes` has `{"kind": "behavior", "id": "pm-q1", "on": "tap", "set": {"color": "green", "data": {…"status": "accepted"}}}`
  for each mark they tapped since their last Send, and that mark is in `scene` with its new `data`.
- **Rejected**: a `strike` (or `cross`) Mark with `on: ["pm-q2"]`.
- **Their own mark**: a `writing` Mark with `text_guess` ("−1", "3/4", "units!"), `near` the answer or
  the proposed mark it sits beside, and `bounds` on the paper. Check its image when `confidence` is
  under about 0.8; a number misread changes the score.
- A proposed mark with none of these is undecided: say so, and don't count it.

Marks from earlier Sends stay decided: keep a list per question as Sends arrive.

## Score it

For each rubric criterion, take the teacher's own mark if there is one, else the accepted proposal;
a rejected proposal gives nothing until they say what instead. Answer with `apply(in_reply_to: <send>)`:

- turn rejected marks grey (`patch` `set: {"color": "grey"}`) and put a ✓ beside the teacher's own;
- a score card beside the rubric: one line per criterion with its points and whose mark it was
  (accepted, teacher, undecided), the total, and two lines of feedback for the student written from
  the teacher's marks.

Then `wait_for_user(after: <send>)`.
