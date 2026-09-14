# @haven_ai/mcp

Release headers are written **by hand at release time**. `release-bump.mjs`
does not touch this file — it owns versions, cross-package pins, source version
constants and the Supported Runtime Manifest table, and nothing else. This line
used to claim the opposite, and all five package changelogs consequently still
read `## Unreleased` at the 0.1.37-alpha.0 release commit.

## 0.2.0-alpha.0 — 2026-09-14

### Naming epic #2906, phase 1 (#2908) — reads both names, prefers the new

| Reader | Chain (earlier wins) | Window |
|---|---|---|
| credential file, single and split (`loadCredentials`) | `account_address ?? safe_address ?? safeAddress` (per file; split files must agree, mismatch is labelled `account_address`) | the two old keys are read **permanently** |
| environment | `HAVEN_ACCOUNT_ADDRESS ?? HAVEN_WALLET_ADDRESS ?? HAVEN_SAFE_ADDRESS` | `HAVEN_WALLET_ADDRESS` / `HAVEN_SAFE_ADDRESS` removed at #2914 |

`HavenCredentialFile` gains an explicit `accountAddress` key (this shape is
separate from the signer's); `safeAddress` is kept with the same value and
`@deprecated` — **removed in the release after the one carrying #2908
(#2914)**. Exported: `readAccountAddressField()`, `readAccountAddressEnv()`.
The consent seed prefers the SDK's `accountAddress` and falls back to
`safeAddress`; the consent hash input value is unchanged either way.
