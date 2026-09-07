/**
 * Two coverage gaps in `assertWorkerSchemaAtHead()` (#2616), both found and
 * reproduced by an independent review pass on #2623 and filed as #2625.
 * Neither is hypothetical; both are reproduced here.
 *
 * ## 1. Shape-blind
 *
 * The original guard diffed `readSchemaShape().tables` — a table NAME list.
 * A repair that recreates a table with the wrong columns, indexes or
 * constraints passed silently. Reproduced directly below by leaving a leaked
 * column on an existing table (the exact reproduction from the issue:
 * `ALTER TABLE agents ADD COLUMN __scratch_leak text`) and showing the guard
 * now names it. This is not hypothetical for one real caller:
 * `agents-allowances-retired.test.ts` recreates `agent_allowances` from a
 * hand-copied `CREATE TABLE` block, so a later migration that adds a column
 * to that table would leave the copy off head in SHAPE while still matching
 * in NAME — which is exactly what a name-only diff cannot see.
 *
 * ## 2. Skipped when a sibling `afterAll` throws
 *
 * `assertWorkerSchemaAtHead()` is registered FIRST by callers so vitest's LIFO
 * ordering runs it LAST, after a file's own cleanup — deliberate, because the
 * question is what a file LEAVES. But when an earlier-executing sibling
 * `afterAll` in the SAME suite throws, vitest never runs the hooks still
 * queued behind it in that suite: a later-registered guard is skipped
 * outright, not merely delayed.
 *
 * The fix in `db-harness.ts` is a root-level `afterAll(assertWorkerSchemaAtHead)`
 * call at module scope (see the top of that file, just above `describeDb`):
 * every real-DB file imports that module, so the call happens once per file,
 * in that FILE's root suite — a different failure boundary than any hook a
 * nested `describe` registers.
 *
 * A real reproduction of this needs a suite that genuinely fails — a
 * throwing `afterAll` — which cannot be proven from an assertion inside a
 * normal, always-green `it`: the failure is a property of the WHOLE test
 * file's run, not of one expression. So `the guard fires even when a sibling
 * afterAll throws` below drives it against a REAL, disposable, child vitest
 * process: a generated fixture file that imports the real `db-harness.js`,
 * introduces real schema drift with no explicit `assertWorkerSchemaAtHead()`
 * registration of its own at all, and throws in a nested `describe`'s
 * `afterAll` exactly the way a real repair failing partway would. The
 * assertions run in THIS (always-green) process, over the child's exit code
 * and output — proving the root-level call fires purely from importing
 * `db-harness.js`, with no call site opting in.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import db from '../../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  WORKER_SCHEMA,
} from '../db-harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** The package root — the child's cwd, and the seed for its schema suffix. */
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')

/**
 * The child's schema-name suffix: fixed within a checkout, distinct between
 * checkouts.
 *
 * Both halves are load-bearing, and the design moved twice before this.
 *
 * FIXED, not per-run: a brand-new schema pays the full migration set and
 * leaves an orphan behind (#2622), which blew the 60 s budget. So it cannot
 * carry a pid or a timestamp.
 *
 * But a globally fixed name is not safe either (found by review). More than
 * one agent session works this repo concurrently against the SAME local
 * Postgres — `AGENTS.md` § *Cross-session agent coordination* — and the child
 * is always worker 1, so every session would target `test_w1_guard2625` at
 * once: two children migrating and fingerprinting one schema, and each
 * session's cleanup dropping the column the other's child had just added.
 * The victim sees no guard message and fails blaming the guard — the exact
 * mis-attribution #2616 and #2625 exist to remove.
 *
 * Seeding from the checkout path gives both properties at once, because
 * concurrent sessions are required to use separate worktrees.
 *
 * Two things this does NOT close, stated because the paragraph above otherwise
 * reads as a closed guarantee:
 *
 *   - Two runs of the suite from the SAME worktree still share this suffix, so
 *     run A's pre-spawn cleanup can drop the column run B's child just added
 *     and B fails on the missing guard message. Bounded rather than fixed:
 *     `AGENTS.md` requires concurrent sessions to take separate worktrees, and
 *     CI runs the suite once per job.
 *   - One schema per checkout is created and never dropped by anything. It is
 *     one, not one per run — but it is permanent, and it lands in the same
 *     `pg_class` whose size sets this harness's reset floor (#2622). The
 *     scoping that keeps `dropFixtureLeak()` out of other sessions' schemas is
 *     also what stops it reaching schemas stranded by earlier revisions of
 *     this file.
 */
const SESSION_SUFFIX = `_guard2625_${createHash('sha256')
  .update(PACKAGE_ROOT)
  .digest('hex')
  .slice(0, 8)}`

/** The scratch column the child fixture leaks, named once. */
const FIXTURE_COLUMN = '__scratch_2625_fixture_leak'

/**
 * Where the disposable child fixture is written — deliberately outside `src/`,
 * and excluded from vitest's own `include` (see `vitest.config.ts`).
 */
const FIXTURE_DIR = path.join(PACKAGE_ROOT, '.tmp-fixtures')

describeDb('assertWorkerSchemaAtHead (#2625)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  describe('shape-blind gap: a leaked column is not a leaked table', () => {
    it('is invisible to a name-only diff and caught by the column/index fingerprint', async () => {
      // Baseline: nothing has touched the schema yet.
      await expect(assertWorkerSchemaAtHead()).resolves.toBeUndefined()

      // The issue's own reproduction, verbatim: a terminal ALTER that adds a
      // column to an EXISTING table. The table list is unchanged — this is
      // exactly the case a `tables: string[]` diff cannot see.
      await db.query('ALTER TABLE agents ADD COLUMN __scratch_leak_2625 text')
      try {
        await expect(assertWorkerSchemaAtHead()).rejects.toThrow(
          /different COLUMN or INDEX shape.*agents \(columns \+__scratch_leak_2625\)/s,
        )
      } finally {
        // Restore head so later tests/files on this worker are not poisoned
        // by this reproduction (testing-strategy.md's own rule for this guard).
        await db.query('ALTER TABLE agents DROP COLUMN IF EXISTS __scratch_leak_2625')
      }
      await expect(assertWorkerSchemaAtHead()).resolves.toBeUndefined()
    })

    it('also catches a leaked index with the table shape otherwise unchanged', async () => {
      await db.query(
        'CREATE INDEX __scratch_leak_2625_idx ON agents (delegate_address, created_at)',
      )
      try {
        // Asserts INDEXES specifically. Matching the columns half here would
        // have passed on the wrong evidence — the message names both halves,
        // so a loose pattern cannot tell this test from the one above it.
        await expect(assertWorkerSchemaAtHead()).rejects.toThrow(
          /different COLUMN or INDEX shape.*agents \(indexes \+__scratch_leak_2625_idx\)/s,
        )
      } finally {
        await db.query('DROP INDEX IF EXISTS __scratch_leak_2625_idx')
      }
      await expect(assertWorkerSchemaAtHead()).resolves.toBeUndefined()
    })
  })

})

/**
 * Source for the disposable child fixture: a nested `describe` introduces
 * real drift (an `ALTER TABLE` with no matching restore) and throws in its
 * OWN `afterAll` before repairing it — the shape #2625 names ("a lock
 * timeout, an FK cascade, a permissions error" partway through a real file's
 * own cleanup) — and registers NO explicit `assertWorkerSchemaAtHead()` call
 * of its own anywhere. If the drift is still reported, it can only be
 * `db-harness.ts`'s own automatic root-level registration that reported it.
 *
 * vitest assigns the child's `VITEST_WORKER_ID` itself (an inherited env
 * override does not stick), so which worker schema the fixture lands in is
 * not something this test controls or can predict — reproduced running the
 * SAME id (`test_w1`) as the outer process on this machine. The cleanup
 * below reads the schema name back out of the child's own error message
 * rather than assuming one, and repairs THAT schema through the outer
 * process's `db` client by fully qualifying the table (`schema.agents`),
 * which works regardless of which schema the child used or whether it
 * matches this file's own.
 */
const FIXTURE_SOURCE = `
import { afterAll, beforeAll, it } from 'vitest'
import db from '../src/db.js'
import { describeDb, initDbHarness } from '../src/infra/__tests__/helpers/db-harness.js'

describeDb('fixture: a sibling afterAll throws with no explicit guard registration', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  it('introduces real drift with no matching restore', async () => {
    // IF NOT EXISTS: this fixture is disposable and regenerated every run,
    // but the worker SCHEMA it lands in is not — a prior aborted run of this
    // same reproduction could have left the column behind, and a plain ADD
    // COLUMN would then fail on a DIFFERENT error (duplicate_column) than the
    // one this fixture exists to cause.
    await db.query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS ${FIXTURE_COLUMN} text')
  })

  afterAll(() => {
    throw new Error('MARKER_SIMULATED_THROW')
  })
})
`

/**
 * Drop the fixture's leaked column from EVERY schema that has it, found by
 * catalog query rather than by name (#2625).
 *
 * The child's `VITEST_WORKER_ID` is assigned by its own vitest, not by the
 * env this process passes, so the exact schema it lands in is not something
 * this test can predict — and on the run that matters most it has no message
 * to read the name out of. Asking the catalog which schemas actually carry
 * the column needs neither prediction nor a successful assertion.
 *
 * SCOPED to this session's own schema family and to `agents`, not "every
 * schema that has a column with this name" (found by review). The unscoped
 * form would reach into a concurrent session's child schema and drop the
 * drift that session's guard was about to read.
 */
async function dropFixtureLeak(): Promise<void> {
  const { rows } = await db.query<{ table_schema: string }>(
    `SELECT table_schema FROM information_schema.columns
      WHERE column_name = $1 AND table_name = 'agents'`,
    [FIXTURE_COLUMN],
  )
  // Filtered here rather than in a `LIKE`: the suffix is full of underscores,
  // every one of which is a LIKE wildcard, and getting that escaping subtly
  // wrong would silently widen the drop back to every session's schema — the
  // failure this scoping exists to prevent, reintroduced by the scoping.
  for (const { table_schema } of rows) {
    if (!table_schema.endsWith(SESSION_SUFFIX)) continue
    await db.query(`ALTER TABLE ${table_schema}.agents DROP COLUMN IF EXISTS ${FIXTURE_COLUMN}`)
  }
}

describeDb('the guard fires even when a sibling afterAll throws (#2625)', () => {
  it(
    "reports the drift purely from importing db-harness.js — no call site opts in, and the sibling's throw does not suppress it",
    async () => {
      // OUTSIDE `src/`, and this is not tidiness (#2690 review, blocking).
      // Five test files under `src` walk the tree with `readdirSync` and then
      // `readFileSync` what they listed — `harness-call-budget.test.ts`,
      // `non-custody.invariants.test.ts`, `chain-default-guard.test.ts`,
      // `migration-registry.test.ts`, `dependency-parity.test.ts`. This
      // fixture lived in `src` for ~3 s per run, so any of them that listed it
      // before the `rmSync` and read it after died on ENOENT — an unrelated
      // file failing for a reason nothing in it explains. Reproduced at
      // `--sequence.shuffle.files --sequence.seed=42`.
      //
      // The second failure mode is not a race at all: kill the parent between
      // the write and the `finally`, and the fixture persists as a collectable
      // test file whose `afterAll` throws and whose `it` drifts the schema —
      // a permanently red suite that looks like drift in an innocent file.
      // `.tmp-fixtures/**` is in `vitest.config.ts`'s `exclude` for exactly
      // that, which is why the child below overrides `--exclude`.
      fs.mkdirSync(FIXTURE_DIR, { recursive: true })
      const fixturePath = path.join(FIXTURE_DIR, `hook-order-2625.${process.pid}.fixture.test.ts`)
      fs.writeFileSync(fixturePath, FIXTURE_SOURCE)
      // BEFORE the spawn, not only after (#2625). The child's schema is a
      // FIXED name that outlives the run, so a leak left by any earlier run —
      // an aborted one, or a hand-run of the fixture — is still there when the
      // child migrates. `headShape` is captured AFTER migrations, so a
      // pre-existing leak is baked into head itself: the drift is present and
      // the guard is correctly silent, and this test would fail claiming the
      // guard does not fire. That made the reproduction vacuous exactly once
      // it had succeeded. Cleaning first makes each run start from head.
      await dropFixtureLeak()
      let leakedSchema: string | null = null
      try {
        // The child MUST NOT drift a schema a parent worker is using
        // (#2625, found by review). A spawned `vitest run` always gets
        // `VITEST_WORKER_ID=1`, so without this suffix the fixture drifted
        // `test_w1` while the parent suite was still running files on it —
        // and a co-running innocent file then failed with the guard's
        // message, blamed for drift it did not cause. Reproduced twice out of
        // two attempts: 6 and 7 mis-attributed failures.
        //
        // That is the mis-attribution #2616 and #2625 exist to remove,
        // reintroduced by the test that proves they work. The suffix gives the
        // child a schema of its own.
        const result = spawnSync(
          'npx',
          [
            'vitest',
            'run',
            fixturePath,
            '--reporter=basic',
            '--no-file-parallelism',
            // Lifts the main config's `.tmp-fixtures/**` exclusion, which
            // exists so an ORPHANED fixture can never be collected by an
            // ordinary run. A CLI `--exclude` cannot do this: vitest APPENDS
            // it to the configured excludes rather than replacing them, so the
            // child reported "No test files found" — verified, after an
            // earlier probe of the flag gave a false pass by testing the
            // override before the exclusion it was meant to override existed.
            '--config',
            'vitest.fixture.config.ts',
          ],
          {
            // The PACKAGE root, derived from this file — never
            // `process.cwd()` (#2625). vitest's cwd is whatever invoked the
            // parent run: `npm run test -w packages/backend` gives the
            // package, a repo-root `vitest --root packages/backend` gives the
            // repo root. In the latter the child resolved the ROOT vitest
            // config, which has no backend setup file and therefore no
            // DATABASE_URL — so the child died before collection and this
            // test failed on a missing guard message, blaming the guard for
            // a spawn defect.
            cwd: PACKAGE_ROOT,
            encoding: 'utf-8',
            // Fixed within this checkout, distinct between checkouts — see
            // `SESSION_SUFFIX`, which carries the whole argument. Neither
            // half is optional: per-run names blow the time budget and leak
            // schemas, one global name collides with every concurrent agent
            // session on this machine.
            env: { ...process.env, HAVEN_TEST_SCHEMA_SUFFIX: SESSION_SUFFIX },
          },
        )
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

        // Positive control: the run genuinely failed — the sibling's own
        // throw, proving this reproduction actually exercised the failure
        // path rather than passing vacuously.
        expect(result.status).not.toBe(0)
        expect(output).toContain('MARKER_SIMULATED_THROW')

        // The reproduction: db-harness.ts's own root-level registration
        // reported the drift, naming the affected table by its shape
        // difference — even though nothing in the fixture ever called
        // `assertWorkerSchemaAtHead()` itself.
        // Allows the isolation suffix this test now sets. The pattern was
        // `test_w\d+` and stopped matching the moment the child got its own
        // schema — the fix to one defect breaking the assertion that proves
        // another.
        const attribution = output.match(/this file left (test_w[\w]+) off migration head/)
        expect(attribution).not.toBeNull()
        leakedSchema = attribution?.[1] ?? null
        expect(output).toMatch(/different COLUMN or INDEX shape: agents \(columns \+__scratch/)
        // And the child used ITS OWN schema, not one a parent worker holds.
        //
        // This assertion has now been wrong twice, in opposite directions,
        // and the second way is the instructive one. It was `/_guard2625_/`
        // — a trailing underscore no schema name can have, so it could only
        // FAIL. The fix compared against `` `${WORKER_SCHEMA}_guard2625` ``,
        // which could only pass when this file happened to sort FIRST:
        // `VITEST_WORKER_ID` is the file's ordinal in the run's spec list
        // (vitest increments it once per `runFiles`, and `isolate: true`
        // dispatches one call per file), so the spawned child — always a
        // single-file run — is always worker 1, while the parent's id is
        // whatever position this file landed in. Under the default cold-cache
        // size ordering that is 53, and CI never has a warm cache. It passed
        // locally only because vitest's sequencer runs previously-FAILED
        // files first: one failure moved this file to position 1 and hid
        // itself on every subsequent local run.
        //
        // So do not assert the child's id at all — it is not a property of
        // isolation. Assert the two things that are: the child's schema
        // carries the isolation suffix (the override actually took effect),
        // and the parent's name family never does (so the two cannot collide,
        // by construction, whatever ordinals either side draws).
        expect(leakedSchema).toMatch(new RegExp(`^test_w\\d+${SESSION_SUFFIX}$`))
        expect(WORKER_SCHEMA.endsWith(SESSION_SUFFIX)).toBe(false)
      } finally {
        fs.rmSync(fixturePath, { force: true })
        // The fixture's drift is never restored by the fixture (that is the
        // point of the reproduction) — repair it here so it cannot poison a
        // later file on whichever worker the child landed in, the way #2616's
        // own reservoir did. UNCONDITIONAL: the earlier version repaired only
        // the schema it had parsed out of the child's message, so the run that
        // needed cleaning most — the one where the guard did NOT report, and
        // there was no message to parse — was the one it skipped.
        await dropFixtureLeak()
      }
    },
    60_000,
  )
})
