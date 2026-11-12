# Versioning

## 1. What v1 promises

Reflex Protocol v1 is the schemas in `schema/`, the examples in `examples/`, the tool text in `tool-text/`, these pages, and the conformance profiles in `tests/conformance/`. It follows semver:

- A **minor** version (1.1) MAY add optional fields, enum values, error codes, session messages and tools' optional arguments. A reader MUST ignore a session message `t` it doesn't know, and MUST treat an unknown error code as its `fix` says. It MUST NOT reject an unknown enum value in a field it only shows.
- A **major** version (2.0) changes the meaning of something that exists, or removes it.
- A **patch** version fixes text, examples and fixtures.

Every closed object stays closed: a minor version adds a field to the schema, it never relaxes `additionalProperties`. So a v1.0 writer's messages always validate against v1.x.

## 2. Wire identifiers

The strings on the wire keep their v0 spelling in v1, so devices already in people's hands keep talking:

| | |
|---|---|
| `reflex-link/v0` | handshake protocol, and the prefix of every signed or MACed text |
| `reflex-relay/v0` | Relay protocol, its key derivations and its rooms |
| `v: 0`, `?v=0` | the handshake hello's version; pairing codes and invites |
| `/v0/connect`, `/v0/log/...` | the Relay's paths |

They name the version of the bytes, not of this document. They change only with a major version that changes those bytes.

## 3. The kernel

Clients interoperate by embedding the kernel published with the protocol (README). Its storage and sync encoding are not part of v1, so a new kernel MAY change them. It SHOULD sync with the previous minor release's kernel, and MUST read Spaces the previous one saved.
