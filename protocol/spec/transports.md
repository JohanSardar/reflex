# Transports

## 1. Paths and sessions

A **Path** is any way two devices can exchange frames: a TCP connection on the LAN, an Apple peer-to-peer connection, or a channel through the Relay. A transport only carries frames; it never decides what is true and never authenticates. Every Path starts with the handshake (§3), which binds it to one device that proved its key, and then carries an encrypted **session** (§4). Everything above it is the same on every Path.

## 2. Framing

On a byte stream (LAN, peer-to-peer) every frame is `[u32 BE length][bytes]`. On the Relay a frame is one binary WebSocket message (§6). The handshake's three frames each way are plain JSON; every frame after is sealed (§3).

## 3. The handshake

[`handshake.schema.json`](../schema/handshake.schema.json). `PROTOCOL` is the string `reflex-link/v0`. The initiator (I) is the side that dialled; the responder is R.

```
I → R  hello  {t, v: 0, protocol, device, key, eph, person, name, kind, pair? | invite?}
R → I  hello  {t, v: 0, protocol, device, key, eph, person, name, kind}
I → R  auth   {t, sig, mac?}
R → I  auth   {t, sig, mac?}
```

- `key` is the device's Ed25519 public key and `eph` a fresh X25519 public key, each 32 raw bytes in base64url. `device` MUST be the ID derived from `key` (identity.md §1).
- `transcript = SHA-256(PROTOCOL ‖ I's hello ‖ R's hello)`, over the two hellos' bytes exactly as sent.
- `sig = Ed25519(key, "reflex-link/v0 auth <i|r> " ‖ transcript)`, where `<i|r>` is the signer's role.
- With a pairing code or an invite, `mac = HMAC-SHA256(secret, "reflex-link/v0 pair <i|r> " ‖ transcript)`, base64url. The initiator names the offer (`pair`) or the invite (`invite`) in its hello, and checks that R's `device` and `key` are those in the code.
- Each side then trusts the other only if it is already paired with exactly that key, or it proved a live offer's or invite's secret. Otherwise it sends `refused` and closes.
- Session keys: `HKDF-SHA256(ikm: X25519(eph, their eph), salt: transcript, info: "reflex-link/v0 session keys", 64 bytes)`; the first 32 bytes seal I → R, the last 32 R → I.
- Every later frame is `ChaCha20-Poly1305(key, nonce, plain, aad: transcript) ‖ tag(16)`, with the nonce a 64-bit big-endian counter from 0 in the last 8 of 12 bytes, one counter per direction. A dropped, reordered or replayed frame fails to open, and the session ends.

## 4. Session messages

Each sealed frame's plain text is `[u32 BE header length][header JSON][body bytes]`. The header is [`session.schema.json`](../schema/session.schema.json), tagged by `t`; only `sync` and `asset` carry a body. A device MUST ignore a `t` it doesn't know.

| Group | Messages |
|---|---|
| Sync | `spaces` (the Spaces the peer may sync, on every binding and change), `sync` (one kernel sync message; each is answered by the receiver's next one until both have nothing to send), `refused`, `reset` (membership.md §4) |
| Assets | `assets_have`, `asset_want`, `asset` (a part of an asset by its SHA-256 hash; the receiver keeps it only if the hash matches) |
| Liveness | `ping`, `pong`: a Path that goes silent is dropped |
| Agents | `agents` (with `approver`: whether this device's answers count), `agent_request`, `agent_decision` (both with the request's `requested_at`), `agent_decision_refused`, `agent_names` (identity.md §4) |
| Devices | `device_paired` (a new device of the person's, told to each of their iPads once), `approver_requests` and `approver_decision` ("Let … approve Agents?", between the Link and the person's approving iPads; identity.md §4) |
| Presence | `presence` (iPad to its Link: the Space on screen, pen, cursor), `hints` (handwriting in a watched Region), `here` (who is in a Space now) |
| Relay | `relay` (where the person's devices meet when nothing closer reaches them), `relay_keys` (Space keys for the Relay's log, between one person's Links) |
| Sharing | `share`, `shares`, `invite_create`, `invite`, `member_set`, `join_invite`, `joined`, `share_error` (membership.md) |

Sync state is restartable: on every new binding, and whenever the Path being sent on is lost, both sides reset it and run the kernel's anti-entropy from scratch. The same change arriving twice changes nothing.

## 5. LAN, peer-to-peer, and choosing a Path

- **LAN**: TCP, found by Bonjour as `_reflex-link._tcp` with TXT `dev=<device>`, `v=0`, or dialled at a pairing code's `h`/`p`.
- **Peer-to-peer**: Apple's peer-to-peer Wi-Fi, `_reflex-p2p._tcp` over Bonjour, with the same framing.
- **Relay**: §6, when no closer Path reaches the device.

A device MAY hold several Paths to one peer at once. It takes what arrives on any of them and sends on the fastest, chosen with hysteresis. If two Paths on one transport are open to the same peer (both dialled at once), both sides keep the one dialled by the lower device ID.

## 6. The Relay

`RELAY_PROTOCOL` is `reflex-relay/v0`. A device opens one WebSocket to `wss://<relay>/v0/connect?room=<room>`. A person's devices meet in `room = hex(SHA-256("reflex-relay/v0 room " ‖ person))[0..32]`; an invite has its own room (membership.md §2). Every JSON message is [`relay.schema.json`](../schema/relay.schema.json).

```
relay → device  {t: "challenge", nonce}
device → relay  {t: "hello", device, key, sig}     sig = Ed25519("reflex-relay/v0 hello <room> <nonce>")
relay → device  {t: "welcome", device}
device → relay  {t: "watch", devices: [...]}       the devices it accepts frames from; "*" any (an invite room only)
relay → device  {t: "presence", device, online, joined?}
```

- A hello whose signature or device ID doesn't check out is closed with code 4403. A second connection for one device replaces the first (4409).
- **Frames** between devices are binary messages, `[u8 n][n bytes: device ID][u32 BE channel][payload]`. The sender writes the receiver's ID; the Relay MUST rewrite it to the sender's before forwarding, and MUST forward only to a device that watches the sender; otherwise it answers `{t: "undeliverable", device, ch}`. The first frame on a channel opens it, and `{t: "close", device, ch}` closes it. Channel bit 31 is set by whoever opened it. Each channel is one Path: the handshake (§3), then sealed frames the Relay can't read.
- **Watching** tells a device whenever a device it watches comes or goes; `joined: true` says it connected anew, so channels to it are gone.

**The log.** The Relay keeps each Space as a log of sealed entries, so a device away from every other one still gets the Space, and a cloud Agent can be granted it. From a Space key K (32 bytes):

```
log id     hex(HMAC-SHA256(K, "reflex-relay/v0 log id"))
log token  base64url(HMAC-SHA256(K, "reflex-relay/v0 log token"))
entry key  HMAC-SHA256(K, "reflex-relay/v0 entry key")
asset key  HMAC-SHA256(K, "reflex-relay/v0 asset key"); an asset's ID = hex(HMAC(asset key, its SHA-256 hex))
sealed     nonce(12) ‖ AES-256-GCM(plain) ‖ tag(16), aad "reflex-relay/v0 <entry|asset> <log id>"
entry      [u32 BE header length][header JSON][change bytes]
```

Requests carry `req` (an integer the device chooses) and are answered `{t: "result", req, ok: true, ...}` or `{t: "result", req, ok: false, error}`:

| Request | Answer |
|---|---|
| `log.append {log, token, entries: [base64], snapshot?}` | `{seqs}`. The first writer's token sets the log's; later requests MUST carry the same. `snapshot`: one entry holding the whole Space, where replay can start. |
| `log.read {log, token, after, limit?}` | `{entries: [{seq, data}], last}` |
| `log.watch {log, token}` | `{last}`, then `{t: "log.new", log, last}` whenever it grows |
| `log.assets {log, token, ids}` | `{have}` |
| `grant.issue`, `grant.revoke`, `auth.lookup` | a cloud Agent's grant (ADR-0004) |
| `ping {at?}` | `{at}` |

A log the Relay doesn't have, or the wrong token, is refused. Assets go over HTTP: `PUT` and `GET /v0/log/<log id>/assets/<asset id>` with header `x-reflex-log-token`. The Relay never holds a Space key except under a live grant.

## 7. The viewer API

A host (a Link, `reflex dev`) serves a web viewer on loopback only, and checks the `Host` header against DNS rebinding. Every `/api` call carries the viewer key, which the host shows only to the person, in `x-reflex-key`.

- `GET /api/events?peer=<id>`: a stream of newline-delimited JSON, [`viewer.schema.json`](../schema/viewer.schema.json): `hello` first (the person, names, Spaces), then `sync` (a base64 kernel sync message per Space), `here`, `ping` every 15 s, and `reload`. A new stream is a new sync conversation.
- `POST /api/sync?peer=<id>&space=<space>`: the viewer's answer to a `sync`, as bytes. The host checks it with writers `{"people": []}` (no `agents` means none), so a viewer can read everything and change nothing: a change is answered 403 `read_only`.
- `GET /api/asset/<sha256>`: an asset's bytes.
- A missing or wrong key is 401 `bad_key`; the viewer stops and says so.

## 8. Where the schemas live

Every schema's `$id` is `https://reflex.eilmer.si/protocol/v1/<name>.schema.json`. A Relay serves them there: `GET /protocol/v1/` lists them (`{protocol: "reflex/v1", schemas}`), and `GET /protocol/v1/<name>.schema.json` returns each as `application/schema+json`, with `access-control-allow-origin: *`. They are also in the `@reflex/protocol` package, under `schema/`.
