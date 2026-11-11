---
kind: guide
name: behaviors
summary: Make Elements interactive with trigger-action Behaviors and Panels.
---
# Behaviors and Panels

Any Element can carry `behaviors`: a list of `{ "on": trigger, "do": action }` pairs. The lists are fixed; their combinations are not.

Triggers: `tap`, `long_press`, `drag_end`, `ink_inside` (the person wrote inside it), `panel_change` (a value in its Panel changed), `embed_event` (with `event`, from `reflex.emit` in an Embed).

Actions:

| do | fields | what happens |
|---|---|---|
| `open_panel` | `panel` | The iPad opens the Panel (a sidebar or form). |
| `notify` | `payload` | You get a Send of kind `tap` with `element` and `payload`. Their turn goes on and nothing they drew is claimed. |
| `send` | `payload` | A full Send, as if they pressed Send. |
| `set` | `target`, `set` | Reflex sets those fields on `target` (default: this Element) as you, the Element's owner. |
| `apply_recipe` | `recipe`, `params` | Reflex applies the Recipe as you, next to this Element. |

Flags: `draggable`, `locked`, `snap`.

```json
{ "op": "add", "id": "t-auth", "type": "shape", "shape": "rounded", "text": "Auth service",
  "behaviors": [
    { "on": "tap", "do": "notify", "payload": { "task": "PLAT-12" } },
    { "on": "long_press", "do": "set", "set": { "color": "green" } },
    { "on": "tap", "do": "open_panel", "panel": { "title": "Auth service", "components": [ { "type": "text", "text": "Owner: Ana" } ] } }
  ] }
```

Notify arrives through `wait_for_user`; wait with `element: "t-auth"` to wait for a tap on that Element only.
