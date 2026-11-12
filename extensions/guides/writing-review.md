---
kind: guide
name: writing-review
summary: Mark up writing by hand: brackets, circles and margin notes on a passage, and revisions that change only what was marked.
---
# Writing and paper markup

The person reads your draft (or theirs) and marks it like paper: brackets beside a passage,
circles around words, underlines, strikes, and notes in the margin. You revise exactly what they
marked and nothing else.

## Set it up

Show the text with the `document` Embed Template (read_me("document")): one entry per paragraph,
with stable IDs. Keep each paragraph's sentences as they are, so `p2.s3` keeps meaning the same
sentence.

```json
{ "space": "paper-intro", "ops": [
  { "op": "add", "id": "draft", "type": "embed", "template": "document", "w": 820, "h": 900,
    "params": { "title": "1. Introduction", "paragraphs": [
      { "id": "p1", "text": "Large models are expensive to train. We show that a smaller model, trained longer, matches them." },
      { "id": "p2", "text": "Prior work focused on scale. It ignored data quality, which we find matters more." } ] } } ] }
```

Then `wait_for_user`.

## Read the Send

Each Mark on the text has `target: {kind: "text", paragraphs, sentences, quote, label}`:

- a bracket in the margin or at the left edge: the sentences on the lines it spans
- a circle: `quote` is the words inside it
- a strike or underline: `quote` is the words it runs along; `gesture: "strike"` usually means cut or
  replace them, `gesture: "underline"` questions or stresses them
- a note written in the margin: the sentence beside it (`label: "margin note beside p2.s1"`), and
  the note's words as a `writing` Mark with `text_guess` near it

Pair each `writing` Mark with the text Mark nearest it (their `bounds`), and read `said` for
anything spoken.

## Answer: change only what was marked

1. For each marked sentence, write the revision the mark asks for. Leave every unmarked sentence
   exactly as it was, word for word.
2. Patch the Embed with all paragraphs and list the sentences you changed in `changed`:

```json
{ "op": "patch", "id": "draft", "set": { "params": { "title": "1. Introduction", "changed": ["p2.s2"],
  "paragraphs": [
    { "id": "p1", "text": "Large models are expensive to train. We show that a smaller model, trained longer, matches them." },
    { "id": "p2", "text": "Prior work focused on scale. It mostly set data quality aside; we find it matters more than size." } ] } } }
```

3. Add a short note beside each change saying what you did, `at: {near: "<mark>"}`. If a mark is
   unclear, ask in the note instead of guessing.

If the text is a file in the person's repo, apply the same edits there, touching only those
sentences.
