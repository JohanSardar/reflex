---
kind: guide
name: ui-review
summary: Review a UI or web page prototype by hand: show it live, read Marks anchored to DOM nodes, change only the nodes marked.
---
# UI and HTML prototype review

The person draws on your live prototype: circles a button, strikes a label, writes "too small"
beside a heading, draws an arrow from one element to where it should go. Each Mark comes back
anchored to the DOM nodes it points at.

## Set it up

Show the page with the `prototype` Embed Template (read_me("prototype")), sized like the screen.
Give every element you expect feedback on an `id` or `data-id`; Marks name nodes by them.

```json
{ "space": "checkout-review", "ops": [
  { "op": "add", "id": "proto", "type": "embed", "template": "prototype", "w": 390, "h": 720,
    "params": { "html": "<header id=\"top\"><h1>Checkout</h1></header><section id=\"summary\">…</section><button id=\"pay-btn\">Pay €42.00</button>",
                "css": "#pay-btn{margin:16px;padding:12px;border-radius:10px;background:#0071e3;color:#fff;border:0}" } },
  { "op": "add", "type": "note", "id": "ask", "text": "Mark anything you'd change, then Send.", "at": { "right_of": "proto" } } ] }
```

Then `wait_for_user`.

## Read the Send

- A Mark on the prototype has `target: {kind: "dom", selector, nodes: [{selector, tag, id, text, box}], label}`.
  A circle names the largest elements inside it; a strike or underline the elements under it; an
  arrow also gives `start` and `end` selectors (move `start` to `end`).
- Handwriting comes as a `writing` Mark with `text_guess`. It belongs to the DOM Mark it sits beside:
  compare `bounds`, or the order of Marks in `said`.
- If a `text_guess` has low `confidence`, look at the Mark's image before acting on it.

## Answer

Change only the nodes the Marks name, keep every other node and style as it was, and say which
selectors you changed:

```json
{ "space": "checkout-review", "in_reply_to": "s_3", "ops": [
  { "op": "patch", "id": "proto", "set": { "params": { "html": "…same markup, #pay-btn now 'Pay now · €42.00' and full width…", "css": "…" } } },
  { "op": "add", "type": "note", "text": "Changed #pay-btn: full width, clearer label. Nothing else.", "at": { "near": "m1" } } ] }
```

If the prototype is also a file in the person's repo, edit that file the same way, then update the
Embed from it.
