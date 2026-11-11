# Every Space is a CRDT document replicated on every node

Many writers touch a Space at once: the user on one or more devices, local agents through Reflex Link, and remote agents through the Relay. Any of them can be offline, and the same change may arrive over several connections at once. We store each Space as a CRDT document with a full replica on every node (iPad, Link, Relay), instead of making the iPad or a central server authoritative. This is what lets "keep every connection alive and use the fastest one" work: a connection only carries changes, it never decides what is true. It also gives us offline editing and a complete history to build on. It does not give us ownership enforcement, user-only undo or per-Agent revert. Those need their own layer: authenticated writers, immutable ownership, and compensating operations.

## Considered Options

- **The iPad is authoritative.** Rejected: agents stall whenever iOS suspends the app.
- **The Relay is authoritative.** Rejected: every local write would go through the internet, which rules out ultrafast local use.

## Amendment (2026-11-10)

The Relay does not keep a materialized replica. It stores a complete encrypted copy of every change, and materializes the Space only for a cloud Agent session (ADR-0004).
