---
kind: recipe
name: experiment-board
summary: A morning experiment review: loss curves, an ablation table, your claims, and the queue of runs the person ticks or kills.
---
# experiment-board

Lays out last night's results for a review by hand: a line chart of the loss curves, the ablation
table beside it, a note with your claims below the chart, and the queue of runs waiting to start
below the table. The person circles a suspicious cliff on a curve, ticks the runs to keep and
strikes the ones to kill, then presses Send. read_me("experiment-review") says how to read their
Marks and answer.

- `curves`: chart series, one per run: `{name, rows: [{x: step, y: loss}, …]}`. Give each row an
  `id` such as `run-7@12000` so a circled cliff names the run and step.
- `ablation_columns`, `ablation_rows`: as the table Embed (read_me("table")).
- `queue_rows`: each queued run with `status: "queued"` (or `running`), its `id` the run's name.
- `claims`: what you conclude, one claim per line, short.

## Params

```json params
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "maxLength": 120,
      "default": "Overnight runs"
    },
    "curves": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 60
          },
          "rows": {
            "type": "array",
            "minItems": 1,
            "maxItems": 500,
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "maxLength": 100
                },
                "x": {
                  "type": "number"
                },
                "y": {
                  "type": "number"
                }
              },
              "required": [
                "x",
                "y"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "name",
          "rows"
        ],
        "additionalProperties": false
      },
      "description": "Loss curves: one series per run, x the step and y the loss."
    },
    "y_label": {
      "type": "string",
      "maxLength": 60,
      "default": "val loss"
    },
    "ablation_columns": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          },
          "label": {
            "type": "string",
            "maxLength": 60
          },
          "unit": {
            "type": "string",
            "maxLength": 12
          },
          "numeric": {
            "type": "boolean"
          }
        },
        "required": [
          "key"
        ],
        "additionalProperties": false
      }
    },
    "ablation_rows": {
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 80
          },
          "cells": {
            "type": "object"
          },
          "status": {
            "type": "string",
            "maxLength": 20
          },
          "best": {
            "type": "boolean"
          }
        },
        "required": [
          "cells"
        ],
        "additionalProperties": false
      }
    },
    "claims": {
      "type": "string",
      "description": "Your claims, one per line.",
      "minLength": 1,
      "maxLength": 2000
    },
    "queue_columns": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          },
          "label": {
            "type": "string",
            "maxLength": 60
          },
          "unit": {
            "type": "string",
            "maxLength": 12
          },
          "numeric": {
            "type": "boolean"
          }
        },
        "required": [
          "key"
        ],
        "additionalProperties": false
      },
      "default": [
        {
          "key": "name",
          "label": "Run"
        },
        {
          "key": "change",
          "label": "Change"
        },
        {
          "key": "gpu_h",
          "label": "GPU h"
        }
      ]
    },
    "queue_rows": {
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 80
          },
          "cells": {
            "type": "object"
          },
          "status": {
            "type": "string",
            "maxLength": 20
          },
          "best": {
            "type": "boolean"
          }
        },
        "required": [
          "cells"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "curves",
    "ablation_columns",
    "ablation_rows",
    "claims",
    "queue_rows"
  ],
  "additionalProperties": false
}
```

## Template

```json template
[
  {"op": "add", "type": "text", "id": "title", "text": "# {{title}}", "markdown": true, "w": 1240},
  {"op": "add", "type": "embed", "id": "curves", "template": "chart", "w": 640, "h": 400, "at": {"below": "title", "gap": 16}, "params": {"kind": "line", "title": "Loss curves", "x_label": "step", "y_label": "{{y_label}}", "series": "{{curves}}"}},
  {"op": "add", "type": "embed", "id": "ablation", "template": "table", "w": 560, "h": 280, "at": {"right_of": "curves", "gap": 40}, "params": {"title": "Ablation", "columns": "{{ablation_columns}}", "rows": "{{ablation_rows}}"}},
  {"op": "add", "type": "note", "id": "claims", "color": "yellow", "w": 640, "text": "{{claims}}", "at": {"below": "curves", "gap": 24}},
  {"op": "add", "type": "embed", "id": "queue", "template": "table", "w": 560, "h": 300, "at": {"below": "ablation", "gap": 24}, "params": {"title": "Queued runs", "columns": "{{queue_columns}}", "rows": "{{queue_rows}}", "note": "Tick a run to keep it, strike it to kill it, then Send."}}
]
```

## Example

```json example
{"title": "Overnight runs: 7 Nov", "curves": [{"name": "baseline", "rows": [{"id": "baseline@0", "x": 0, "y": 3.2}, {"id": "baseline@4000", "x": 4000, "y": 2.4}, {"id": "baseline@8000", "x": 8000, "y": 2.1}]}, {"name": "lr-3e-4", "rows": [{"id": "lr-3e-4@0", "x": 0, "y": 3.2}, {"id": "lr-3e-4@4000", "x": 4000, "y": 2.2}, {"id": "lr-3e-4@8000", "x": 8000, "y": 2.9}]}], "ablation_columns": [{"key": "variant", "label": "Variant"}, {"key": "loss", "label": "Val loss"}], "ablation_rows": [{"id": "full", "cells": {"variant": "Full", "loss": 2.1}, "best": true}, {"id": "no-warmup", "cells": {"variant": "− warmup", "loss": 2.4}}], "claims": "Warmup matters: −0.3 loss.\nlr 3e-4 diverges after 6k steps.", "queue_rows": [{"id": "run-8", "cells": {"name": "run-8", "change": "lr 2e-4", "gpu_h": 12}, "status": "queued"}, {"id": "run-9", "cells": {"name": "run-9", "change": "no RoPE", "gpu_h": 12}, "status": "queued"}]}
```
