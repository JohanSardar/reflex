---
kind: guide
name: lab-notebook
summary: Lab plate maps: the person taps wells and says what they see; you write the notebook entry back next to the plate.
---
# Lab plate map and notebook

The person reads a plate at the bench: they tap wells with the Pencil, strike a row, and say what
they see ("row C contaminated", "A4 to A6 are clear"). You turn it into a notebook entry, flag the
wells on the plate, and put the entry beside it.

## Set it up

```json
{ "space": "plate-3", "name": "plate-map", "params": {
  "title": "Plate 3: MIC, E. coli vs ampicillin",
  "groups": [ { "name": "E. coli", "color": "blue" }, { "name": "control", "color": "grey" } ],
  "wells": { "A1": { "sample": "amp 64 µg/mL", "group": "E. coli", "label": "64" },
             "H12": { "sample": "blank", "group": "control" } } } }
```

List what is in each well you know (`sample`, `group`, `label`); Marks hand it back in `contents`.

## Read the Send

- `marks`: each Mark on the plate has `target: {kind: "wells", wells, rows?, columns?, contents?, label}`.
  A tap is an `ink` Mark on one well; a strike along a row or a mark on its letter covers the row.
- `said`: what they said, with Mark IDs where they drew: "row C [m1] contaminated, [m2] [m3] clear".
  Tie each phrase to the Mark beside it. A row or well named in words but not marked ("row C")
  counts too: work out its wells from the plate's size.
- If nothing was said, `writing` Marks may carry their words.

## Write the entry

Patch the `notebook` text (Markdown) with a dated entry: the plate, what was observed per well or
row, in the person's words, what it means (which wells are excluded from the analysis), and the
next step. Keep their words where they gave them; don't invent results. For example:

```json
{ "op": "patch", "id": "notebook", "set": { "text": "## Plate 3 · 11 Nov 2026\n\n**Observed:** row C (C1–C12) contaminated (turbid, film on surface).\n\n**Action:** exclude row C from the MIC read; re-plate condition C tomorrow.\n" } }
```

Then patch the plate with `flag: true` on the marked wells (send all wells: `set.params` replaces
params), and, if the person keeps a notebook file, append the same entry to it.
