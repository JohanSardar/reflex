# Native Element types are closed per release; extensions climb a ladder of data and web content

The App Store forbids downloaded executable native code. A third-party Element type that needs a Swift renderer could therefore never reach users of the store build. Reflex grows by new domains, not new internals, so the extension path is a ladder. Each rung costs less than the one above it, and every rung except the last ships without an app release:

0. a guide (Markdown)
1. a recipe (one Markdown file with a JSON template)
2. an Embed template (HTML plus a small manifest, with the anchor bridge)
3. a declarative Element type
4. a native Element type, contributed by pull request

Built-in types can be special: Ink in particular doesn't go through the contributor contract.

Plugins never add MCP tools or CLI commands, and never grow the always-loaded server instructions. The tool list is fixed, so Agent behavior and prompt caching don't depend on what one user installed. Internal seams (CRDT engine, storage, crypto, identity, transports) are ordinary internal interfaces, not plugin kinds. Each one becomes a public contract only after a second real implementation exists.
