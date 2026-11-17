# Pairing from anywhere: croc, Happy and Reflex

How two well-known tools let two devices find each other through a server they don't trust, and how Reflex does the same. Read on 2026-11-16: croc at [`a7180ce`](https://github.com/schollz/croc/tree/a7180cea9e2d24056fd9562d8962eefb5cc254d9) (v11.6.5), Happy at [`21e3ddc`](https://github.com/slopus/happy/tree/21e3ddc5a9ba3589c3bf13b9065a11ebfde2aa6d).

## Finding the other side, and room names

- **croc.** The code is three words from a 1,296-word list ([codephrase.go](https://github.com/schollz/croc/blob/a7180ce/src/codephrase/codephrase.go#L194-L222)). The room is the SHA-256 of the first word plus `croc`, so only about 10 bits of the code pick the room, and the rest stays secret. Two clients meet in that room on the relay ([tcp.go](https://github.com/schollz/croc/blob/a7180ce/src/tcp/tcp.go#L427)).
- **Happy.** No code. The computer shows a QR code holding `happy://terminal?<public key>`. The phone scans it and posts the account's content key, sealed to that public key, to `/v1/auth/response`. The computer polls `/v1/auth/request` until it arrives ([auth.ts](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-cli/src/ui/auth.ts#L145-L230), [authRoutes.ts](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-server/sources/app/api/routes/authRoutes.ts#L41-L166)). After that, socket.io rooms are named per user, session and machine ([eventRouter.ts](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-server/sources/app/events/eventRouter.ts#L248-L258)).
- **Reflex.**
  - Nearby, the iPad finds the Mac by Bonjour, unchanged.
  - Far away, the iPad and the Mac meet in one fixed **pairing room** on the relay: `sha256("reflex-relay/v0 pairing room")[:32]` (`relay/domain/wire.ts`). The room's name is derived from no part of the code, so the relay learns nothing about the code from where anyone waits.
  - A Link waits there only while a code is live, under a relay identity made for that wait.
  - The iPad tries the code on each Link waiting there, up to 8 Links per typing.
  - After pairing, both sides use the person's own room, `roomFor(person.id)`, as before.
  - A Link on the person's own relay also waits on the default relay, only to answer `moved` with its relay's address. So the iPad needs nothing typed but the code.

## Checking the code

- **croc.** It runs SPAKE2 over the other two words, about 21 bits, so each wrong guess has a 1-in-1.7-million chance ([pakekey.go](https://github.com/schollz/croc/blob/a7180ce/src/pakekey/pakekey.go#L77-L121)). A wrong code fails the key confirmation, and the transfer stops.
- **Happy.** There is no code to guess. Trust comes from the camera: whoever scans the QR code gets the public key. The server only passes the sealed box along ([encryption.md](https://github.com/slopus/happy/blob/21e3ddc/docs/encryption.md)).
- **Reflex.** CPace over X25519 checks the code (`link/pairing/cpace.ts`, `apps/ipad/.../Cpace.swift`):
  - The generator is hashed from the code and the hello transcript, which holds both device keys and nonces.
  - Each side sends one share, and both derive a secret. The secret feeds the auth MACs, which double as key confirmation.
  - The iPad sends its MAC first. The Link checks it before answering, and a wrong one counts as one of the code's 5 tries.
  - Someone without the code gets one online guess per try (1 in a million), and the shares tell them nothing about the code.
  - Nearby keeps the commit-reveal rounds it had.

## Device keys

- **croc.** It has no lasting device keys. Each transfer is fresh.
- **Happy.** Each account has a 32-byte secret, and an Ed25519 key derived from it signs in by answering a challenge it picks itself. The server then issues a bearer token ([AccountKeys.swift](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-ios/Sources/HappyCrypto/AccountKeys.swift#L21-L30), [authRoutes.ts](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-server/sources/app/api/routes/authRoutes.ts#L9-L39)).
- **Reflex.** Each device has its own Ed25519 key, and its device ID comes from that key.
  - Pairing binds the two device keys through the CPace transcript, and each side signs the transcript. The Link then sends a sealed `who` (person and name), and so does the iPad.
  - Later sessions accept only the paired key.
  - In the pairing room, both sides use throwaway relay identities, so the relay never sees the iPad's device ID there. Names are blanked on any relay path.

## How the relay checks who connects

- **croc.** It uses a relay password, `pass123` by default, run through a PAKE with that fixed weak key ([cli.go](https://github.com/schollz/croc/blob/a7180ce/src/cli/cli.go#L160-L169), [tcp.go](https://github.com/schollz/croc/blob/a7180ce/src/tcp/tcp.go#L478-L513)). It keeps random scanners out, not people who know the default. The relay doesn't know who is who; the PAKE between clients does that.
- **Happy.** A bearer token from the challenge sign-in, checked on every socket.io connection ([socket.ts](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-server/sources/app/api/socket.ts#L57-L88)).
- **Reflex.**
  - Every socket must sign the room's fresh challenge with the key its device ID comes from, within 10 seconds, or it is closed. Nobody can claim someone else's device ID; the attack in the PR closes it with 4403.
  - The relay doesn't decide who belongs together. The devices do, end to end, by accepting only the paired key.
  - A stranger who joins a person's room with its own key hears no presence. Presence is told only between two devices that watch each other. It can't reach anyone, because frames go only to a device that watches the sender.

## Abuse protection on a public relay

- **croc.** It allows 2 clients per room ("room full" for a third), 128 waiting rooms and a 3-hour room TTL. It also allows 30 joins a minute per IP and per room, and 64 incomplete handshakes in total with 32 per IP. Messages are capped at 64 KiB ([defaults.go](https://github.com/schollz/croc/blob/a7180ce/src/tcp/defaults.go), [admission.go](https://github.com/schollz/croc/blob/a7180ce/src/tcp/admission.go)).
- **Happy.** No general rate limiter. Abuse is held back by the account requirement.
- **Reflex** (`relay/domain/room.ts`, `relay/node/server.ts`):
  - **Hello deadline:** a socket must say hello within 10 seconds.
  - **Room caps:** 64 sockets per room, 16 from one address. The pairing room holds 1024, with 8 from one address.
  - **Pairing tries:** in the pairing room, each socket may open 6 new channels a minute, and each address 12. Every channel there is one try at someone's code, and the Link also allows only 5 wrong tries per code.
  - **Control messages:** 120 a minute, each at most 64 KiB.
  - **Node connections:** 60 a minute and 64 open from one address. Proxy headers are trusted only from loopback.
  - Empty rooms are dropped.
  - These limits are in this change's source. The deployed reflex.eilmer.si gets them only when it is redeployed (see the PR).

## Self-hosting

- **croc.** `croc relay` listens on ports 9009-9013. The sender and receiver set `--relay`/`CROC_RELAY`, and `--pass`/`CROC_PASS`. A Docker image is published ([README](https://github.com/schollz/croc/blob/a7180ce/README.md)).
- **Happy.** Docker plus `HANDY_MASTER_SECRET`, with `HAPPY_SERVER_URL` set on the computer. The phone must have the server URL typed in by hand ([self-host README](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-server-self-host/README.md), [configuration.ts](https://github.com/slopus/happy/blob/21e3ddc/packages/happy-cli/src/configuration.ts#L55-L64), [guide](https://happy.engineering/docs/guides/self-hosting)).
- **Reflex.**
  - `npx -y "github:JohanSardar/reflex#npx" relay --tunnel` runs a relay and a free Cloudflare quick tunnel, and prints its `wss://` address. Or run it without `--tunnel`, behind any HTTPS proxy on your own domain.
  - On the Mac, set `REFLEX_RELAY=wss://…`.
  - Nothing is typed on the iPad. It is pointed there by the Link's `moved` answer on the default relay, and it remembers the relay once paired.
