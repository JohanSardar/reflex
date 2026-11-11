# prototype

A UI or web page prototype the person marks up with the Pencil. Give it your page's body HTML and
its CSS; it is drawn as a static page (scripts don't run, links and forms do nothing), at the
Embed's size, so size it like the screen you're designing: `w: 390, h: 844` for a phone,
`w: 1024, h: 720` for a desktop page.

```json
{ "op": "add", "id": "checkout", "type": "embed", "template": "prototype", "w": 390, "h": 700,
  "params": {
    "html": "<header id=\"top\"><h1>Checkout</h1></header><form id=\"pay\"><label>Card <input id=\"card\"></label><button id=\"pay-btn\">Pay €42.00</button></form>",
    "css": "header{padding:16px;background:#f5f5f7} form{padding:16px;display:grid;gap:12px} button{padding:10px;border-radius:8px;border:0;background:#0071e3;color:#fff}" } }
```

Give each element you expect comments on an `id` or `data-id`: Marks name it by that.

## What a Mark on it says

```json
{ "id": "m1", "kind": "circle", "on": ["checkout"],
  "target": { "kind": "dom", "selector": "#pay-btn", "label": "button#pay-btn \"Pay €42.00\"",
    "nodes": [ { "selector": "#pay-btn", "tag": "button", "id": "pay-btn", "text": "Pay €42.00", "box": [16, 220, 358, 40] } ] } }
```

- a circle: the largest elements inside it (`nodes`, outermost first), or the element it was drawn in
- a strike, underline or arrow: the elements under the line; an arrow from one element to another
  also has `start` and `end` selectors
- handwriting next to an element comes as a `writing` Mark with `text_guess`, `near` the Embed;
  match it to the DOM Mark drawn just before it, or read both Marks' `bounds`
- `box` is in the prototype's own pixels (0, 0 is its top left)

## Answer

Change your markup for exactly the nodes named, then remove the Embed and add it again with the
same `id` and the new `html` (or `patch` `set: {params: {...}}` with both `html` and `css`).
Say which selectors you changed, so the person can check them.
