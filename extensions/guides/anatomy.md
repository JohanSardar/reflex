---
kind: guide
name: anatomy
summary: 3D anatomy learning: a heart the person turns and labels by Pencil, graded part by part, then a quiz in a Panel.
---
# 3D anatomy: label the heart

The person turns a 3D heart, writes the vessels' names on it with the Pencil, and Sends. You grade
each label against the part it was written on, then quiz them.

## Set it up

```json
{ "space": "anatomy", "name": "anatomy-quiz", "params": {
  "quiz": [
    { "kind": "choice", "id": "q1", "label": "Which vessel carries oxygen-poor blood to the lungs?", "options": ["Aorta", "Pulmonary trunk", "Pulmonary veins", "Superior vena cava"] },
    { "kind": "choice", "id": "q2", "label": "Which chamber pumps blood into the aorta?", "options": ["Right atrium", "Right ventricle", "Left atrium", "Left ventricle"] },
    { "kind": "button", "label": "Submit", "do": "send" } ] } }
```

The model is `builtin:heart` (read_me("3d") for 3D Embeds). Its parts: `left_ventricle`,
`right_ventricle`, `left_atrium`, `right_atrium`, `aorta`, `pulmonary_trunk`,
`superior_vena_cava`, `inferior_vena_cava`, `pulmonary_veins`, `left_coronary_artery`,
`right_coronary_artery`. It is simplified and viewed from the front: the person's left on screen is
the heart's right side. Use your own anatomy model by giving its URL or path instead
(read_me("3d")).

## Grade the labels

Each label is handwriting on the model. Its Mark names the part it was written on, and the camera:

```json
{ "id": "m1", "kind": "writing", "text_guess": "aorta", "confidence": 0.8, "on": ["heart"],
  "target": { "kind": "part", "part": "aorta", "parts": ["aorta", "left_atrium"], "label": "part aorta" } }
```

- Compare `text_guess` with the part's name, ignoring case, spacing and underscores; accept common
  names ("SVC", "pulmonary artery" for the trunk).
- A label written beside a part rather than on it can name a neighbour: check `parts`, and look at
  the Mark's image.
- If the guess is unsure (`confidence` below 0.5), say what you read before grading it.

Answer with one note per label, next to it: "✓ aorta" or "✗ that's the pulmonary trunk, not the
aorta". Highlight correct parts green and wrong ones red by patching the Embed's `params.parts`
(read_me("3d")), and keep the title and camera.

## The quiz

The person taps "Take the quiz", picks answers and taps Submit: a Send whose `changes` hold the
Panel's values by component `id` (`{"q1": "Pulmonary trunk"}`). Grade each, explain the wrong ones
in a sentence, and offer to quiz the chambers or the coronary arteries next.
