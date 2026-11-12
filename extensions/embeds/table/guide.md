# table

A table the person reads and marks up with the Pencil: an ablation, a comparison, or a queue of
runs with a status. It needs no network. Each row is about 40 px tall, plus 50 for the header
and title.

```json
{ "op": "add", "id": "ablation", "type": "embed", "template": "table", "w": 560, "h": 220,
  "params": { "title": "Ablation", "columns": [
      { "key": "variant", "label": "Variant" }, { "key": "val_loss", "label": "Val loss" }, { "key": "acc", "label": "Accuracy", "unit": "%" } ],
    "rows": [
      { "id": "full", "cells": { "variant": "Full model", "val_loss": 1.92, "acc": 71.4 }, "best": true },
      { "id": "no-rope", "cells": { "variant": "− RoPE", "val_loss": 2.05, "acc": 69.8 } } ] } }
```

With a `status` on any row the table gets a Status column; `queued`, `running`, `done`, `approved`,
`killed` and `failed` are styled (`killed` rows are struck through).

## What a Mark on it says

```json
{ "id": "m2", "kind": "check", "on": ["queue"],
  "target": { "kind": "data", "rows": ["run-7"], "columns": ["name", "lr"], "label": "row run-7 (lr-sweep-3e-4)",
    "cells": [ { "row": "run-7", "column": "name", "value": "lr-sweep-3e-4" } ] } }
```

- a tick (`check`) or a strike across a row: that row. In a queue of runs, a tick approves it and a
  strike (or a `cross`) kills it.
- a circle: the cells inside it, their rows and columns (`cells` lists up to 12 with their values)
- a circle around a column heading: that column, every row

To show the person's decision, patch the table with the new statuses (`set.params` replaces all
params), and `highlight` the rows you changed.
