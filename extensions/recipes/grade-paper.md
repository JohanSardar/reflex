---
kind: recipe
name: grade-paper
summary: A scanned paper with its rubric beside it and a "Send grades" button, ready for your proposed marks as a tappable overlay.
---
# grade-paper

Places the scanned paper (`paper`: a picture or PDF on this computer, or an https URL; a PDF shows its
first page), the rubric beside it as Markdown, a note telling the teacher how to grade, and a
"Send grades" button that sends their grading. The paper is locked, so writing on it never moves it.

Then add your proposed marks over the paper in one `apply`, each one tappable to accept:
read_me("grading") shows the overlay and how to score what comes back.

## Params

```json params
{
  "type": "object",
  "properties": {
    "paper": { "description": "The scan: a file path on the Link's computer (/…, ~/…) or an https URL.", "type": "string", "minLength": 1, "maxLength": 4096 },
    "title": { "type": "string", "minLength": 1, "maxLength": 120, "default": "Grading" },
    "rubric": { "description": "The rubric in Markdown: each criterion with its id and points.", "type": "string", "minLength": 1, "maxLength": 4000 },
    "button": { "type": "string", "minLength": 1, "maxLength": 40, "default": "Send grades" }
  },
  "required": ["paper", "rubric"],
  "additionalProperties": false
}
```

## Template

```json template
[
  { "op": "add", "type": "text", "id": "title", "text": "{{title}}", "size": "l", "w": 800 },
  { "op": "add", "type": "image", "id": "paper", "src": "{{paper}}", "alt": "{{title}}", "w": 800, "locked": true, "at": { "below": "title", "gap": 16 } },
  { "op": "add", "type": "text", "id": "rubric", "text": "{{rubric}}", "markdown": true, "w": 380, "at": { "right_of": "paper", "gap": 40 } },
  { "op": "add", "type": "note", "id": "how", "color": "yellow", "w": 380, "text": "Red marks are proposed.\n• Tap one to accept it (it turns green)\n— Strike one out to reject it\n✎ Write your own mark beside the answer\nThen tap Send grades.", "at": { "below": "rubric", "gap": 24 } },
  { "op": "add", "type": "shape", "id": "send-grades", "shape": "rounded", "text": "{{button}}", "fill": "solid", "color": "blue", "w": 200, "h": 56, "at": { "below": "how", "gap": 24 },
    "behaviors": [ { "on": "tap", "do": "send", "payload": { "grading": "{{title}}" } } ] }
]
```

## Example

```json example
{ "paper": "/Users/ana/scans/quiz-3-maya.pdf", "title": "Quiz 3 · Maya", "rubric": "## Rubric\n- **q1** Solves 2x + 3 = 11 (2 pts)\n- **q2** Area of a circle, r = 3 (2 pts)", "button": "Send grades" }
```
