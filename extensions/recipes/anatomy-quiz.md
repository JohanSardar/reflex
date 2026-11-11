---
kind: recipe
name: anatomy-quiz
summary: A 3D heart the person turns, labels by Pencil and is quizzed on: the model, the task, and a quiz Panel with your questions.
---
# anatomy-quiz

Places the built-in 3D heart (`builtin:heart`: chambers, great vessels, pulmonary veins and both
coronary arteries, each a named part), a note with the task, and a "Take the quiz" button that
opens a Panel with your questions. The person turns the heart with a finger, writes vessel names on
or beside the vessels with the Pencil, and presses Send; then taps the quiz, answers, and submits.
read_me("anatomy") says how to grade labels and answers.

`quiz` is a list of Panel components (read_me("behaviors")): give each question a `choice` with an
`id`, and end with a `button` whose `do` is `send`. The answers arrive in the Send's `changes` as
`panel` values, by component `id`.

## Params

```json params
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "maxLength": 120,
      "default": "The heart: great vessels"
    },
    "task": {
      "type": "string",
      "maxLength": 600,
      "default": "Turn the heart with a finger. Write the name of each great vessel on it with the Pencil (aorta, pulmonary trunk, superior and inferior vena cava, pulmonary veins), then Send."
    },
    "quiz": {
      "type": "array",
      "minItems": 1,
      "maxItems": 40,
      "items": {
        "type": "object"
      },
      "description": "Panel components: choice questions (kind, id, label, options) and a send button."
    }
  },
  "required": [
    "quiz"
  ],
  "additionalProperties": false
}
```

## Template

```json template
[
  {"op": "add", "type": "embed", "id": "heart", "model": "builtin:heart", "w": 640, "h": 540, "params": {"title": "{{title}}", "camera": {"yaw": 0, "pitch": 5, "zoom": 1}}},
  {"op": "add", "type": "note", "id": "task", "color": "yellow", "w": 320, "text": "{{task}}", "at": {"right_of": "heart", "gap": 40}},
  {"op": "add", "type": "shape", "id": "quiz", "shape": "rounded", "fill": "solid", "color": "blue", "text": "Take the quiz", "w": 200, "h": 48, "at": {"below": "task", "gap": 24}, "behaviors": [{"on": "tap", "do": "open_panel", "panel": {"id": "quiz-panel", "title": "Quiz", "components": "{{quiz}}"}}]}
]
```

## Example

```json example
{"title": "The heart: great vessels", "task": "Write the name of each great vessel on it with the Pencil, then Send.", "quiz": [{"kind": "choice", "id": "q1", "label": "Which vessel carries oxygen-poor blood to the lungs?", "options": ["Aorta", "Pulmonary trunk", "Pulmonary veins", "Superior vena cava"]}, {"kind": "button", "label": "Submit", "do": "send"}]}
```
