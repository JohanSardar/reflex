# Owners are people or Agents from day one; shared Spaces are built on top

Reflex starts with one person per Space, but several people drawing on the same Space from their own devices is a planned feature. The CRDT already merges edits from many devices, so the missing parts sit above it: who owns an Element, whose undo is whose, who sent a Send, and who may join. If the protocol and kernel stored "the user" as a single implicit owner, sharing a Space later would mean migrating every Space ever written. So from the first schemas, every owner is a principal (a person or an Agent) with a stable ID, undo is per person rather than per device, and every Send records who sent it. The sharing feature itself (invites, roles, presence, key handling) comes later and adds no migration.

- **Membership and roles** (owner, editor, viewer) live in the signed control catalog and are checked at the writer's causal frontier, like every other authorization (ARCHITECTURE §7).
- **Presence** (cursors, names, selections) is short-lived and never written into the Space, so it doesn't grow history or slow merges.
- **Encryption:** each Space has one key held by every member's devices. Invites wrap it for the new device through an existing member's device. Removing a person rotates it. A copy the removed person already synced can't be recalled.
- **Speed:** each person's own strokes commit locally and never wait for the network. People nearby sync over the local network; people elsewhere through the Relay.

## Considered Options

- **Keep a single implicit user and add people later.** Rejected: every stored owner, undo record and Send would need migrating.
- **A server-authoritative shared Space on the Relay.** Rejected for the same reasons as in ADR-0001: local writes would wait on the internet, and the Relay would have to read the Space.
