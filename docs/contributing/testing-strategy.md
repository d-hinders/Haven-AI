---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/infra/__tests__/helpers/db-harness.ts
  - packages/backend/src/infra/__tests__/helpers/db-availability.ts
  - packages/backend/vitest.setup.ts
  - packages/backend/vitest.global-setup.ts
  - scripts/db-mock-ratchet.mjs
  - packages/backend/db-mock-baseline.json
last-verified: "2026-08-29" # #2209: harness section re-read against db-harness.ts; adds the resetDb()-in-a-loop convention with measured per-call cost (~250 ms quiet / ~800 ms-1.2 s loaded at 38 tables) — no harness behaviour changed, initDbHarness()/resetDb()/the beforeAll example are unchanged. Prior: #2198: harness section re-read against db-harness.ts — the cross-worker migration lock now WAITS by polling pg_try_advisory_lock (shared helper db/advisory-lock.ts) instead of blocking in pg_advisory_lock, because a blocking waiter pins a snapshot that deadlocks CREATE INDEX CONCURRENTLY; no doc-visible change, initDbHarness()/resetDb()/the beforeAll example are unchanged. Prior: #1763: the no-database section is rewritten — the local default inverts to failing, HAVEN_SKIP_DB_TESTS=1 acknowledges a narrowed run, and the verdict prints after vitest's summary; harness section re-read against db-harness.ts, the beforeAll example unchanged and still preferred. Prior: resetDb now awaits initDbHarness (the un-awaited-init 42P01/40P01 CI flake); harness section re-read against db-harness.ts, example unchanged and still the preferred shape
---

# Backend testing strategy: the real-database rule

The rule epic #1219 established, written down so it survives the people who
ran it. Without this page the convention lives in the heads of whoever
converted the repositories, and the next contributor reasonably copies the
nearest existing test — which for a while will still be a positional-mock one.

## The rule

> **Data-layer behaviour is proven against a real Postgres database, not
> against mocks.** If an assertion is about what the database does —
> idempotency, locking, constraints, transactional integrity, what a query
> returns — it belongs in a repository test using the real-DB harness.
> Mocking is for collaborators the test does not own (chain RPC, bundlers,
> external HTTP), not for the database.

The reasoning: a mock returning `{rows: [...]}` proves the handler can
consume rows; it cannot show that an `ON CONFLICT` dedupes a replayed
payment, that `FOR UPDATE` serialises two concurrent grant activations, or
that a `withTransaction` block rolls back. Those are the guarantees money
rests on, and for a long time they were the least-tested code in the backend
— 0.06 test-to-source ratio in `infra/repositories/` against 2.57 in
`routes/` when the epic's survey ran.

## The layer map

| Assertion is about… | Belongs in… | Database access |
|---|---|---|
| What Postgres does: dedup, locks, constraints, rollback, what a query returns | a repository test (`src/infra/repositories/__tests__/`) | **real**, via the harness |
| What the handler does: auth, validation, rail resolution, status codes, response shape | a route test (`src/routes/__tests__/`) | smallest possible stub — or real rows via the harness when data must exist |
| A collaborator the test does not own: chain RPC, bundler, external HTTP, signer | either | **mock** — this is what mocking is for |

A route test on a real database is fine and often clearer than a stub. The
rule is against *positional mocking* — `mockResolvedValueOnce` chains that
encode query order — not against mocking as such.

## Using the harness

`packages/backend/src/infra/__tests__/helpers/db-harness.ts`. One Postgres
schema per vitest worker (`test_w<id>`), bound through the connection string
before `config.ts` reads it, so even module-level `pool` imports resolve into
the worker schema. Migrations apply once per worker (idempotently — cheap on
re-entry); `resetDb()` truncates between tests — and **awaits harness init
itself** first, so a file that calls `initDbHarness()` without awaiting it (or
skips it entirely) still cannot race its own worker's migration DDL. That
guarantee exists because the #1555/#1559 outbound files DID call it bare at
describe-registration time, and whenever a new migration had to apply, their
first tests ran concurrently with the DDL — the intermittent 42P01/40P01 CI
failures of 2026-08-19. Prefer the explicit `beforeAll` await below anyway; it
says what happens.

### When there is no database (#1763)

The harness needs `docker compose up -d postgres`. Without one, the backend
run **fails** — in CI and, since #1763, locally too:

| database | `CI` | `HAVEN_SKIP_DB_TESTS=1` | outcome |
|---|---|---|---|
| up | — | — | real-DB suites run; the run closes with a one-line confirmation |
| down | yes | ignored | run fails (unchanged since #1220) |
| down | no | no | **run fails before collection** with both remedies named |
| down | no | yes | suites skip; the run closes with a banner naming how many real-DB files did not run |

The local default inverted because the previous shape — one `console.warn` at
import time, then exit 0 — put the only signal hundreds of lines above a green
summary. Nobody scrolls back, and on 2026-08-21 an agent reported a "passing"
run that had skipped every real-DB suite. A skipped data layer is now
something you *say* you accept (one env var, named in the error), not
something a probe timeout decides for you. The acknowledgement is deliberately
powerless in CI: it is a statement by a human at a terminal, not an override.

Two consequences worth knowing before you meet them:

- **It fires on scoped runs too.** The check runs before collection, so it
  cannot know your file selection — `vitest run one-pure-unit.test.ts` fails on
  a database-free machine exactly like a full run. Export
  `HAVEN_SKIP_DB_TESTS=1` in your shell once if you iterate that way.
- **`npm run quality` at the repo root includes the backend leg**, so a
  frontend-only contributor with no Postgres now hits this. That is the trade
  #1763 accepted: the alternative is a run that reports green having proven
  nothing about the data layer. The error text names both remedies.

The policy is one pure function, `decideDbMode` in
`src/infra/__tests__/helpers/db-availability.ts`, pinned by ordinary mocked
tests that need no database — a guard against silent skipping must not itself
skip silently. `vitest.global-setup.ts` owns the run-level verdict: it probes
once before collection and prints the closing line *after* vitest's summary,
which per-file harness state cannot do.

```ts
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { myRepositoryFunction } from '../my-repository.js'

describeDb('my-repository', () => {
  beforeAll(async () => { await initDbHarness() })
  beforeEach(async () => { await resetDb() })

  it('a replayed insert dedupes — the real ON CONFLICT, twice', async () => {
    await myRepositoryFunction(input)
    await myRepositoryFunction(input) // the second write is the test
    const rows = await db.query(`SELECT COUNT(*)::int AS n FROM my_table`)
    expect(rows.rows[0].n).toBe(1)
  })
})
```

Conventions the conversions settled: row builders stay **local to the test
file** (the harness is deliberately domain-free) and get promoted only when a
second file needs the same shape; seed only the parent rows the foreign keys
genuinely require; exercise every guard on **both** sides — the row that must
transition and the row that must not. The reference conversion is
`delegation-budgets.test.ts` (#1221); the concurrency patterns (claim CAS,
`FOR UPDATE` serialisation with two live transactions) are in
`payment-intents.test.ts` and `agent-connection-setups.test.ts`.

### `resetDb()` belongs in `beforeEach`, not in a loop (#2209)

One more convention, learned from a flake rather than a conversion. `resetDb()`
truncates **every** table in the worker schema, so its cost is set by the
migration count and not by what your test wrote. It is not a per-case
primitive you can sprinkle inside a table-driven loop.

Measured on `dev` at 38 tables: ~250 ms per call with the suite quiet, and
~800 ms–1.2 s under the ordinary parallel load of `vitest run src/db src/infra`,
because several workers TRUNCATE against one Postgres at once. A six-case loop
that reset per case therefore cost seven resets and landed at ~5.7 s against
vitest's 5 s default `testTimeout` — failing on whichever unrelated PR happened
to be running. And the cost **grows with every migration that adds a table**, so
a bumped timeout only moves the date.

Seed the whole case table into one database state and assert on the IDs you
seeded instead of on the batch size. That is usually the stronger assertion
anyway: the query has to pick the right rows out of a table that also holds the
wrong ones, which per-case isolation cannot see. Keep the "nothing extra came
back" half with a closing set-equality check.
`passport-rail-eligibility.test.ts` is the worked example.

## The ratchet

`npm run lint:db-mocks` (`scripts/db-mock-ratchet.mjs`, blocking in
`backend_checks`) counts `vi.mock('…/db.js')` occurrences and
`mockResolvedValueOnce` chain length per test file against
`packages/backend/db-mock-baseline.json` — **shrink-only**, on the shared
`scripts/lib/ratchet.mjs` engine.

Counts, not coverage, deliberately: a coverage percentage can be satisfied
without proving anything and rewards touching whatever is easiest; these
counts measure the thing that actually hurts. After a legitimate reduction,
lock it in with `node scripts/db-mock-ratchet.mjs --update` (it refuses to
ratchet upward). Rare, justified exceptions: a file-level
`// db-mock-exempt: <reason>` with a reason of at least 20 characters — a
suite that characterizes the exact SQL text sent is the canonical example.

## What this does NOT replace

- **`db-schema-smoke.ts` (#773) stays.** It `PREPARE`s the curated money-path
  statements against the migrated schema — column/type drift fails there in
  seconds, on every backend CI run, without seeding data. The harness proves
  *behaviour*; the smoke proves *shape*. Different failure classes, both kept.
- **`lint:deps` stays** — module boundaries are orthogonal to this rule.

## The history (why the rule was earned, not imposed)

- **#757**: mocked route tests validated nothing against the real schema, so
  a join on `agents.safe_address` — a column that does not exist — reached
  dev and 500ed every session payment. That incident produced the schema
  smoke (#773).
- **#775**: positional mock chains shift whenever a handler gains a query;
  the warning comment was copy-pasted across 8+ test files and #1196 had to
  add a defensive stub just to keep a chain aligned. Every money-path change
  paid that toll.
- **#1219**: the survey — 63 files mocking `db.js`, 1,059 positional calls,
  five money-path repositories at zero tests — and the observation that CI
  already ran a Postgres service *in the same job as the suite*. The epic
  pointed the suite at the database that was already there.
