# @haven_ai/cli

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

### Fixed

- **BREAKING for older backends, and a fix against current ones (#2914).**
  `GET /user/accounts` returns an `accounts` envelope; this package still read
  `safes`, which broke `wallets list`, `wallets balances`, `wallets funding`,
  `activity list --safe`, `activity export --safe` and `agents connect` with a
  `TypeError`. The envelope is now read through one function that fails with a
  sentence naming the cause instead of a stack trace.

### Removed

- The dual-name emission promised by 0.2.0-alpha.0 is gone, one release later
  as stated there: `--json` and the CSV header carry `account_id` /
  `account_address` only (the `safe_address` CSV column is dropped, shifting
  column indexes for an importer keyed on position), `/transactions` is
  queried with `?accountId=` only, and the connection-setup body sends
  `account_id` only.

### Compatibility note

- The server accepts `safeId` / `safe_id` **beside** the new name when both
  agree, so the dual-sending 0.2.x CLI keeps working against a contracted
  backend; sending only the retired name is refused with a typed 400. That
  removes the release-ordering constraint this change would otherwise have
  imposed.

## 0.2.1-alpha.0 — 2026-09-16

- **No source change in this release.** `@haven_ai/cli` is republished so its version and
  its internal `@haven_ai/*` pins stay in lockstep with the other four packages; the CLI
  behaves identically to 0.2.0-alpha.0.

## 0.2.0-alpha.0 — 2026-09-14

### Naming epic #2906, phase 1 (#2908) — new paths, dual-emit on stdout

- Calls the account-vocabulary paths: `GET /user/accounts`,
  `GET /user/accounts/:id/funding`, `PUT /user/accounts/:id`
  (`/balances/{address}` is a single dynamic segment and needs no twin).
  **Release-ordering constraint:** the CLI does NOT fall back to `/user/safes*`
  on a 404 — a backend carrying #2907 (PR #2930, the `/user/accounts*` twin)
  must be LIVE on the environment the CLI targets before the release carrying
  this CLI is promoted to `latest`; otherwise `wallets list|balances|funding|
  rename`, `activity --safe`, `agents connect` and wallet resolution in
  `send`/`pay` 404 at once. (The query key and the request body are dual-sent
  and have no such constraint.)
- `activity list` / `activity export` send `?accountId=` AND `?safeId=` (same
  value; `accountId` wins on the server; the old key keeps a pre-#2907 server
  filtering, because an unknown query key is silently ignored).
- `agents connect` sends `account_id` AND `safe_id` (same value) in the
  setup request body.
- Reads the account address from either `account_address` or `safe_address`
  on every server response it consumes (new first).
- `--json` dual-emit for the window (no negotiation exists for stdout):
  `wallets rename` → `account_id` + `safe_id`; `wallets balances` →
  `account` + `safe` (wallet name). **`safe_id` / `safe` removed at #2914.**
- CSV export: `account_address` column **appended** after `chain_id` (same
  value as `safe_address`; append-only, never reorder). **`safe_address`
  column removed at #2914.**
- The `--safe <id|address>` flag is unchanged in this release.
