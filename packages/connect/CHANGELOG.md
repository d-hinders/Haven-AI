# @haven_ai/connect

Release headers are written **by hand at release time**. `release-bump.mjs`
does not touch this file — it owns versions, cross-package pins, source version
constants and the Supported Runtime Manifest table, and nothing else. This line
used to claim the opposite, and all five package changelogs consequently still
read `## Unreleased` at the 0.1.37-alpha.0 release commit.

## 0.2.0-alpha.0 — 2026-09-14

### Naming epic #2906, phase 1 (#2908) — writes the new name only

- `identity.json`, `signer.json` and `agent.json` are written with
  `account_address` and **no** `safe_address`. Every runtime this connector
  installs reads the old key permanently, so credential sets from either era
  load.
- `WriteCredentialInput.safeAddress` → `accountAddress` (programmatic API).
- Stored-credential read (re-key): `account_address` (identity, agent) then
  `safe_address` (identity, agent); the old fallback is permanent.
  `StoredCredentialSnapshot.accountAddressKey` says which was found.
- Re-key rewrite chain: `stored.accountAddress ?? identity.account_address ?? identity.safe_address`.
- `--doctor`'s `credentials` check now reports which name the credential set
  carries: `stored as account_address`, or `stored under the pre-#2908 name
  safe_address — still read; the next --rekey or setup rewrites it as
  account_address`.
- `AgentIdentity.account_address` added; `safe_address` deprecated (server
  drops it at #2914).
