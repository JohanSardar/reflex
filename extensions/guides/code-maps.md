---
kind: guide
name: code-maps
summary: Lay out a coding plan or architecture as a dependency graph the person can mark up.
---
# Code maps and plan reviews

Draw the plan as a graph: one shape per task, service or file, and a connector per dependency. The person reviews it with the Pencil and their voice, and their Marks come back anchored to your IDs.

## Lay it out

- Give every node an ID that names it (`t-auth`, `svc-users`, `f-session-ts`). The person's Marks come back as those IDs.
- Put each node's detail in `data` (ticket, owner, file path, estimate). Reflex stores it, returns it in `read` and Sends, and never interprets it.
- Use `shape: "rounded"` for tasks and services, `"rect"` with `stroke: "dashed"` for things that don't exist yet, and `fill: "tint"` with a `color` per area or owner.
- Add the edges as connectors (`from`, `to`, optional `text` such as "calls" or "blocks"), then `arrange` with `layout: "tree"` so dependencies flow down. For more than about 30 nodes, `exec` with `space.layout.force` spreads them out.
- Put a `frame` around each phase or area, with a `title`.

```json
[
  { "op": "add", "id": "t-gateway", "type": "shape", "shape": "rounded", "text": "API gateway", "fill": "tint", "color": "blue" },
  { "op": "add", "id": "t-auth", "type": "shape", "shape": "rounded", "text": "Auth service", "data": { "ticket": "PLAT-12" } },
  { "op": "add", "id": "t-users", "type": "shape", "shape": "rounded", "text": "User service" },
  { "op": "add", "type": "connector", "from": "t-gateway", "to": "t-auth", "text": "JWT" },
  { "op": "add", "type": "connector", "from": "t-gateway", "to": "t-users" },
  { "op": "arrange", "ids": ["t-gateway", "t-auth", "t-users"], "layout": "tree", "gap": 60 }
]
```

## Read the review

The person circles a task, draws an arrow from one task to another, writes a word next to it, strikes out what should go, and says what they mean. The Send Bundle reads like review comments:

- `circle` with `on: [ids]`: what they are talking about.
- `arrow` with `from` and `to`: a relation they want (merge, move, depends on).
- `strike` with `on`: remove or drop it.
- `writing` with `text_guess`, `confidence` and `near`: a note. Check the image when the confidence is low.
- `said` places Mark IDs where they drew them while talking: "merge these [m1] [m2]" means the Elements in m1 and m2.

Answer next to what they marked: `apply(in_reply_to: <send>)` with notes placed `at: {near: "m1"}`, change your own nodes, and `remove` what they struck out if they meant it. Then `wait_for_user(after: <send>)`.
