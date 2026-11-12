# Releasing Reflex Protocol v1

The checklist for publishing a protocol version. **Nothing here has been run.** Every step that makes something public needs the person who owns the project to decide to do it.

## 0. Decide first

- [ ] **A license.** The repo has none. Add `LICENSE` at the root and `"license"` to `protocol/package.json` (and to `kernel/wasm/package.json` if the kernel is published).
- [ ] **The npm scope.** Check `@reflex` is yours on npm (`npm org ls reflex`, or `npm access list packages @reflex`), or choose another scope and rename the packages.
- [ ] **Whether the kernel ships with it.** spec/README.md says clients interoperate by embedding the kernel published with each protocol release. `@reflex/kernel` exports TypeScript files (`js/node.ts`), which Node won't strip inside `node_modules`, so it needs compiling to JavaScript before it can be published. Until then, say in the release notes that third-party clients build the kernel from `kernel/`.

## 1. Check

On the commit to release, with `kernel/wasm` built (`npm run build:kernel-wasm`):

```sh
npm ci
npm run check -w @reflex/protocol        # schemas, examples, generated/ current
npm run typecheck
node tests/conformance/run.ts --reflex   # every profile against Reflex's own implementations
(cd protocol && npm pack --dry-run)      # the files that would ship: schema/, examples/, generated/, spec/, tool-text/
```

## 2. Publish the package (npm)

`protocol/package.json` keeps `"private": true` so nothing can be published by accident. To publish:

```sh
# remove "private": true from protocol/package.json, commit it
cd protocol && npm publish --access public
```

What goes up: `@reflex/protocol@1.0.0`, with the schemas, examples, generated Rust and TypeScript, the spec and the tool text.

## 3. Tag (git)

```sh
git tag -a protocol-v1.0.0 -m "Reflex Protocol v1.0.0" <merge commit on main>
git push origin protocol-v1.0.0
```

## 4. GitHub release

```sh
(cd protocol && npm pack)                # reflex-protocol-1.0.0.tgz
gh release create protocol-v1.0.0 protocol/reflex-protocol-1.0.0.tgz \
  --title "Reflex Protocol v1.0.0" --notes-file protocol/CHANGELOG.md
```

## 5. Make the `$id`s resolve (deploy the Relay)

Every schema's `$id` is `https://reflex.eilmer.si/protocol/v1/<name>.schema.json`. The Relay serves them (relay/domain/http.ts) from the copy it was built with, so the Relay must be deployed from the released commit:

```sh
cd relay/cloudflare && npx wrangler deploy
curl -sI https://reflex.eilmer.si/protocol/v1/element.schema.json    # 200, application/schema+json
curl -s  https://reflex.eilmer.si/protocol/v1/ | head -c 200          # the list of schemas
node tests/conformance/run.ts relay --url https://reflex.eilmer.si   # the deployed Relay passes its profile
```

This touches only the Worker on `reflex.eilmer.si`. Never change the `relay.eilmer.si` DNS record.

## 6. Make the repo public

Only if the person decides to: the spec and conformance suite point at files in the repo (`tests/conformance/`, `agent/examples/`).

```sh
gh repo edit JohanSardar/reflex --visibility public --accept-visibility-change-consequences
```

## After

- [ ] `npm view @reflex/protocol@1.0.0` shows it.
- [ ] Bump `protocol/package.json` to the next pre-release (`1.1.0-dev`) when the first change after the release lands, and start a new CHANGELOG section.
