# chart

A live chart: bars, a line, or a scatter of points, drawn in the person's Space on the iPad and in
the web viewer. It needs no network. Place it with data in one call (for a grid of charts the person marks up, read_me("charts")):

```json
{ "op": "add", "id": "revenue", "type": "embed", "template": "chart", "w": 640, "h": 400,
  "params": { "kind": "bar", "title": "Revenue by quarter", "y_label": "Revenue", "unit": "M€",
    "series": [ { "name": "Revenue", "rows": [
      { "id": "2024-Q1", "label": "2024-Q1", "y": 3.1 }, { "id": "2024-Q2", "label": "2024-Q2", "y": 3.6 },
      { "id": "2024-Q3", "label": "2024-Q3", "y": 2.2 }, { "id": "2024-Q4", "label": "2024-Q4", "y": 4.4 } ] } ] } }
```

- `bar`: one bar per `label`; several series sit side by side.
- `line`: points joined in the order given, at their `label` (or numeric `x`).
- `scatter`: points at numeric `x` and `y`.

Give each row an `id` you can look up again; it defaults to the label (or x). To change the data,
`patch` its `params` with all of them (`set.params` replaces the whole set).

## What a Mark on it says

When the person circles, strikes or points an arrow at the chart, the Mark's `target` says what it
points at, frozen when they sent it:

- a bar or point: `{"kind": "data", "rows": ["2024-Q3"], "y": [2.2, 2.2], "label": "bar 2024-Q3 (Revenue 2.2 M€)"}`
- several bars or points: every row, with the x and y range they cover
- an axis tick: `{"kind": "data", "rows": [...the rows at that tick], "label": "x-axis tick 2024-Q3"}`
- a series in the legend: all its rows, `"label": "series Revenue"`
- a line drawn across the plot: `points`, the line as `[x, y]` pairs in data coordinates in the order drawn (x is a category's index from 0 on a bar or line chart), with its `x` and `y` range and the `rows` it passes over: `{"kind": "data", "points": [[0, 3], [1.5, 3.6], [3, 4.5]], "x": [0, 3], "y": [3, 4.5], "rows": ["2024-Q2"], "label": "a line from 2024-Q1, 3 M€ to 2024-Q4, 4.5 M€, over 1 point"}`

Answer about the rows the Mark names, next to the Mark.
