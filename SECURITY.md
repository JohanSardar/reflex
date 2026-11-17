# Security policy

## Report a vulnerability privately

Use [GitHub’s private vulnerability report form](https://github.com/JohanSardar/reflex/security/advisories/new). You need a GitHub account. Do not file exploitable details in a public issue or PR.

Include the affected commit/build and platform, how to reproduce the issue, expected and actual behavior, and its likely impact. Use synthetic board content. Never include real credentials, device private keys, live pairing codes or somebody else’s data.

If the private form is unavailable, open an issue saying only that you need a private reporting channel; omit the vulnerability details. No response-time guarantee or paid bounty is offered.

## Supported versions

Reflex is in beta. Security fixes target the current `main` branch, its `npx` build and the current iPad beta. There are no maintained older release lines. Use the latest available builds on both devices.

## Scope and trust boundaries

Pairing-code handling, device authentication, receiver approval, local credentials, encrypted transport and durable Send delivery are security-sensitive. See [privacy and security](docs/privacy.md) for what leaves the iPad, relay metadata and local storage limits.

Device encryption ends at the Mac. Approved receivers and their AI providers can read delivered content. Reflex has not undergone an independent security audit.
