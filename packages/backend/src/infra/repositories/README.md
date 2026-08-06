# Repository convention (`src/infra/repositories/**`)

Written from what the code **does** (proven by `agent-passports.ts`, #973/#974,
and promoted as the shared convention by #985) — not an aspiration.

## The rules

1. **Explicit executor argument.** Every function takes `db: Executor = pool`
   (`Executor` from `../db.ts`). The default is the app pool; a caller inside a
   transaction passes its client and the function composes. Never import the
   pool implicitly deep inside a helper.

2. **`withTransaction` from `../db.ts`** is the one transaction primitive:
   BEGIN/COMMIT on a single dedicated client when given the pool wrapper,
   inline pass-through when given an existing transaction client. Do not
   re-implement it per file.

3. **Exported SQL constants** for every query worth checking —
   `scripts/db-schema-smoke.ts` imports them and `PREPARE`s against a real
   schema in CI. A query it cannot import is a query CI cannot check (#757:
   a join on a non-existent column 500ed every session payment). When you add
   a repository function, add its SQL to the smoke list **by import, never by
   paste** — a pasted copy drifts the first time someone edits the real one.

4. **Domain-shaped returns.** Functions return typed rows/domain shapes, not
   `QueryResult`. Callers never touch `rows[0]` themselves.

5. **No SQL outside this folder.** The `pg-only-in-infra` dep-lint rule
   enforces the boundary (baseline is shrink-only). Routes and `lib/` keep
   validation, authorization, and orchestration; **only data access lives
   here**.

6. **Tenant scoping stays required and explicit.** When a query's `WHERE`
   carries authorization (`user_id = $1`), the repository signature takes that
   scope as a **required, non-optional** parameter. A scope with a default is
   a privilege-escalation bug waiting for its first careless caller. When two
   callers deliberately filter differently (e.g. a list excluding
   `pending_approval` while the single-read does not — the #1069 lesson),
   keep both functions and **name the difference**; never collapse them into
   one "find" with flags.

## Existing repositories

- `agent-passports.ts` — the original; passport rows, revocation queue.
- `delegation-budgets.ts` — active-delegation read side (#1090).
- `hybrid-signers.ts` — signer-set reads.
- `relayer-gas-events.ts` — gas budget counts + spend attribution (#717).
- `agent-connection-setups.ts` — connect-flow setups (#985).
