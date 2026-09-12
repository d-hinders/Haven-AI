# @haven_ai/cli

Release headers are written by the release bump (`npm run release:bump`), never by hand.

## Unreleased

### Naming epic #2906, phase 1 (#2908) — new paths, dual-emit on stdout

- Calls the account-vocabulary paths: `GET /user/accounts`,
  `GET /user/accounts/:id/funding`, `PUT /user/accounts/:id`
  (`/balances/{address}` is a single dynamic segment and needs no twin).
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
