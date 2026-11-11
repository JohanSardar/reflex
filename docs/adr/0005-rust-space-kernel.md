# One sans-IO Rust kernel owns Space semantics; the Agent-facing layer is TypeScript

The iPad (Swift), Reflex Link, the Relay and the web viewer (TypeScript) all read and write Spaces. If each language implemented the logical-to-CRDT mapping separately, a disagreement wouldn't be a cosmetic bug. It would be a malformed document copied to every replica. So one Rust kernel holds the mapping, user and Agent batch application, ownership and Region policy, undo and revert planning, scene projection, Send freezing, migrations and text measurement. Swift binds to it through UniFFI and TypeScript through WASM.

The kernel is sans-IO: events and bytes go in, effects and bytes come out. It owns no sockets, files, clocks or threads. Its API is a small set of coarse calls, and Pencil samples never cross it; a finished stroke crosses once. Everything the Agent sees is TypeScript: tool descriptions, the Send Bundle projection, lint wording, MCP, CLI, Send Adapters, recipes. Iteration speed matters most there, and that is where contributors are. Renderers stay native on each platform. All three CRDT candidates are Rust cores already, so this adds no new runtime. It also removes our dependence on immature Swift CRDT bindings and the Swift/npm version-pairing problem.

## Considered Options

- **Duplicate the semantics in Swift and TypeScript, checked by trace tests.** Rejected: permanent drift in the most dangerous code.
- **Run a TypeScript kernel in JavaScriptCore on the iPad.** Rejected: there's no JIT in-process on iOS, WASM support there is uncertain, and it puts a chatty bridge on the hot path.
- **Fallback if the first kernel ticket (T2) finds the bindings don't work or the Swift and TypeScript copies don't converge, or no one will own Rust:** a thin iPad that commits raw user intents and raw Sends, a TypeScript-only core, and a CRDT mapping generated for both languages from one declarative table.
