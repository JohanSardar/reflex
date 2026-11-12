# People, devices and Agents

## 1. Principals

- A **person** (`p_…`) is who draws and sends. Their name travels with their ID: `{id, name}`.
- A **device** belongs to one person. Its long-term key is Ed25519, and its ID is derived from the key: `dev-` and the first 16 hex digits of SHA-256 of the 32-byte public key. A device can't claim another's ID.
- An **Agent** (`a_…`) is a program the person approved, hosted by their Link. An Agent's ID comes from its credential, never from what it says.

Every change in a Space is stamped with a principal from the authenticated context (ADR-0008): a device writes as its person, a Link's Agent layer as the Agent. Nothing in a message's arguments can choose who it is from.

## 2. Kinds of device

| Kind | Writes as |
|---|---|
| `ipad` (any drawing client) | its person only |
| `link` | its person, and the Agents it hosts |
| browser (web viewer) | nobody: it reads |

## 3. Pairing

A new device becomes a person's by scanning, or pasting, a **pairing code** that one of that person's devices shows:

```
reflex://pair?v=0&o=<offer>&d=<device>&k=<key>&s=<secret>&h=<host,host>&p=<port>&n=<name>&pi=<person>&pn=<person name>
```

| | |
|---|---|
| `o` | the offer's ID |
| `d`, `k` | the showing device's ID and Ed25519 public key (base64url) |
| `s` | a 32-byte secret (base64url): single use, expires after 10 minutes |
| `h`, `p` | addresses and the TCP port to reach it on |
| `n` | the showing device's name |
| `pi`, `pn` | whose device the new one becomes |

The new device connects to one of `h`, runs the handshake (transports.md §3) with `pair: <offer>` in its hello, and checks the device that answered has exactly `d` and `k`, so a code can't be answered by whoever holds the address. Both sides prove they know `s` (the `mac` in their `auth`). Then each records the other's key: from now on, that key and only that key is that device.

`v=0` is the pairing code's format version, which v1 keeps (versioning.md §2).

## 4. Approving an Agent

An Agent asks its Link for access the first time it connects, with a local credential (its MCP server or CLI runs on the Link's machine). The person approves or refuses it on a device of theirs: in the Link's terminal, or on an iPad, which the Link asks with `agent_request` and which answers `agent_decision` (transports.md §4). A Link takes a decision only from an iPad of its own person that paired as the person: by scanning a code the Link showed itself, or as the first iPad, during setup. A later iPad paired with a code a command made syncs but can't approve; the Link answers its decision with `agent_decision_refused`. The Link answers every `agent_decision` with `agents`, which says whether that device may approve (`approver`). A device keeps its answer until `agents` shows that Agent no longer pending, and sends it again on each new Path, so an answer given while a Path is down isn't lost. Requests and answers carry `requested_at`: an answer to an earlier request for the same Agent is ignored. `agents` tells the person's devices every Agent the Link knows, so they label Agent changes. Until approved, every tool returns `not_approved`. An approved Agent has its own ID, name and colour (`agent_names`); refusing it later stops its tools and its pushes at once.
