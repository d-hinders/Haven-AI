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
last-verified: "2026-09-07" # #2625: § *`resetDb()` restores ROWS, never SCHEMA* gains the two coverage-gap fixes review found in `assertWorkerSchemaAtHead()`. (1) The guard now diffs a per-table COLUMN/INDEX fingerprint (`readSchemaFingerprint()`), not a table-name list — reproduced by leaving `ALTER TABLE agents ADD COLUMN __scratch_leak text` in a terminal `afterAll` and confirming the name-only guard missed it, the shape-aware one does not. Measured (native Postgres 16, 78 migrations / 34 tables): the fingerprint query has a ~31 ms median against the plain table-name query's ~15 ms — paid once per worker (the head capture) and once per call to the guard, never inside `resetDb()`'s own per-test path, which keeps the cheaper query. (2) `db-harness.ts` now ALSO registers `assertWorkerSchemaAtHead()` once per file at module scope, outside any nested `describe` — reproduced (isolated, no DB) that this root-level registration is NOT skipped when a sibling `afterAll` inside a nested `describe` throws, even though a hook registered inside that describe, scheduled to run after the throw, is; and reproduced end to end against a disposable child vitest process that imports the real `db-harness.js`, leaves real drift with no explicit guard registration of its own, and throws in its own `afterAll` — the drift is still reported. This is additive to the existing per-file `afterAll(assertWorkerSchemaAtHead)` convention, which still gives the earliest possible failure when nothing throws; the two harness smoke files (`db-harness.test.ts`, `db-harness-parallel.test.ts`) needed a `DROP TABLE` for their own scratch table in the same change, because the guard now runs for every real-DB file rather than only the ones that opt in. Verified: the full backend suite green three consecutive runs against native Postgres 16 (242 files, 3153 tests, 2 skipped, 0 failures) after the change. Scope: that ONE subsection's two limits and the guard's own docstring in `db-harness.ts`; nothing else in this doc was re-verified in this pass. Prior: #2616: § *Using the harness* gains § *`resetDb()` restores ROWS, never SCHEMA*. Written from a reproduction, not from reading: leaving a `down()` unrestored at the END of a migration test file poisons the persistent worker schema, the NEXT run's first assertion in that file fails, and that same run then heals it with its own later `up()` — one failure, self-clearing, which is why re-running the file to check is the thing that hides it. Three earlier reproduction attempts failed for exactly that reason and the section says so, because the wrong debugging instinct is the expensive part. The three compounding facts are each verified against `db-harness.ts` at this commit: `resetDb()` empties tables and never creates or drops one, `ensureMigrated()` is memoised and decides from `schema_migrations`, and worker schemas are created `IF NOT EXISTS`. Records why `assertWorkerSchemaAtHead()` is an `afterAll` rather than a check inside `resetDb()` — some files legitimately CREATE tables and `resetDb()` runs in `beforeEach`, so a check there needs an allowlist that drifts. (An earlier draft of this sentence said "six files" from an unchecked grep; the count is unsupported and is GONE rather than re-counted, per amendment 2 below — this metadata line said it in the present tense after the body had dropped it, which a re-review caught.) Amended TWICE, and both amendments are corrections of this same entry's earlier account rather than new material. (2) An independent haven-reviewer pass found the real source: `agents-allowances-retired.test.ts` re-created `agent_allowances` in its `afterAll` under a rule that had inverted — its own comment cited 069 as asserting the table EXISTS, which stopped being true when migration 075 dropped it and 069 inverted. That needs no failure and no kill, and it poisons every worker the file touches; the reviewer reproduced it end to end and then reproduced 069's failure on the schema it left. The section now names it as the cause and demotes process termination to the rarer second route. The `finally` limit is rewritten too: `finally` covers only files that revert a MIGRATION, and this leak came from an ordinary repository test's hook. The unsupported "six test files legitimately CREATE tables" count is removed rather than re-counted — the placement argument never needed a number, and the reviewer measured 5, not 6. (1) Amended after the section was first written, because the full suite then reproduced #2616's actual failure in this tree and the measurement contradicted the draft's account of the TRIGGER: the draft said a failing assertion between `down()` and `up()`, and the real reservoir is process TERMINATION — `075`'s test already restores in a `finally` and 39 of 336 worker schemas on this machine still carried `agent_allowances` with 075 recorded as applied. The § *Two limits* subsection states both limits the first draft would have over-claimed past, and the corrected framing: worker ids are assigned per run, so this presents as order-dependence while involving no ordering at all. Scope: that ONE new subsection and its limits. NOT re-measured or re-derived in this pass: the #2354 contention figures, the #2211 timings, the #2329 hook rule, the layer map, the ratchet, or any other `covers:` target. Prior: #2354: § *Using the harness* gains § *A warm reset that loses to contention* — the warm resetDb() cost measured phase by phase at 1/2/4/8 concurrent workers and 10 vs 36 tables (DELETE path flat in both; floor = catalog read, which scales with pg_class size — 205 orphaned worker schemas locally; TRUNCATE fallback scales with relations AND workers), the proof that a warm reset never takes the migration advisory lock, the deterministic table-lock reproduction of the 5000 ms signature, and the three changes: planEmptying() scopes the cycle fallback to the cycle footprint, RESET_LOCK_WAIT_MS bounds a relation-lock wait and names the holder by pid, the slow-call announcement names its phase (incl. `acquiring connection`, bounded by the pool's connectionTimeoutMillis, haven-reviewer should-fix); the residual limit (slow with no holder) is PINNED by two fixtures rather than described (haven-reviewer should-fix, #2354 item 4); pool exhaustion named as the third wait with its own wrapped failure and fixture (haven-doc-reviewer re-review finding). Verified on this branch against native Postgres 16 under a load average of 9-115 (parallel agent sessions) — the maxima quoted are contended numbers. Scope: the new subsection only; the #2329 subsection was re-read (its ~25 ms warm figure is now qualified as fresh-catalog in the new text rather than edited); the #2211 paragraph's 38 tables / 136 indexes was re-counted with readSchemaShape()'s own predicate — 36 / 130 today, migration 073 (2026-08-31) dropped x402_receipts and x402_resources — and the paragraph now says so (haven-doc-reviewer finding: the diff quoted 36, 38 and 39 without reconciling them); its timings were NOT re-measured. Prior: #2329: harness section re-read against db-harness.ts and gains § *Harness calls belong in a HOOK, not in a test body* — the `beforeAll`/`beforeEach` example was already here as a preference, and two files that ignored it charged the cold migration-run cost to vitest's 5000 ms `testTimeout` instead of the `hookTimeout: 120_000` `vitest.config.ts` sizes for it, reddening a required check twice on unrelated PRs (#2274, #2295). Records the rule, its two escapes, the structural guard that now enforces it, the new 2000 ms slow-call diagnostic, and why raising `testTimeout` was rejected (#2209's "would only have moved the date", one level up). Verified on this branch against native Postgres: the CI failure reproduces deterministically and passes after the fix; measured cold init 572 ms quiet at 73 migrations, warm `resetDb()` ~25 ms. Scope: the harness section and the new subsection only — resetDb()'s DELETE mechanics and the #2211 numbers above them were re-read but NOT re-measured, and nothing outside § *Using the harness* was re-verified. The rule is suite-scoped (a hook in a sibling `describe` does not warm a cold call) and resolves local helper functions to a fixed point in both directions — harness calls reached through a helper, and hooks REGISTERED through one, the latter found by haven-reviewer on re-review as the same hole through a different door. Its one stated limit (a call behind an object method) is pinned by a fixture rather than left implied, and the doc says so, because a guard read as a closed guarantee is worse than one whose edges are written down — both tightened after haven-reviewer reproduced a silent pass for each against the first draft. The hook/body file counts here are AST-derived against `origin/dev`, not grepped — haven-doc-reviewer caught an off-by-one (48 -> 47) in the first draft that came from an indentation heuristic, and the corrected sentence also names the third category the two-bucket framing had hidden (a file budgeted by its own explicit timeout). Prior: #2211: resetDb() now empties the worker schema with foreign-key-ordered DELETEs instead of one TRUNCATE ... RESTART IDENTITY CASCADE — same coverage (every table, every time), cost now set by rows written rather than by relation count: ~371 ms -> ~48 ms quiet, ~414-448 ms -> ~52-61 ms loaded, 861 s -> 345 s of backend test time; harness section re-read against db-harness.ts and the resetDb()-in-a-loop convention rewritten around the new mechanics (the convention itself stands). Prior: #2209: harness section re-read against db-harness.ts; adds the resetDb()-in-a-loop convention with measured per-call cost (~250 ms quiet / ~800 ms-1.2 s loaded at 38 tables) — no harness behaviour changed, initDbHarness()/resetDb()/the beforeAll example are unchanged. Prior: #2198: harness section re-read against db-harness.ts — the cross-worker migration lock now WAITS by polling pg_try_advisory_lock (shared helper db/advisory-lock.ts) instead of blocking in pg_advisory_lock, because a blocking waiter pins a snapshot that deadlocks CREATE INDEX CONCURRENTLY; no doc-visible change, initDbHarness()/resetDb()/the beforeAll example are unchanged. Prior: #1763: the no-database section is rewritten — the local default inverts to failing, HAVEN_SKIP_DB_TESTS=1 acknowledges a narrowed run, and the verdict prints after vitest's summary; harness section re-read against db-harness.ts, the beforeAll example unchanged and still preferred. Prior: resetDb now awaits initDbHarness (the un-awaited-init 42P01/40P01 CI flake); harness section re-read against db-harness.ts, example unchanged and still the preferred shape
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
under the parallel load of a concurrent backend run (38 was the count when #2211
landed on 2026-08-30; migration `073_drop_x402_resource_tables` dropped
`x402_receipts` and `x402_resources` the next day, so the same query counts
**36 tables / 130 indexes** today — the figures #2354 quotes below); a six-case loop paid seven
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

### `resetDb()` restores ROWS, never SCHEMA (#2616)

A test that hand-drives a migration's `up()` or `down()` mutates the worker
schema, and nothing in this harness undoes that. Three facts compound, and
each is load-bearing:

- `resetDb()` empties tables. It never creates or drops one.
- `ensureMigrated()` is memoised per worker and decides from
  `schema_migrations`, which still reads as applied while the table the
  migration dropped is sitting there restored.
- Worker schemas are created `IF NOT EXISTS`, so they outlive the run.

So anything that leaves the schema off head — a `down()` that never reaches
its `up()`, or a hook that CREATES a table and does not drop it — leaves it
off head for every later FILE on that worker **and for every later RUN on that
machine**.

The failure it produces is why this is written down rather than left to care.
The next run's first assertion in that file fails, and that same run then
heals the schema with its own later `up()` calls. **One failure, self-clearing**
— indistinguishable from a flake, and it passes when you re-run the file to
check. #2616 was exactly this, and three reproduction attempts failed before
the mechanism was found, because re-running the file is the thing that hides
it.

Two rules follow:

```ts
await down(db as never)
try {
  // assertions against the restored schema
} finally {
  await up(db as never)   // unconditional — a failing assertion above must not skip it
}
```

and, in any file that changes schema at all — a hand-driven migration, or an
ordinary test creating or dropping a table in a hook:

```ts
afterAll(assertWorkerSchemaAtHead)
```

`assertWorkerSchemaAtHead()` diffs the worker schema against the shape
`ensureMigrated()` left, and fails **in the file that caused the drift**,
naming the tables and the direction they moved. That attribution is the whole
point: the cost of #2616 was not the drift, it was that the drift surfaced as
an unrelated file's mystery failure with nothing pointing back.

#### Two limits, both measured (#2616)

**`finally` is necessary and not sufficient.** It does not run when the
process is KILLED — an interrupted local run, a cancelled CI job. And it
covers only the files that revert a MIGRATION: the leak that actually caused
#2616 came from an ordinary repository test creating a table in a hook, where
there is no `down()` to pair with anything.

**A schema poisoned before the run is invisible to the check above.**
`assertWorkerSchemaAtHead()` diffs against the shape *this run's*
`ensureMigrated()` observed; if the schema was already off head when the run
started, that is the baseline it captures. Nothing repairs it either:
`schema_migrations` reads as applied, so the runner has nothing to do.

Measured on one developer machine at `bfbd07f2`:

```bash
# 336 worker schemas accumulated; 39 carry a table migration 075 DROPPED
psql -tAc "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'test_w%'"
psql -tAc "SELECT count(*) FROM pg_tables WHERE tablename = 'agent_allowances'"
# and 075 is recorded as applied in every one of them
```

Worker ids are assigned per run, so a file lands on a poisoned schema some
runs and not others — which is precisely "fails in the full suite, passes in
isolation", with no ordering involved at all.

**What actually filled that reservoir was a stale comment, not a killed
process** (found by review; the first version of this section said otherwise).
`agents-allowances-retired.test.ts` re-created `agent_allowances` in its
`afterAll`, deliberately, under a rule that had since inverted: its note said a
leaked DROP would break "069's shrink guard, which asserts `agent_allowances`
still EXISTS" — true when written, false since migration **075** dropped the
table for real and 069 inverted to asserting it is **absent**. The repair
became the leak, on every worker that file ever touched, needing no failure and
no kill. Its `afterAll` now drops the table, and it calls
`assertWorkerSchemaAtHead()` so a re-inversion cannot go quiet.

A killed process is a real second route — nothing runs on `SIGKILL`, `finally`
included — but it is the rarer one, and it is not what produced #2616. The
durable fix (init-time drift detection, or disposable worker schemas) is #2622;
until it lands, a drifted schema stays drifted, and the repair is to drop the
resurrected table from the affected `test_w*` schemas.

It deliberately does **not** live in `resetDb()`. Several test files
legitimately CREATE tables in the worker schema, and `resetDb()` runs in
`beforeEach` —
between two tests of such a file the schema is *supposed* to carry an extra
table. A check there would either fire on them or need an allowlist that
drifts. `afterAll`, in the files that change schema, is where the rule is
unambiguous — and that is not only the migration tests, as #2616 itself
showed.

#### Two more coverage gaps, both closed (#2625)

An independent review pass on the #2616 fix (PR #2623) found two more gaps in
`assertWorkerSchemaAtHead()`, neither introduced by that PR — both pre-existing
limits of a guard that did not exist before it, filed so its green would not be
read as more than it was.

**Shape-blind.** The original guard diffed `readSchemaShape().tables` — a
table NAME list. A repair that recreates a table with the wrong columns,
indexes or constraints passed silently: reproduced by leaving
`ALTER TABLE agents ADD COLUMN __scratch_leak text` in a terminal `afterAll`
and observing the name-only guard report clean. Not hypothetical for one real
caller: `agents-allowances-retired.test.ts` recreates `agent_allowances` from
a DDL block hand-copied from a migration file, so a later migration adding a
column to that table would leave the copy off head in SHAPE while still
matching in NAME. The fix widens the head snapshot and the live comparison
from a table-name list to a per-table COLUMN and INDEX fingerprint
(`readSchemaFingerprint()`), kept as a SEPARATE function from
`readSchemaShape()` so the extra catalog cost lands only at the two places
that need it — once per worker (the head capture) and once per call to the
guard — never inside `resetDb()`'s own per-test path. Measured on this branch,
native Postgres 16, 78 migrations / 34 tables, 30 calls each after a warm-up:
`readSchemaFingerprint()` had a ~31 ms median (27-34 ms) against `readSchemaShape()`'s
~15 ms median (10-21 ms) — roughly double, still tens of milliseconds, and paid
only where stated above.

**Skipped when a sibling `afterAll` throws.** The guard is registered FIRST by
callers so vitest's LIFO ordering runs it LAST, after a file's own cleanup —
deliberate, because the question is what a file LEAVES. But when an
earlier-executing sibling `afterAll` in the same suite throws, vitest never
runs the hooks still queued behind it in that suite: a later-registered guard
is skipped outright, not merely delayed — so a repair hook that fails partway
(a lock timeout, an FK cascade, a permissions error) takes the guard down with
it, and the drift reaches later runs unrecorded. `db-harness.ts` cannot change
how any individual caller registers its OWN inner call, so the fix works from
OUTSIDE that registration: the harness module now ALSO registers
`assertWorkerSchemaAtHead()` once per file, at module scope, outside any nested
`describe` — every real-DB file imports this module, so the call happens once
per file in that file's ROOT suite, a different failure boundary than any hook
a nested `describe` registers. Reproduced two ways: isolated (no database) that
a root-level `afterAll` is not skipped by a sibling throwing inside a nested
`describe`, even though a hook registered inside that describe, scheduled to
run after the throw, is; and end to end against a disposable child vitest
process that imports the real `db-harness.js`, leaves real drift with **no**
explicit guard registration of its own anywhere, and throws in its own
`afterAll` — the drift is still reported, attributed to the correct table.

**What this now guarantees, and what it still does not.** Every real-DB file
now gets the schema-purity check automatically, whether or not it opts in —
which means "a file that legitimately creates a table in a hook and leaves it"
is no longer a safe pattern ANYWHERE, not only in the files that used to
opt in. This repo's own two harness smoke files
(`db-harness.test.ts`, `db-harness-parallel.test.ts`) did exactly that (a
scratch table for the cross-worker isolation proof, kept around rather than
dropped) and needed a `DROP TABLE` in their own `afterAll` in the same change.
The existing per-file `afterAll(assertWorkerSchemaAtHead)` convention is not
made redundant by this — it still gives the earliest possible failure in the
ordinary, non-throwing case, registered as a second, additional call. What is
still true from the section above: a schema already poisoned before a run
started is invisible to either registration, because both diff against
whatever `ensureMigrated()` observed AT THE START of this run, and a killed
process still skips every `afterAll`, root-level ones included.

Verified: the full backend suite green on three consecutive runs against
native Postgres 16 (242 files, 3153 tests, 2 skipped, 0 failures).

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

The guard resolves **local helper functions** to a fixed point in both
directions — a `resetDb()` moved one function away from the test still counts,
and a `beforeEach` registered inside a helper warms the suite that *calls* the
helper rather than the whole file. It has two **stated limits**, both pinned by
fixtures rather than left implied: a harness call behind an object method
(`helpers.coldSetup()`) is invisible, and a suite body written as a named
function reports a false positive. The second is the safe direction and is left
as residue deliberately. Read a green run as "no unbudgeted cold call in the
shapes the guard resolves", not as a closed guarantee.

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

### A warm reset that loses to contention (#2354)

The rule above narrows the exposure; it does not remove contention
sensitivity. `haven-reviewer`, reviewing #2329 under its own ad-hoc concurrent
load, saw `db-harness-reset-cleans-everything.test.ts` — warm, and with every
call site in the right place — exceed the 5000 ms `testTimeout`, then pass
alone in 647 ms. Six interleaved rounds against clean `dev` gave 0/6 failures
on both arms, so it never reproduced under ordinary load. A test that fails only
when the machine is busy reports on the machine, and reads as a flake every
time — the same family as
[#2319](https://github.com/d-hinders/Haven-AI/issues/2319).

**The mechanism was measured before anything was changed**, phase by phase,
with a script mirroring `performReset()` statement for statement (one Node
process per simulated worker, each in its own `test_w<N>` schema, using `pg`
directly against `postgres://haven:haven@localhost:5432/haven`; the script is
attached to the #2354 pull request) — native Postgres 16, 20 resets per worker,
medians (the machine carried a load average
of 9–115 from parallel agent sessions throughout, so the maxima below are
contended numbers, not quiet ones). The population is the one `readSchemaShape()`
reads, counted with its own predicate against the migrated worker schema
(74 migrations applied, 2026-09-02):

```sql
-- psql postgres://haven:haven@localhost:5432/haven   (native PostgreSQL 16.13, 2026-09-02)
SELECT count(*) FROM pg_tables t
 WHERE t.schemaname = 'test_w1' AND t.tablename <> 'schema_migrations';
-- 36      (SELECT count(*) FROM pg_indexes WHERE schemaname = 'test_w1';  -- 130)
```

That is #2211's 38 / 136 minus the two tables migration 073 dropped, not a
different population — the census file's `tableCensus()` uses the identical
predicate, so "36" here, "36 DELETEs" in the phase label and the census are
three readings of one query.

| path | 1 worker | 2 | 4 | 8 | what moves |
| --- | --- | --- | --- | --- | --- |
| DELETE — catalog read | 86 ms | 94 | 100 | 108 | flat in workers |
| DELETE — the 36 `DELETE`s | 5 ms | 6 | 6 | 6 | flat in workers **and** tables (10 vs 36 tables: 1.5 vs 3.2 ms) |
| TRUNCATE fallback — all 36 relations | 394 ms | 333 | 482 | **819** | ~8 ms per relation (10 vs 36: 162 vs 298 ms), ~2× from 1 to 8 workers, **6.2 s** max under I/O saturation |

So the distinguishing question has a clear answer. **The DELETE path scales
with neither workers nor tables.** Its floor is the catalog read, and that
scales with the size of the whole database's catalog: the developer database
these numbers came from had accumulated **205 orphaned `test_w<N>` schemas**
(worker ids are not reused across runs), so `readSchemaShape()` seq-scanned
46 730 `pg_class` rows twice per reset — ~100 ms where a fresh CI Postgres pays
a few. The ~25 ms warm figure quoted in the rule above is a fresh-catalog
number; the local floor is set by how many runs the database has seen. **The
one path that scales with both relations and workers is the `TRUNCATE`
fallback**, and before #2354 a single foreign-key cycle anywhere sent *every*
table down it — exactly what the census file's cycle case did, in a test body,
on the 5000 ms budget. That is the test that failed.

**And the advisory lock explains nothing here.** A warm reset never takes it —
`ensureMigrated()` is memoised — which was proved rather than reasoned: holding
`811000061` from an external `psql` session for 8 s while the file ran, the
`beforeAll` waited under `hookTimeout` and every test then passed (exit 0). The
lock is the cold path's whole story (#2329) and no part of this one.

**What a warm reset can genuinely lose to is a relation lock** held by another
session on *this worker's* tables — other workers live in other schemas.
Reproduced deterministically: an external session holding a plain `ACCESS
SHARE` on one table (`BEGIN; SELECT … FROM test_w1.users; pg_sleep(45)`) lets
every `DELETE` through and blocks the `TRUNCATE` — the cycle case died with a
bare `Test timed out in 5000ms` naming the test and nothing else (exit 1); the
same file alone passed (exit 0). Realistic holders: a transaction a test left
open, or an orphaned vitest worker with the same `VITEST_WORKER_ID` (#2319
found eight orphans on one machine).

**What changed, and why none of it is a bigger number:**

1. **The fallback is scoped to the cycle's footprint.** `planEmptying()`
   `DELETE`s every table Kahn's algorithm can order and `TRUNCATE … CASCADE`s
   only the ones it cannot — the cycle members and the tables they reference.
   Coverage is identical (the two halves always partition the table list, and
   `plan-delete-order.test.ts` pins that); the cost is now the cycle's
   relations, not the schema's. The census file's cycle case truncates 2
   relations (`cycle_a`, `cycle_b`) instead of 38 (the 36 above plus those
   two), and the reproduction above goes green.
2. **A lock wait is bounded and named.** The emptying runs in one transaction
   under `RESET_LOCK_WAIT_MS` (3000 ms) via `lock_timeout`, which counts only
   time spent waiting for a lock another session *holds* — a busy machine with
   no holder never trips it. On expiry the reset throws
   `db-harness: resetDb() gave up after 3000 ms waiting for a relation lock in
   test_wN (phase: …). Held by: pid P (client backend, idle in transaction,
   xact 3s, "LOCK TABLE …")` — the holder's pid, state, transaction age and
   last statement, read from `pg_locks` × `pg_stat_activity` after the reset's
   own transaction rolled back. `db-harness-reset-contention.test.ts` pins that
   the failure is bounded, attributed to the *right* session by pid, and
   recoverable (the pooled connection comes back clean and the next reset
   succeeds), and that the three budgets are ordered:
   `SLOW_HARNESS_CALL_MS` (2000) < `RESET_LOCK_WAIT_MS` (3000) < 5000 — the
   announcement says which *phase* is stuck, the deadline says *who* holds it,
   and both land before the anonymous per-test timeout could.
3. **The slow-call announcement names its phase.** Before #2354 it printed the
   cold explanation — the migration run and the advisory lock — verbatim for a
   warm reset blocked on a table lock, pointing the reader at the one thing a
   warm reset never waits on. It now reads
   `resetDb() has been running 2s in phase "emptying (36 DELETEs)"` and, for a
   warm phase, says that the migration run is already paid and what a warm
   call can actually be waiting on.

**The per-test budget is untouched.** A reset that simply hangs still dies at
5000 ms; the change makes the failure honest about its cause, not rarer for
the wrong reasons. Proved by mutation: a reset that leaves `rate_limit_counters`
dirty fails the census on that table; a fallback that skips its `TRUNCATE`
fails the cycle case; a harness without the `lock_timeout` hangs the contention
test until its own budget kills it; and the same external lock that reproduced
the timeout now produces the named failure instead — each restored from a `cp`
backup and verified byte-identical with `diff -q`.

**What is deliberately not fixed — and pinned so it cannot be closed
silently.** A machine loaded enough that a 5 ms `DELETE` batch takes seconds —
observed once here at a load average of 115 — still times the test out, with no
holder to name. That is the machine's cost, and no budget makes it a property
of the code. What the harness owes that case is honesty, and two fixtures in
`db-harness-reset-contention.test.ts` hold it to that: a reset slowed by a
statement-level trigger sleeping through one `DELETE` (no lock anywhere) must
announce `in phase "emptying (N DELETEs)"` (N = the current table count) as a
*WARM call*, name nobody, and
complete; and the lock message's no-holder branch, read directly, must say "no
session holds a lock on this schema any more" rather than invent a pid. The
day either starts lying — or someone "fixes" the residue by making a slow reset
fail — those go red.

A third wait has its own name. A pooled connection under **pool exhaustion**
(every one of the worker's `DB_POOL_MAX` clients — 5 under vitest — checked out
by a test that never released one) is bounded by the pool's own
`connectionTimeoutMillis` (`config.dbPoolConnectionTimeout`), never by
`lock_timeout`, and it surfaces in whichever phase first needs the pool —
usually `catalog read`, since `readSchemaShape()` runs before the dedicated
client is taken, otherwise `acquiring connection`. pg-pool's bare "timeout
exceeded when trying to connect" is wrapped into `db-harness: resetDb() could
not get a pooled connection (phase: …) — pool exhaustion: all DB_POOL_MAX=5 …`
so it reads like the lock failure, and the announcement's cause line branches
on the phase so a label and its explanation cannot disagree. Pinned by a
fixture that checks out all `DB_POOL_MAX` clients and expects exactly that
message, then recovers (`npx vitest run
src/infra/__tests__/helpers/__tests__/db-harness-reset-contention.test.ts`
from `packages/backend`, same host as the query above). Acquisition measured
at a 0.1 ms median here — the `connect` row of the same phase-timing script
that produced the table, one Node process per worker against
`postgres://haven:haven@localhost:5432/haven`; named for the day it is not.

The 205 orphaned worker schemas are a local catalog-bloat cost (each adds ~37
tables and ~130 indexes to every `pg_class` scan) that CI's fresh service
container never pays; pruning them is a developer-database housekeeping matter,
not a harness change.

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
