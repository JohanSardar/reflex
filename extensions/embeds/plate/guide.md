# plate

A plate map: rows lettered A, B, …, columns numbered 1, 2, …; 96 wells (8 × 12) by default. The
person taps wells with the Pencil, circles a block, or strikes a row, and talks while they do it
("row C contaminated"). It needs no network. A 96-well plate reads well at `w: 620, h: 470`.

```json
{ "op": "add", "id": "plate-3", "type": "embed", "template": "plate", "w": 620, "h": 470,
  "params": { "title": "Plate 3: MIC assay", "rows": 8, "columns": 12,
    "groups": [ { "name": "E. coli", "color": "blue" }, { "name": "control", "color": "grey" } ],
    "wells": { "A1": { "sample": "E. coli 0.5 µg/mL", "group": "E. coli", "label": "0.5" },
               "H12": { "sample": "blank", "group": "control" } } } }
```

## What a Mark on it says

```json
{ "id": "m1", "kind": "strike", "on": ["plate-3"],
  "target": { "kind": "wells", "wells": ["C1", "C2", "…", "C12"], "rows": ["C"], "label": "row C (12 wells)" } }
```

- a tap (a dot) on a well: that well (taps come as `ink` Marks; read `target.wells`)
- a circle: every well whose center is inside it; a strike along a row: the wells it crosses
  (`rows` lists any row it covers whole)
- a mark on a row letter or a column number: the whole row (`rows`) or column (`columns`)
- `contents` gives each marked well's `sample`, `group`, `label` and `flag`, from your params

What they said comes in `said`, with Mark IDs where they drew: "row C [m1] contaminated".

## Show what they marked

Patch the plate with `flag: true` on the wells they marked (`set.params` replaces all params, so
send the wells you keep), and write the notebook entry beside it: read_me("plate-map").
