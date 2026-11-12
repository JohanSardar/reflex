# Changelog

## 1.0.0

The first published version. Compared with the v0 draft:

- **Schema `$id`s** moved from `https://reflex.eilmer.si/protocol/v0/` to `/protocol/v1/`, and a Relay now serves every schema at its `$id` (spec/transports.md §8).
- **Wire schemas**, new: `handshake`, `session`, `relay`, `viewer` and `webhook`, one `oneOf` tagged by `t`, with an example of every message. The bytes on the wire are unchanged; their identifiers keep the v0 spelling (spec/versioning.md §2).
- **`intent`**, new: what a person's device writes through the kernel (spec/operations.md §5).
- **TypeScript types**, generated: `generated/ts/protocol.d.ts`.
- **The written spec**, new: `spec/`.
- **Conformance profiles**, new: `tests/conformance/` (kernel, viewer, drawing, send-adapter, relay), with the 13 SPEC §16 scenarios as fixtures.
- `check` fails when a message of a wire schema has no example, and checks the webhook example's Bundle against `send-bundle`.

Fixed in Reflex's implementations while writing the profiles (no schema change):

- Kernel: a bracket drawn on a document Embed no longer reads as an arrow from the document to itself.
- Kernel: in a Region Send, strokes an Embed answered with `surface: "writing"` stay one Mark on that Embed instead of being pooled into lines.
- Relay on Cloudflare: a device that disconnects is now reported offline to the devices watching it.
