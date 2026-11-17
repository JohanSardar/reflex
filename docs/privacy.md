# Privacy and security

[Back to the quick start](../README.md#connect)

## What you send

Drawing and Pencil movement stay local. Pressing **Send** exports new strokes, their board context, handwriting hints, spoken words and PNG board images. Images include the visible board and a margin around it, so check the surrounding content before sending. Holding the microphone records speech for on-device recognition; releasing it sends the words. The agent answers in its own session and cannot edit the iPad canvas.

The board is stored in the iPad app’s local data. Pending Sends are saved there and retried after reconnection. On your Mac, the Link stores received Sends and images before acknowledging them, so delivery can survive a restart. Agent acknowledgement is separate from the iPad’s delivery acknowledgement.

## Who can read it

- **Your paired devices:** the iPad and Mac hold device keys and can read their encrypted connection. Device identities are authenticated on reconnect.
- **Approved agents:** typing the code from an agent approves that agent. Additional receivers require approval. Treat that approval as access to Sends, not just a network connection.
- **Your agent provider:** once delivered to Claude Code, Codex or another receiver, content is subject to that harness and provider’s data policies. Device encryption does not prevent the recipient from reading it.
- **The relay:** forwards encrypted bytes. It sees IP addresses, connection timing, volume and public device keys, but not the board, spoken words, device names in plaintext or pairing code. Encryption does not hide traffic metadata.

## Pairing

A six-digit code works once, for ten minutes, with a limit of five failed attempts. The iPad tries local discovery first, then the relay if needed. Relay pairing uses CPace to prove knowledge of the code without transmitting it. After pairing, the devices exchange and retain their public keys for later authenticated connections. Share a code only with the iPad you intend to connect.

The default relay is `wss://reflex.eilmer.si`. [Use your own or disable it](relay.md#run-your-own-relay) with `REFLEX_RELAY=off` if you need local-only operation. Nearby peer-to-peer Wi-Fi depends on the bundled Mac helper and the devices’ connectivity; the same Wi-Fi is the simplest starting point.

## Local storage and revocation

The Mac profile defaults to `~/.reflex/link/`. It contains private device credentials, the SQLite Inbox, images and diagnostic logs. Device transport encryption does **not** mean these local files are encrypted at rest by Reflex. Protect the Mac account, backups and disk. Never upload that folder to an issue.

List approved receivers from your Mac:

```sh
npx -y "github:JohanSardar/reflex#npx" link agents
```

To revoke one, use `link revoke` followed by its ID from that list. Revocation stops future access; it cannot recall content already delivered to a receiver or its provider.

Reflex is beta software and has not had an independent security audit. This guide describes the implemented trust model, not a guarantee against every attack. For technical details, see [architecture](ARCHITECTURE.md), [pairing code](../link/pairing/) and [iPad networking](../apps/ipad/Packages/ReflexLink/). Report vulnerabilities through [SECURITY.md](../SECURITY.md).
