# @haven_ai/connect

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

- Setup names every other credential directory that still holds a stored key — with the account it can spend from — BEFORE the key is minted or anything is written, and still succeeds (#3122, owner decision: warn, not refuse); `--json` gains `existing_agents_before_write`. Each setup records what it bound in a non-secret `mcp-server-binding.json` (server name → agent id, backend URL, bound-at); a name taken over from another directory's record is named before the write, with a DIFFERENT-backend flag, as `server_name_rebound_from`; `--unwire` and a `--replace` retirement release the record (`--json`: `binding_released`); `--doctor` reports two records claiming one name as the `mcp_server_name_rebound` advisory. No network call added.

- `--unwire` refuses to destroy a directory's key material unless the identity probe says there is nothing to preserve (#3123, owner option c): `ok` (active), `unauthorized` (a stranded balance may exist and the connector cannot check) and `network_error`/`bad_response` all retain the signer key, parked re-key and stored API key (the config and Hermes-env copies are scrubbed first; a config the run could not clean is reported, not silent) and exit 1 with the wiring removed; `--destroy-key-material` proceeds and states that local sweep recovery ends. `--json` gains an additive `teardown` object. New `--prune-signer-runtimes [--dry-run]` reclaims `~/.haven/signer-runtime` directories no credential directory references (override-keyed ones included); `--doctor` surfaces them as the `signer_runtime_unused` advisory.

- `--doctor` verdicts have three levels (#3121): every check and the report carry `level: ok | advisory | failed`; only `failed` reaches the exit code (advisories print `!` and exit 0); `ok` is now `level !== 'failed'` (was "every check passed"). Intact-but-outdated `signer_runtime` and `superseded_agents` on a runtime with no connector-owned config (claude-code, other) are advisories. Report stays `version: 1`; `level` is additive.

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
