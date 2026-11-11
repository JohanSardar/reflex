Change a Space with one batch of ops. The batch is atomic: if any op fails, nothing is applied, and the error lists every failing op with a fix. It is also one unit for revert.

Ops (op field):
- add: a new Element. type is text, note, math, shape, connector, image, frame, region or embed, with its fields at the top level (shape: "rect", text: "Auth service"). Extension types put their fields in props; call read_me(type) first. Pick a short id such as "n-auth" so you can refer to it later; Reflex makes one if you don't.
- patch: change one of your Elements. set replaces fields, unset clears them, text_insert and text_delete edit text at UTF-16 offsets, list_* edit lists, and map_put and map_delete change one key of data.
- remove: delete your Elements by ids.
- arrange: lay out Elements in a row, column, grid or tree.
- focus: point your own view, which look uses. It never moves the person's screen.
- define: save a Recipe or an Embed Template to the person's Library so every Agent can reuse it.

Placement: give at a relation (right_of, left_of, above, below, near, inside) to an Element ID or a Mark ID from a Send, plus an optional gap; Reflex computes the position. Use at: {x, y} only when you need an exact spot. Connectors bind by ID with from and to and follow their ends.

Every Element can carry data, your own JSON map (a task ID, a score), which Reflex returns but never interprets. behaviors pair a trigger (tap, long_press, drag_end, ink_inside, panel_change, embed_event) with an action (open_panel, notify, send, set, apply_recipe).

Pass in_reply_to with the Send you are answering; that acknowledges it. The result gives the batch ID, any IDs Reflex made or changed (use those from then on), the mistakes it repaired, and lints such as text covering Ink, each with a fix. You can change only your own Elements, and never a person's Ink.
