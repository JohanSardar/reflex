# Reflex web viewer

The browser client (SPEC §3, ARCHITECTURE §2 `web`): it opens a Space and draws it live, and it is the
`reflex dev` playground. It runs the same kernel as everything else (`kernel/wasm`, built with
`--target web`) and holds a full replica of each Space, kept in step with its host by the kernel's own
sync protocol.

```sh
sh kernel/wasm/build.sh && npm install
reflex link            # prints "web viewer: http://127.0.0.1:7421/#k=…" in its terminal; open that
reflex dev ./my-embed  # the playground on an in-memory Space (see agent/README "Author kit")
```

| Path | What it is |
|---|---|
| `index.html`, `src/viewer.ts` | the viewer: a list of Spaces, and the chosen one drawn live |
| `dev.html`, `src/dev.ts` | the `reflex dev` playground: draw with the mouse, Send, and three panes |
| `src/conn.ts` | the link to the host: one streamed fetch of events (newline-delimited JSON) and a POST per sync reply |
| `src/live.ts` | one Space drawn live: redraws whenever its replica or the Library's changes |
| `src/render.ts` | DOM renderers for the native Element types, with a pan and zoom camera |
| `src/embed.ts` | HTML Embeds in sandboxed iframes, the `reflex` bridge, and Anchor requests |

There is no build step. The host serves `src/*.ts` with Node's type stripping, so the sources use only
erasable TypeScript (`npx tsc -p apps/web`).

## Safety

- The host (`agent/src/web/server.ts`) listens on 127.0.0.1 only and checks the Host header.
- Every `/api` call carries the viewer key. The Link makes a fresh one at every start, keeps it in
  memory, and prints it only in its own terminal, like a pairing code. The page moves the key from
  the address bar into session storage.
- A viewer can read and can't write: the host passes what a browser sends through the kernel's
  `receive_sync_message_checked` with no writers, so any change is refused (and logged).
- Agent text is set as DOM text, never parsed as HTML. Images load only from the Link's assets
  (`asset:`), never from a URL an Agent chose.
- Each Embed runs in an iframe with `sandbox="allow-scripts"` (an opaque origin) and its own Content
  Security Policy: its `allow` list plus the approved CDNs, nothing else. It reaches Reflex only
  through the bridge (`reflex.element`, `notify`, `emit`, `panel`, `anchors`), over `postMessage`
  from frames this page made.

## Not here yet

- Typing, tapping and Sending from the viewer (SPEC §3). It shows Spaces; the iPad and Agents change them.
- Live cursors, Behaviors, Panels, and math typesetting (LaTeX shows as its source).
- An Embed's `setState` and events stay in the page; they don't sync yet.
- The viewer runs only on the Link's computer. Reaching it from another device needs the Relay (T9).
