# Repositories

The only place in `packages/backend/src` that may reach the database.

Enforced, not aspirational: `pg-only-in-infra` in `.dependency-cruiser.cjs`
fails the build when anything outside `db/`, `db.ts` and this directory imports
`db.ts` or `pg`. Existing debt is ratcheted in `dep-lint-baseline.json` and may
only shrink. Rule 3 of
[`docs/architecture/10-module-boundaries.md`](../../../../../docs/architecture/10-module-boundaries.md)
is the prose; the cruiser config is authoritative.

## Why this exists

**Testability, not tidiness.** `scripts/db-schema-smoke.ts` applies every
migration to a throwaway database and `PREPARE`s a curated list of queries —
Postgres then resolves every column and table without needing any rows. It can
only do that for a query it can **import**. A query inlined in a route handler
is one CI never checks against the real schema, which is how a join on a
non-existent column reached dev and 500ed every session payment (#757).

The secondary win is authorization. Much of Haven's tenant isolation lives in a
`WHERE user_id = $1` clause. Behind a repository the scoping value is a required
function parameter, so "did we scope this query?" becomes a thing the type
checker and the function signature can answer.

## The convention

Written from what the code already does — `agent-passports.ts` (#972)
established it, `hybrid-signers.ts` (#1081) followed it, `agent-connection-
setups.ts` (#985) generalised it.

1. **Plain exported async functions.** No classes, no DI container. This matches
   the rest of the codebase.

2. **The executor comes last and defaults to the pool.**

   ```ts
   export async function findSetupForUser(
     setupId: string,
     userId: string,
     db: Executor = pool,
   ): Promise<SetupRow | null>
   ```

   `Executor` (`../transaction.ts`) is structural — the `db.ts` wrapper, a raw
   `pg.Pool`, or a `PoolClient` inside a transaction all satisfy it. The default
   matters: only this directory may import `db.ts`, so a caller passing the pool
   in would have to import the very thing the rule forbids.

3. **Tenant scoping is a required parameter — never defaulted, never optional.**
   A repository function callable without its scope is a privilege-escalation
   bug waiting for its first careless caller. If a query needs `user_id`, the
   function takes `userId: string` in a position the caller cannot skip.

4. **SQL lives in exported constants**, so `db-schema-smoke.ts` can import it.
   Add the new constants to that script in the same change — **by import, never
   by paste**. A pasted copy only proves the copy still matches the schema, and
   drifts the first time someone edits the real one, reproducing inside the
   check the exact failure the check exists to catch.

5. **Returns are domain-shaped**, not raw driver rows: `null` rather than an
   empty `rows` array, a `boolean` rather than `rowCount`, the row type this
   module owns rather than `QueryResult`.

6. **Guards travel with the write they protect.** When a check reads a locked
   row and a write depends on it, both belong in one function. Exposing them
   separately lets a caller run the check against a row nobody is holding —
   which is how a double-approval or a double-spend gets in.

## Transactions

`withTransaction(db, fn)` from `../transaction.ts` — BEGIN, run, COMMIT, and
ROLLBACK on a throw, on a single dedicated connection. An executor that is
already a transaction client runs `fn` inline instead of nesting a BEGIN.

**A throw is the only way to roll back.** A callback that returns normally has
declared the work complete. Route handlers that need to refuse a request
mid-transaction throw a sentinel of their own and map it to a reply outside —
see `SetupRefusal` in `routes/agent-connection-setups.ts`. Early-returning
instead would COMMIT, which is harmless while the transaction is empty and
silently wrong the day a write is added above the guard.

Routes must not import the pool to get a transaction. Each repository that needs
one exposes a pool-bound entry point (`inTransaction`) so `transaction.ts` can
stay free of any database import.

## Adding a repository

1. One file per aggregate, named for it.
2. Header comment: what it owns, and any invariant a reader must not break.
3. Move the SQL **verbatim**. An extraction is behaviour-preserving; anything
   that looks improvable gets reported in the pull request, not fixed in the
   same diff. Characterization tests land **before** the move.
4. Register the new SQL constants in `scripts/db-schema-smoke.ts`.
5. Shrink the `dep-lint-baseline.json` entry for whatever file you emptied. The
   baseline is shrink-only — never regenerate it to silence a failure.

## Status

Epic #980 M3's three tracks have landed: `#985` (the convention +
agent-connection-setups), `#988` (agents, user-safes) and `#995` (payments,
x402, machine-payments — `payment-intents.ts`, `approval-requests.ts`,
`x402-authorizations.ts`, `machine-payments.ts`, `account-entitlements.ts`).
The money path's data access now lives here and is PREPARE-checked by
`db-schema-smoke`; remaining inline SQL elsewhere is ratcheted in
`dep-lint-baseline.json` and may only shrink.
