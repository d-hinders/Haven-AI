# @haven_ai/connect

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

## 0.3.0-alpha.0 — 2026-09-17

### Fixed

- **`AgentIdentity` declared the wrong wire shape (#2914).** `safe_address` was
  required and `account_address` optional — exactly backwards from what the
  server emits after the naming contraction. It is a hand-written wire shape,
  so nothing validated it against the spec and typecheck stayed green while
  the type was simply wrong. `rekey.ts` had the same bug on a live identity
  read, with no test reaching the fallback; both are fixed and the fallback
  now has one.

### Unchanged, and deliberately

- Connect's own `identity.json` / `agent.json` `safe_address` fallback is
  **permanent**, the same class as a credential file.

## 0.2.1-alpha.0 — 2026-09-16

### Fixed

- `--doctor` reports an outdated-but-intact signer runtime as version drift rather than
  "stale or empty", which sent operators to reinstall a working runtime (#2974).
- Superseded doctor probes are authenticated (#2964).

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
