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
last-verified: "2026-09-01" # #2329: harness section re-read against db-harness.ts and gains § *Harness calls belong in a HOOK, not in a test body* — the `beforeAll`/`beforeEach` example was already here as a preference, and two files that ignored it charged the cold migration-run cost to vitest's 5000 ms `testTimeout` instead of the `hookTimeout: 120_000` `vitest.config.ts` sizes for it, reddening a required check twice on unrelated PRs (#2274, #2295). Records the rule, its two escapes, the structural guard that now enforces it, the new 2000 ms slow-call diagnostic, and why raising `testTimeout` was rejected (#2209's "would only have moved the date", one level up). Verified on this branch against native Postgres: the CI failure reproduces deterministically and passes after the fix; measured cold init 572 ms quiet at 73 migrations, warm `resetDb()` ~25 ms. Scope: the harness section and the new subsection only — resetDb()'s DELETE mechanics and the #2211 numbers above them were re-read but NOT re-measured, and nothing outside § *Using the harness* was re-verified. The rule is suite-scoped (a hook in a sibling `describe` does not warm a cold call) and follows local helper functions to a fixed point — both tightened after haven-reviewer reproduced a silent pass for each against the first draft. The hook/body file counts here are AST-derived against `origin/dev`, not grepped — haven-doc-reviewer caught an off-by-one (48 -> 47) in the first draft that came from an indentation heuristic, and the corrected sentence also names the third category the two-bucket framing had hidden (a file budgeted by its own explicit timeout). Prior: #2211: resetDb() now empties the worker schema with foreign-key-ordered DELETEs instead of one TRUNCATE ... RESTART IDENTITY CASCADE — same coverage (every table, every time), cost now set by rows written rather than by relation count: ~371 ms -> ~48 ms quiet, ~414-448 ms -> ~52-61 ms loaded, 861 s -> 345 s of backend test time; harness section re-read against db-harness.ts and the resetDb()-in-a-loop convention rewritten around the new mechanics (the convention itself stands). Prior: #2209: harness section re-read against db-harness.ts; adds the resetDb()-in-a-loop convention with measured per-call cost (~250 ms quiet / ~800 ms-1.2 s loaded at 38 tables) — no harness behaviour changed, initDbHarness()/resetDb()/the beforeAll example are unchanged. Prior: #2198: harness section re-read against db-harness.ts — the cross-worker migration lock now WAITS by polling pg_try_advisory_lock (shared helper db/advisory-lock.ts) instead of blocking in pg_advisory_lock, because a blocking waiter pins a snapshot that deadlocks CREATE INDEX CONCURRENTLY; no doc-visible change, initDbHarness()/resetDb()/the beforeAll example are unchanged. Prior: #1763: the no-database section is rewritten — the local default inverts to failing, HAVEN_SKIP_DB_TESTS=1 acknowledges a narrowed run, and the verdict prints after vitest's summary; harness section re-read against db-harness.ts, the beforeAll example unchanged and still preferred. Prior: resetDb now awaits initDbHarness (the un-awaited-init 42P01/40P01 CI flake); harness section re-read against db-harness.ts, example unchanged and still the preferred shape
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
re-entry); `resetDb()` empties every table between tests — and **awaits harness init
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

### `resetDb()` belongs in `beforeEach`, not in a loop (#2209, #2211)

One more convention, learned from a flake rather than a conversion. `resetDb()`
covers **every** table in the worker schema, so its cost is set by the schema
and not by what your test wrote. It is not a per-case primitive you can sprinkle
inside a table-driven loop.

Seed the whole case table into one database state and assert on the IDs you
seeded instead of on the batch size. That is usually the stronger assertion
anyway: the query has to pick the right rows out of a table that also holds the
wrong ones, which per-case isolation cannot see. Keep the "nothing extra came
back" half with a closing set-equality check.
`passport-rail-eligibility.test.ts` is the worked example.

**What #2211 changed, and what it did not.** The convention above was written
when the reset was one `TRUNCATE … RESTART IDENTITY CASCADE` over the whole
table list. `TRUNCATE` costs a roughly fixed amount **per relation** — every
truncated table and every one of its indexes gets a fresh relfilenode — so the
reset got slower with every migration that added a table, regardless of what any
test did. At 38 tables / 136 indexes that measured ~371 ms quiet and ~414–448 ms
under the parallel load of a concurrent backend run; a six-case loop paid seven
resets and blew vitest's 5 s default `testTimeout` (#2209), and a bumped timeout
would only have moved the date.

`resetDb()` now empties the same tables with foreign-key-ordered `DELETE`s, whose
cost is set by the ROWS a test actually wrote rather than by the relation count.
Same measurement, interleaved so catalog bloat and machine drift hit both arms
equally: **~48 ms quiet, ~52–61 ms loaded** — 7–8× cheaper on both. Across the
whole backend suite that is 861 s → 345 s of test time (221 files, 2 778 tests).

Coverage is unchanged — every table, every time — and that is the part worth
being careful about: a faster reset that quietly stopped cleaning something
would be a correctness regression disguised as a speedup.
`db-harness-reset-cleans-everything.test.ts` proves it rather than asserting it,
by taking a post-reset row census over `pg_tables` (the catalog, not a list the
harness maintains) with a named seed as the positive control.

So the convention **stands** — a loop that resets per case is still the wrong
shape, and the reset is still the most expensive thing in a real-DB test — but
it is no longer the only thing standing between the suite and the next
migration.

### Harness calls belong in a HOOK, not in a test body (#2329)

The sibling of the rule above, and the reason the `beforeAll`/`beforeEach`
example is a requirement rather than a preference.

Both harness entry points can pay the **cold** cost. Each awaits the same
memoised migration run — the one `initDbHarness()` exposes — which brings the
worker's schema to the migration head and is serialised across workers on one
advisory lock, so a waiting worker pays the runs queued ahead of it too. `vitest.config.ts` budgets exactly that
with `hookTimeout: 120_000` (#1372) — and **that budget only applies to a call
made from a hook**. The identical call as the first statement of an `it` body is
charged to vitest's 5000 ms `testTimeout` instead, which was never sized for a
migration run.

That is not a theoretical gap. On [#2295](https://github.com/d-hinders/Haven-AI/issues/2295)'s
CI run one bare `resetDb()` measured **4634 ms against that 5000 ms**, versus
**1162 ms** on green `dev` with the same 223 files — so `collect` was flat, the
suite had not grown, and what moved was execution under contention. Counted
against `dev` with the TypeScript AST, **47** backend test files call the harness
from a hook and could never trip the per-test budget; seven call it from a test
body, of which four are warmed by a hook of their own and one more
(`db-harness-lock-concurrency.test.ts`) declares an explicit 180 000 ms timeout.
That leaves exactly two unbudgeted — and they are exactly the two that failed:
`uuid-param-22p02.test.ts` and `catalog-ingest-lock.test.ts` timed out on pull
requests they had nothing to do with, twice
([#2274](https://github.com/d-hinders/Haven-AI/issues/2274), then #2295), each
time reporting a bare `Test timed out in 5000ms` against an innocent test name.

**The rule**, enforced by
`helpers/__tests__/harness-call-budget.test.ts` over the TypeScript AST: a
`resetDb()` / `initDbHarness()` call inside an `it` body is allowed only when

1. a `beforeAll`/`beforeEach` in **that test's own `describe`, or an enclosing
   one**, also calls the harness — so the cold run is already paid and the
   in-body call is a warm one (~25 ms). This is how the harness's own suites
   reset mid-test, where the reset **is** the subject. Suite-scoped rather than
   file-scoped deliberately: a hook in a sibling block says nothing about a cold
   call in this one, and the guard's first draft got that wrong; or
2. that `it` declares an explicit timeout of its own — either spelling,
   `it(name, fn, 180_000)` or `it(name, { timeout: 180_000 }, fn)` — as
   `db-harness-lock-concurrency.test.ts` does to keep an unwarmed
   `initDbHarness()` as its positive control.

The guard follows the harness through **local helper functions** too, to a fixed
point, so moving `await resetDb()` one function away does not hide it.

Either way the budget a harness call runs under is readable at the call site
instead of inherited from where someone happened to type it.

**Raising `testTimeout` was rejected, for #2209's reason one level up.** A bumped
timeout "would only have moved the date" there; here it does not even have a date
to move to. The cold path's worst case is a migration run plus every queued
worker's run ahead of it — which is why the harness's own lock deadline is
deliberately *larger* than `hookTimeout` — so any `testTimeout` big enough to
cover it is one at which the per-test timeout no longer detects a hung test, and
it would apply to all 223 backend files to protect two call sites. The repository
already answered this once with two numbers for two kinds of cost; the fix keeps
call sites on the right side of that line rather than moving the line.

**And a slow harness call now says so.** `resetDb()`/`initDbHarness()` warn at
2000 ms — chosen to land *inside* the 5000 ms budget, so the diagnosis reaches
the log before any timeout could fire — naming the reset, the advisory lock and
the hook/test distinction, and printing the total when it finishes. The old
failure named an innocent test and said nothing about the cause, which is why
diagnosing it took a `dev`-baseline comparison at all.

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
