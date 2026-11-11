# The Relay stores an encrypted log and decrypts only under a temporary grant

Without a key, the Relay can't run merges, queries or rendering, so it can't be an ordinary CRDT replica as ADR-0001 first described. The Relay stores a complete, recoverable, encrypted copy of every change and asset, and routes encrypted updates between devices. When the user approves a cloud Agent, a device issues a scoped, expiring grant for one Space and one key epoch. Only under that grant does an execution context decrypt the Space, materialize it, and run the same core. When the grant expires or is revoked, execution stops. Revocation can't make anyone forget plaintext that was already exposed, so we tell users that cloud Agents necessarily see the Spaces they're granted.

## Consequences

- Cloudflare Workers cap memory at 128 MB per isolate, including WASM. Cloud execution runs inside a Durable Object first. If a real materialized Space runs out of memory there, cloud execution moves to a separate service, and the Durable Object stays the encrypted router and store.
