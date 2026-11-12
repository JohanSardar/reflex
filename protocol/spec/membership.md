# Shared Spaces

## 1. Owner and members

A Space's **owner** is the person whose Link made it. They invite other people as **editors** (who may draw and send) or **viewers** (who may read). Each person reaches the Space through their own Link, which meets the owner's Link; their own iPads sync with their own Link as for any Space. An Agent sees a shared Space only if its person is in it, and its own Elements there are its person's.

## 2. Invites

```
reflex://invite?v=0&i=<invite>&s=<secret>&sp=<space>&r=<editor|viewer>&d=<device>&k=<key>&h=<host,host>&p=<port>&u=<relay>&pi=<owner>&pn=<owner name>
```

An invite is single use and expires after 24 hours. The invited person's Link presents it to the owner's Link (the device in `d`, `k`), over the LAN (`h`, `p`) or through the Relay (`u`), in the invite's own Relay room (`hex(sha256("reflex-relay/v0 invite room " ‖ secret))[0..32]`), which only the invite's holders can name. The handshake carries `invite: <i>` and proves the secret, as pairing does (identity.md §3). The owner's Link then records the member and sends the share record and the Space key to their Link, inside the end-to-end session (`share`, transports.md §4), so the Relay only ever carries the key sealed.

## 3. The share record

The membership is a **share record**, signed by the owner's Link:

```json
{ "v": 0, "space", "kind", "owner": {"id", "name"}, "device", "key",
  "members": [{"person": {"id", "name"}, "role": "editor|viewer", "device", "key", "since"}],
  "removed": [{"person", "at"}], "rev", "epoch", "relay", "at" }
```

`sig` is Ed25519 by `key` over the text `reflex-link/v0 share ` followed by the record's JSON. A Link keeps the newest record (highest `rev`) signed by the same key as the one it has, or, the first time, by the owner's Link it reached. It passes it on to every member's Link and the owner's other Links.

## 4. Who may write what

Every change a device sends is checked by the receiving kernel against a **writers** rule, from the receiver's newest share record, never from the writer's own view: a stroke an editor made offline and synced after becoming a viewer is refused. The rule is JSON given to the kernel's `receive_sync_message_checked(peer, msg, writers)`:

| Sender | `writers` |
|---|---|
| the person's own iPad | `{"people": ["<person>"]}` |
| the person's own other Link (unshared Space) | `{"people": ["<person>"], "agents": "*"}` |
| the person's own other Link (shared Space) | `{"any": true}`: it passes on what the owner's Link sent it |
| the owner's Link, to a member | `{"any": true}` |
| a member's Link (editor), to the owner's | `{"people": ["<member>"]}` |
| an editor's or the owner's iPad | `{"people": ["<their person>"]}` |
| a viewer's device, a web viewer, a stranger | `{"people": [], "agents": []}` |

A change touching any record its rule doesn't allow refuses the whole message; the receiver answers `refused` (transports.md §4), and sync of that Space with the sender stops until the sender drops its refused changes, starts the Space over from the receiver and answers `reset`. A Space syncs at all only with the person's own devices, and between the owner's Link and its members' Links.

## 5. Removing someone, and key epochs

Removing a member records it in `removed` and moves the Space to a new key: `epoch` goes up, so the Space has a new encrypted log on the Relay (transports.md §6). The removed person's devices never get the new key. A role change takes effect at the next record and needs no new key.
