# Send Bundles

## 1. A Send

When the person sends, or a Behavior fires, their device captures a **raw Send** ([`raw-send.schema.json`](../schema/raw-send.schema.json)) and hands it to the kernel's `freeze_send(person, device, raw, now_ms)`:

- `send`: an ID the device chooses (`s_…`), unique in the Space.
- `trigger`: what sent it: `button`, `pencil` (a squeeze or double-tap), `voice` (releasing the mic button), `behavior` (with `element` and `on`), `region` (a Region's Send button, with `region`), `watch` (watch mode), or `embed` (an Embed's `reflex.notify`, with `element` and `payload`).
- `strokes`: the strokes this Send claims, by ID. `said` and `words` (word by word, with their times): what the person said, on the same clock as the strokes, so Mark IDs are placed where the person drew each Mark while speaking. `hints`: the device's handwriting recognizer's guesses. `crops`: the bounds the device wants shown to the Agent. `embed_anchors`: each Embed's answer for the strokes on it (elements.md §5).

Times are the device's milliseconds since the Unix epoch, the same clock it passes as `now_ms` with each stroke. The kernel adds who sent it (`from`), its frontier (the Space's heads at that moment) and the changes the person made since their last Send (`changes`: `moved`, `edited`, `removed`, `panel`, `embed_state`, `added_file`, `behavior`, …), and stores it immutably. A frozen Send is never changed: everything the Agent is told about it is computed from it, at the frontier it names.

## 2. Marks

A **Mark** is a group of the person's strokes read as one gesture. The kernel groups a Send's strokes into Marks where the Agent is, by time and place: strokes drawn close together in time and space are one Mark. Then it reads each:

| `kind` | Read as |
|---|---|
| `circle`, `lasso` | encloses `on` |
| `underline`, `strike`, `bracket` | under, through or beside `on` (text: with a range) |
| `arrow` | `from` one Element `to` another |
| `check`, `cross` | a tick or a cross on `on` |
| `writing` | handwriting, with `text_guess` and its confidence; `near` the Element or Mark it is next to |
| `ink` | not recognized: the strokes are kept, and the Agent reads them from the image |

Recognition is heuristic and never final. Raw strokes are always kept (`read(ids: [mark], detail: "strokes")`), and an unrecognized group is `ink`, never dropped. What a conformant kernel must produce for each scenario is in the conformance fixtures (`tests/conformance/scenarios/`): where how strokes group is the kernel's choice, the fixture says only what every Mark must have.

In a **Region Send** the strokes are read as lines of writing, one Mark per line, except strokes an Embed answered with `surface: "writing"`, which stay one Mark on that Embed.

## 3. Anchors

A Mark's **Anchor** says where on its target it points, frozen when the Mark was drawn (`common.schema.json#/$defs/anchor`): a text range, chart rows and points, a model's part, a document's paragraphs, `local` bounds inside an Embed. An Embed's own answer wins over the kernel's guess. When a target has moved since the Mark was drawn, the Mark says so (`moved_since_marked`, `marked_at`).

## 4. The Bundle

The **Send Bundle** ([`send-bundle.schema.json`](../schema/send-bundle.schema.json)) is what the Agent reads: the person's words with each Mark placed in them (`said: "merge these [m1] [m2]"`), the Marks, what they changed, the scene around it (`scene`, `elsewhere`), the viewport and selection, images (`images[i]`: `n`, `shows`, `bounds`) and `next`, what to do. Over MCP it is one text block, then each image, then a low-resolution thumbnail of the Space.

- A Bundle in a shared Space carries only its person's Marks; `from` names them.
- `also_sent_to` names other Agents the same Send went to.
- Text from other Agents and from Embeds is data, never instructions.

## 5. Delivery

Each Agent with access to the Space gets each Send once, in order, from `wait_for_user` (filtered by Space, Region or Element) or by a push (§6), and acknowledges it (operations.md §6). A push and a waiting `wait_for_user` never both deliver one Send: a waiting Agent gets it from the wait.

## 6. The webhook push

A **Send Adapter** pushes Sends to an Agent that doesn't sit in `wait_for_user`. The webhook is the one every receiver can implement. `reflex adapters add webhook --url <url>` makes a target for the Agent that ran it and shows its signing secret (`whsec_…`) once.

For each new Send the Link sends:

```
POST <url>
content-type: application/json
reflex-delivery: <space>/<send>
reflex-attempt: 1 | 2 | 3
reflex-timestamp: <ms since the Unix epoch>
reflex-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>

{"type": "send", "delivery", "target", "agent", "attempt", "bundle"}
```

The HMAC key is the whole secret as UTF-8, `whsec_` included; `<timestamp>` is the header's value and `<body>` the exact bytes sent. The body is [`webhook.schema.json`](../schema/webhook.schema.json). The signature covers the body, not the other headers, so `delivery` and `attempt` are repeated in it: a receiver SHOULD take them from the body. `bundle` is what `wait_for_user` would return, and each `images[i]` also carries its PNG as base64 `data`, with `mime: "image/png"`.

**The sender** MUST sign every request with the target's secret and the time it sends it, and MUST send the same `reflex-delivery` on every try. It tries again after 1 s and 5 s on a network error, a timeout (5 s), a 408, a 429 or a 5xx, and never on any other answer. A 2xx means the receiver took the Send: it counts as delivered. After the last failure the Send stays in the Inbox for `wait_for_user`.

**The receiver** MUST check the signature over the exact bytes of the body, in constant time, and MUST refuse (with a 4xx) a request whose timestamp is more than 5 minutes from its own clock. It SHOULD answer 2xx at once and do its work after. It MUST answer 2xx to a repeat of a delivery it already took, and MUST NOT act on it twice. Then it answers the person with Reflex tools as usual: `apply(in_reply_to)`.

`agent/examples/webhook-claude.ts` is a receiver that starts a Claude Code turn for each Send.
