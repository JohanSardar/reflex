---
kind: guide
name: charts
summary: Explore data with a grid of charts the person marks up: lassoed outliers come back as rows, a drawn trend as data points, a crossed-out chart as a cross.
---
# Chart markup

Lay out a few exploratory charts. The person lassoes points and writes or says "what are these?",
crosses out a chart that doesn't help, and draws the trend they expected on another. You get each
Mark in the chart's data: the rows it lassoed, the line as data points. Answer about those rows.

## Set it up: one call

Add each chart (read_me("chart")) and arrange them in a grid, in one `apply`:

```json
{ "space": "sensors", "ops": [
  { "op": "add", "id": "temp-vs-load", "type": "embed", "template": "chart", "w": 520, "h": 360,
    "params": { "kind": "scatter", "title": "Temperature vs load", "x_label": "Load (%)", "y_label": "°C",
      "series": [ { "name": "Pumps", "rows": [ { "id": "P-07", "x": 42, "y": 61 }, { "id": "P-12", "x": 48, "y": 94 } ] } ] } },
  { "op": "add", "id": "temp-by-week", "type": "embed", "template": "chart", "w": 520, "h": 360,
    "params": { "kind": "line", "title": "Mean temperature by week", "unit": "°C",
      "series": [ { "name": "All pumps", "rows": [ { "label": "W1", "y": 60 }, { "label": "W2", "y": 61 } ] } ] } },
  { "op": "arrange", "ids": ["temp-vs-load", "temp-by-week"], "layout": "grid", "columns": 2, "gap": 32 }
] }
```

- Give every row an `id` you can look up again (a unit, a customer, a run): that is what comes back.
- Keep the data you plotted: to answer you look rows up by `id`.
- For a review note and a "Send review" button beside the grid, add `recipe("review-legend", {"title": "Mark up the charts"})`.

## Read the markup

Each Mark on a chart has `on: [<chart>]` and a `target` in data coordinates:

- **Lasso or circle** around points: `{"kind": "data", "rows": ["P-12", "P-31"], "x": [47, 55], "y": [90, 97]}`,
  every row inside it. "What are these?" (in `said`, or a `writing` Mark next to it) is about these rows.
- **A line drawn across the plot** (their expected trend, a threshold): `target.points`, the line as
  `[x, y]` pairs in data coordinates in the order drawn, with its `x` and `y` range and the `rows` it
  passes over. On a bar or line chart with categories, x is the category's index from 0 (the label
  names them). The Mark's kind is `strike`, `arrow` or `ink` depending on its shape: read a line with
  `points` as a drawn line, unless it is a `cross`.
- **Crossed out**: a `cross` (two strokes, an X) on the chart, or a `strike` from corner to corner.
  Treat it as "drop this chart".
- A bar, point, axis tick or legend entry the Mark touches is in `rows` (read_me("chart")).

## Answer

Reply with `apply(in_reply_to: <send>)`:

- About lassoed rows: name them and what sets them apart, in a note `at: {near: "m1"}`. Look at the
  rows' other columns in your data, not just x and y. To mark them on the chart itself,
  `patch` its `params` with every series (`set.params` replaces them all), the rows in their own series.
- About a drawn trend: compare it with the data (its slope, where the data leaves it) in a note
  beside the Mark. If they asked for it, add a chart of the residuals.
- A crossed-out chart: `remove` it and `arrange` the rest, or replace it with the chart they need.

Then `wait_for_user(after: <send>)`.
