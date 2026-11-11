---
kind: guide
name: experiment-review
summary: The morning experiment review: show loss curves, an ablation and your claims; read circled cliffs and ticked or killed queued runs; act on them.
---
# Morning experiment review

Overnight runs finished. You lay out the loss curves, the ablation table, and what you conclude.
The person circles anything suspicious ("this cliff?"), ticks the queued runs to keep, strikes the
ones to kill, and Sends. You answer from the Send alone and update the queue.

## Set it up

One call: `recipe("experiment-board", {...})` (read_me("experiment-board")). Give curve points
`id`s like `lr-3e-4@6000`, and queued runs `id`s equal to their run names.

```json
{ "space": "runs-nov-7", "name": "experiment-board", "params": {
  "title": "Overnight runs: 7 Nov",
  "curves": [ { "name": "lr-3e-4", "rows": [ { "id": "lr-3e-4@0", "x": 0, "y": 3.2 }, { "id": "lr-3e-4@6000", "x": 6000, "y": 2.0 }, { "id": "lr-3e-4@7000", "x": 7000, "y": 3.1 } ] } ],
  "ablation_columns": [ { "key": "variant", "label": "Variant" }, { "key": "loss", "label": "Val loss" } ],
  "ablation_rows": [ { "id": "full", "cells": { "variant": "Full", "loss": 2.1 }, "best": true } ],
  "claims": "lr 3e-4 is best through 6k steps.",
  "queue_rows": [ { "id": "run-8", "cells": { "name": "run-8", "change": "lr 3e-4, 20k steps", "gpu_h": 24 }, "status": "queued" } ] } }
```

## Read the Send

- A circle on the chart: `target: {kind: "data", rows: ["lr-3e-4@7000", …], x: [6500, 7000], y: […]}`.
  That is a run and a step range: say what happened there (a divergence, a data-loader restart, a
  learning-rate step) using what you know of the run, and whether it changes a claim.
- On the queue: a `check` Mark with `target.rows: ["run-8"]` keeps that run; a `strike` or `cross`
  kills it. A Mark on a row's cells counts for the row.
- On the ablation: a circled cell or row questions that number.
- Writing next to a Mark (`writing`, `text_guess`) is their comment on it.

## Answer

1. Reply next to each circle with what it is, `at: {near: "m1"}`.
2. Update the queue: patch the `queue` table with `status: "approved"` or `"killed"` for each run
   they marked, and `highlight` those rows (`set.params` replaces all params; send every row).
3. If you can, act on it: cancel the killed runs and start the approved ones with the person's own
   tools, and say what you ran.
4. If a circle undermines a claim, patch the `claims` note.
