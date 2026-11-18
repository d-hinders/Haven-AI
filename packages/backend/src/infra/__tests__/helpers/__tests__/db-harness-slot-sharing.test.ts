/**
 * Worker schemas are per pool SLOT, and a file on a reused slot still starts
 * empty (#4971).
 *
 * `workerSchemaName()` used to key on `VITEST_WORKER_ID`, which under vitest 3
 * is the FILE's ordinal: every real-DB file got a never-used schema and paid a
 * full migration run of its own, serialised across workers on advisory lock
 * 811000061 — ~230 runs per CI `Backend checks` job, 141-309 s of strictly
 * serial time, measured on 2026-11-18 when that job hit its 12-minute ceiling.
 * It now keys on `VITEST_POOL_ID`, so the files one slot runs in sequence share
 * one schema and only the first pays the migration run.
 *
 * Sharing is only safe because `ensureMigrated()` empties the rows the previous
 * file on the slot left, once per file. This test pins both halves, in one
 * child `vitest run` of two fixture files on ONE worker
 * (`--no-file-parallelism`, so both files run on pool slot 1):
 *
 * - each file prints the schema it is bound to, and the two must be the SAME
 *   name — this fails if the key goes back to the per-file ordinal (the files
 *   would land in `test_w1…` and `test_w2…`);
 * - each file counts the rows in a table BEFORE inserting one of its own, and
 *   both counts must be zero — whichever file runs second sees the first
 *   file's row unless the init-time emptying removed it, so this fails if that
 *   emptying is removed. The check is symmetric, so it does not depend on
 *   which file vitest's sequencer puts first.
 *
 * The child gets its own `HAVEN_TEST_SCHEMA_SUFFIX` so it never touches a
 * schema the parent run is using (the #2625 rule; see
 * `db-harness-schema-guard.test.ts`), and its fixtures live in `.tmp-fixtures/`
 * for the reasons given there: outside `src/` (five suites walk that tree) and
 * excluded from ordinary collection, lifted only by `vitest.fixture.config.ts`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { describeDb } from '../db-harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const FIXTURE_DIR = path.join(PACKAGE_ROOT, '.tmp-fixtures')

/**
 * Fixed within a checkout, distinct between checkouts — the same trade-off as
 * `db-harness-schema-guard.test.ts`'s `SESSION_SUFFIX`: a per-run name would
 * pay a cold migration run and strand a schema every run, one global name
 * would collide with a concurrent session on another checkout.
 */
const SUFFIX = `_slot4971_${createHash('sha256').update(PACKAGE_ROOT).digest('hex').slice(0, 8)}`

/** The child's marker table: no foreign keys, three required columns. */
const fixtureSource = (label: string) => `
import { beforeAll, it } from 'vitest'
import db from '../src/db.js'
import { WORKER_SCHEMA, describeDb, initDbHarness } from '../src/infra/__tests__/helpers/db-harness.js'

describeDb('slot-sharing fixture ${label}', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  it('reports its schema and the rows it inherited, then leaves one behind', async () => {
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rate_limit_counters')
    console.log('SLOT4971 ${label} schema=' + WORKER_SCHEMA + ' inherited=' + rows[0].n)
    await db.query(
      "INSERT INTO rate_limit_counters (key, count, expires_at) VALUES ($1, 1, now() + interval '1 hour')",
      // Unique per run: an earlier run's row must surface as a non-zero
      // count above, never as a duplicate-key error that fails for another reason.
      ['slot4971-${label}-' + process.pid + '-' + Date.now()],
    )
  })
})
`

describeDb('worker schemas are shared per pool slot and emptied per file (#4971)', () => {
  it(
    'two files on one worker share one schema, and the second starts with none of the first file\'s rows',
    () => {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true })
      const files = ['a', 'b'].map((label) => {
        const file = path.join(FIXTURE_DIR, `slot-sharing-4971-${label}.${process.pid}.fixture.test.ts`)
        fs.writeFileSync(file, fixtureSource(label))
        return file
      })
      try {
        const result = spawnSync(
          'npx',
          [
            'vitest',
            'run',
            ...files,
            '--reporter=basic',
            // ONE worker: both files run on pool slot 1, one after the other.
            '--no-file-parallelism',
            '--config',
            'vitest.fixture.config.ts',
          ],
          {
            cwd: PACKAGE_ROOT,
            encoding: 'utf-8',
            env: { ...process.env, HAVEN_TEST_SCHEMA_SUFFIX: SUFFIX },
          },
        )
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        expect(result.status, output).toBe(0)

        const reports = [...output.matchAll(/SLOT4971 (a|b) schema=(\S+) inherited=(\d+)/g)].map(
          ([, label, schema, inherited]) => ({ label, schema, inherited: Number(inherited) }),
        )
        // Positive control: both fixtures actually ran and reported.
        expect(reports.map((r) => r.label).sort()).toEqual(['a', 'b'])
        // Shared: the second file reused the first file's schema.
        expect(new Set(reports.map((r) => r.schema)).size, output).toBe(1)
        expect(reports[0].schema).toMatch(new RegExp(`^test_w\\d+${SUFFIX}$`))
        // Emptied: neither file saw the other's row.
        expect(reports.map((r) => r.inherited), output).toEqual([0, 0])
      } finally {
        for (const file of files) fs.rmSync(file, { force: true })
      }
    },
    120_000,
  )
})
