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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import db from '../../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness } from '../db-harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
          /different column\/index shape.*agents/s,
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
        await expect(assertWorkerSchemaAtHead()).rejects.toThrow(
          /different column\/index shape.*agents/s,
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
import db from '../../../../db.js'
import { describeDb, initDbHarness } from '../db-harness.js'

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
    await db.query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS __scratch_2625_fixture_leak text')
  })

  afterAll(() => {
    throw new Error('MARKER_SIMULATED_THROW')
  })
})
`

describeDb('the guard fires even when a sibling afterAll throws (#2625)', () => {
  it(
    "reports the drift purely from importing db-harness.js — no call site opts in, and the sibling's throw does not suppress it",
    async () => {
      const fixturePath = path.join(__dirname, `hook-order-2625.${process.pid}.fixture.test.ts`)
      fs.writeFileSync(fixturePath, FIXTURE_SOURCE)
      let leakedSchema: string | null = null
      try {
        const result = spawnSync(
          'npx',
          ['vitest', 'run', fixturePath, '--reporter=basic', '--no-file-parallelism'],
          { cwd: process.cwd(), encoding: 'utf-8' },
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
        const attribution = output.match(/this file left (test_w\d+) off migration head/)
        expect(attribution).not.toBeNull()
        leakedSchema = attribution?.[1] ?? null
        expect(output).toContain('different column/index shape: agents')
      } finally {
        fs.rmSync(fixturePath, { force: true })
        // The fixture's drift was never restored (that is the point of the
        // reproduction) — repair it here so it cannot poison a later file on
        // whichever worker the child landed in, the way #2616's own
        // reservoir did. Fully qualified because the child's worker schema
        // is not necessarily this file's own.
        if (leakedSchema) {
          await db.query(
            `ALTER TABLE ${leakedSchema}.agents DROP COLUMN IF EXISTS __scratch_2625_fixture_leak`,
          )
        }
      }
    },
    60_000,
  )
})
