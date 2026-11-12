# document

Prose the person marks up with the Pencil: a title, paragraphs, and a blank margin on the right
for their notes. It needs no network. Size it so the text fits: about 70 words per 100 px of
height at `w: 820`.

```json
{ "op": "add", "id": "essay", "type": "embed", "template": "document", "w": 820, "h": 760,
  "params": { "title": "Methods", "paragraphs": [
    { "id": "p1", "text": "We trained every model for 40 epochs. Learning rates were tuned on the validation split." },
    { "id": "p2", "text": "The baseline uses the same data. It differs only in its attention layer." } ] } }
```

Each paragraph's sentences are numbered `<id>.s1`, `<id>.s2`, … in reading order.

## What a Mark on it says

```json
{ "id": "m1", "kind": "ink", "on": ["essay"],
  "target": { "kind": "text", "paragraphs": ["p1"], "sentences": ["p1.s2"],
    "quote": "Learning rates were tuned on the validation split.",
    "text": "Learning rates were tuned on the validation split.", "label": "bracket beside p1.s2" } }
```

- a bracket (a tall stroke in the margin or at the left edge): every sentence on the lines it spans
- a circle: the sentences it touches, and `quote`, the words inside it
- a strike or an underline: the words it runs along (`quote`) and their sentences, with `gesture:
  "strike"` (through the middle of the words: cut or replace them) or `gesture: "underline"` (along
  their bottom: emphasis, or a question about them)
- a note written in the margin: the sentence beside it (`label: "margin note beside p2.s1"`) and
  the note itself as a `writing` Mark with `text_guess`; read its strokes if the guess is unsure

## Change only what was marked

Rewrite only the sentences the Marks name. Patch the Embed with every paragraph, the untouched ones
word for word, and list what you changed in `changed` so the person sees it:

```json
{ "op": "patch", "id": "essay", "set": { "params": { "title": "Methods", "changed": ["p1.s2"],
  "paragraphs": [ { "id": "p1", "text": "We trained every model for 40 epochs. We tuned learning rates on a held-out split, never the test set." },
                  { "id": "p2", "text": "The baseline uses the same data. It differs only in its attention layer." } ] } } }
```

`set.params` replaces all params. Keep paragraph IDs stable so later Marks still line up.
