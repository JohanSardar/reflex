# iPad release procedure

This procedure replaces the dependency on a script in a maintainer's home
folder. Any authorized maintainer with a provisioned Mac can perform it.
PR CI is unsigned and requires no credentials. There is no automatic upload
on push or PR, and `scripts/archive.sh` only archives and exports locally.

## Identities and prerequisites

- App Store Connect app: **6833792396**, bundle ID **si.eilmer.reflex**.
- Xcode 26.4.1 and XcodeGen, as in [README.md](README.md).
- Access to the existing Apple Developer team and App Store Connect app.
  Contributors can build the Simulator app for free; distribution uses the
  project's existing Apple membership. No new service or subscription is needed.
- An Apple Distribution certificate **with its private key**, installed by the
  authorized maintainer, and an App Store distribution provisioning profile for
  this bundle ID/team. A `.p8` API key alone does not sign an archive. Obtain
  these through the team's Apple Developer account on a replacement Mac; do
  not depend on a particular person's keychain. The script neither installs
  credentials nor prompts for passwords. If signing cannot run unattended,
  provision the release machine before running it.
- An App Store Connect API key authorized to upload this app, with its key ID
  and issuer ID. Keep `AuthKey_<KEY_ID>.p8` outside the checkout, in
  `~/.appstoreconnect/private_keys/`, the location used by Apple's upload tool.
  Obtain it through the team's secure credential transfer, never through Git,
  issues, PRs or logs. Never print key contents or enable shell tracing.

An API private key can be downloaded only once; retain it securely or create
and revoke keys through App Store Connect when changing maintainers. Store
certificate backups and profiles outside the repository as well. No secrets
are required for GitHub PRs, and no TestFlight key is sent to a fork workflow.

## Version and build number

`project.yml` is the source of truth: `MARKETING_VERSION` is the public app
version, currently **1.0**; `CURRENT_PROJECT_VERSION` is the local default
build number. The generated plist references these settings instead of
hardcoding a second version. Keep the effective version at 1.0 for the current
beta unless intentionally preparing a new public version. Never infer the
next upload number from the local default of 1.

In App Store Connect → Reflex → TestFlight, check the latest uploaded build
(including builds still processing) and choose a **strictly greater, unused
positive integer**. Coordinate with other maintainers before allocating it.
Set `BUILD_NUMBER` explicitly; the script passes it to `xcodebuild` without
modifying the checkout. Recheck before upload if another maintainer shipped
while the archive was building. A retry after an accepted upload needs a new
number. Record version, number, source SHA and IPA SHA-256 with the build.

## Build and export

1. Use a fresh clone at the exact reviewed `origin/main` commit. Follow the
   README and run its checks. Verify the PR's iPad check passed. Run the manual
   smoke check below. No root/server/CLI rebuild is needed to archive the app.
2. If changing the public version, edit `project.yml`, regenerate, and review
   and commit the generated plist/project before archiving.
3. With signing prerequisites already installed, run from the repo root:

   ```sh
   export DEVELOPMENT_TEAM='<existing Apple team ID>'
   export CODE_SIGN_IDENTITY='Apple Distribution: <team certificate name>'
   export PROVISIONING_PROFILE_SPECIFIER='<installed App Store profile name>'
   export BUILD_NUMBER='<unused number from App Store Connect>'
   apps/ipad/scripts/archive.sh
   ```

   The placeholders are identifiers, not private-key contents. Output is
   `apps/ipad/build/release-<number>/`: an archive (including dSYMs), export
   options and `export/Reflex.ipa`. `OUTPUT_DIR` can select another **absolute**
   path outside the repo. The output directory must be new so stale binaries
   cannot be uploaded accidentally. Retain the archive securely for crash
   symbolication. Do not commit build products or signing files.
4. Inspect the archive's `Products/Applications/Reflex.app/Info.plist` using
   `plutil -p`: bundle ID, version and build number must be the intended values.
   Verify the hand-drawn arrow app icon. Record the printed Git SHA and IPA
   SHA-256. Inspect Xcode's signing/export errors instead of disabling checks.

## Upload and make available to testers

These are separate release actions; run only when authorized to upload.
This ticket does not authorize them.

```sh
xcrun altool --validate-app --type ios \
  --file apps/ipad/build/release-<number>/export/Reflex.ipa \
  --apiKey '<KEY_ID>' --apiIssuer '<ISSUER_ID>'
xcrun altool --upload-app --type ios \
  --file apps/ipad/build/release-<number>/export/Reflex.ipa \
  --apiKey '<KEY_ID>' --apiIssuer '<ISSUER_ID>'
```

Apple reads the `.p8` from the external directory above. Do not paste it into
these commands. Wait for App Store Connect processing, resolve export
compliance and processing errors, then open **TestFlight → iPadOS → build**:

1. Fill in “What to Test” and required beta review information.
2. Add the build to the **Public** external-testing group. Uploading alone
   does not add a build to that group.
3. Submit the build for **Beta App Review**, when authorized. Confirm Apple's
   approval and that external testing is enabled for Public before claiming
   testers can install it.
4. Check [the public join link](https://testflight.apple.com/join/R81n88Re).
   The build submitted on 2026-11-16 was awaiting beta approval when this
   procedure was written. Availability is Apple's state, not a repo setting.

An App Store public release is a separate decision. This procedure does not
create tags, GitHub Releases, npm packages, container images, deployments, or
an App Store submission. If rejected, address Apple's reason and use a new
build number when a replacement binary is needed. Never overwrite an upload.

## Manual smoke check before shipping

Use a dedicated iPad Simulator and a physical iPad for Pencil/speech checks.
Compare the reviewed app and `main` on the same steps:

- Create a board, write text, draw ink, undo/redo, leave and reopen it; check
  content survives app restart. Keep existing boards for an upgrade check.
- Ask a fresh agent to connect, type its code, allow Local Network permission,
  and confirm pairing. Press Send; receive the same board/ink at the agent
  through `wait_for_user`. Check reconnect delivers a pending Send once.
- With fresh pairing attempts, check correct nearby code accepted, wrong code
  refused, consumed code refused, and five wrong tries close the attempt.
  Do not use an existing pairing as evidence that a fresh code works.
- Check nearby Wi-Fi and relay fallback without changing the one-paste setup.
- Confirm the arrow logo, screens and visible behavior match the baseline.

Keep screenshots/output with the PR and explicitly list any untested step.
A passing compiler or stroke test does not establish pairing or UI parity.
