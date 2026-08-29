/**
 * Real-Postgres proof for the migration runner's transactional opt-out
 * (#2150). No mocks, deliberately and non-negotiably: the entire subject of
 * this change is what POSTGRES does with a transaction block. A fake `pg`
 * client cannot raise SQLSTATE `25001`, cannot leave an INVALID index behind,
 * and cannot fail to roll back — every assertion here would pass against a
 * mock that had none of the behaviour under test. #1219's rule, in its
 * sharpest form.
 *
 * Fixture migrations, not real ones: the runner takes its migration list as a
 * parameter for exactly this reason, so proving a RUNNER feature does not cost
 * `db/migrations/` a permanent migration whose only job was to demonstrate it.
 * The fixtures also do things no real migration may — fail halfway on purpose,
 * build a unique index over duplicate rows — which is the point.
 *
 * The load-bearing pair is `CONCURRENTLY succeeds …` and its twin
 * `… still fails when the same migration stays transactional`. Together they
 * prove the opt-out is what does the work, on the exact statement and the
 * exact SQLSTATE that blocked PR #2149.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { runMigrations } from '../migrate.js'
import type { Migration } from '../migrations/index.js'
import {
  createIndexConcurrently,
  dropIndexConcurrently,
  indexIsValid,
} from '../concurrent-index.js'

const FIXTURE_PREFIX = 'fixture_2150_'

/**
 * A `CONCURRENTLY` build waits for every transaction in the DATABASE that
 * could see the table to finish — that is what buys the lock-free build. With
 * parallel vitest workers there are always some, so these bodies are given
 * room rather than being left on the 5 s default to flake under load. Observed
 * once at ~47 s on a contended run; fast (<0.5 s) on a quiet one.
 */
const CONCURRENT_BUILD_TIMEOUT_MS = 90_000

/** Rows this file writes into the runner's real bookkeeping table. */
async function bookkeeping(version: string): Promise<{ status: string } | undefined> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM schema_migrations WHERE version = $1`,
    [version],
  )
  return rows[0]
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

/** The error the runner throws is wrapped; the driver's SQLSTATE is on the cause. */
function sqlstateOf(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur; i += 1) {
    const code = (cur as { code?: string }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

describeDb('migration runner: the transactional opt-out (#2150)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    await cleanUpFixtures()
  })

  afterEach(async () => {
    await cleanUpFixtures()
  })

  async function cleanUpFixtures(): Promise<void> {
    await db.query(`DELETE FROM schema_migrations WHERE version LIKE $1`, [`${FIXTURE_PREFIX}%`])
    await db.query(`DROP TABLE IF EXISTS ${FIXTURE_PREFIX}widgets CASCADE`)
    await db.query(`DROP INDEX IF EXISTS ${FIXTURE_PREFIX}idx`)
  }

  /** A plain table for the index fixtures to build on. */
  async function seedWidgets(rows: number[]): Promise<void> {
    await db.query(`CREATE TABLE IF NOT EXISTS ${FIXTURE_PREFIX}widgets (n INTEGER)`)
    for (const n of rows) {
      await db.query(`INSERT INTO ${FIXTURE_PREFIX}widgets (n) VALUES ($1)`, [n])
    }
  }

  const CONCURRENT_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${FIXTURE_PREFIX}idx ON ${FIXTURE_PREFIX}widgets (n)`

  // ── The reason this feature exists. ──────────────────────────────────────

  it('CONCURRENTLY succeeds from a migration that declares transactional = false', async () => {
    await seedWidgets([1, 2, 3])
    const version = `${FIXTURE_PREFIX}concurrently`
    const migration: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
      up: async (client: PoolClient) => {
        await client.query(CONCURRENT_INDEX_SQL)
      },
    }

    await runMigrations([migration])

    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBe(true)
    expect(await bookkeeping(version)).toEqual({ status: 'applied' })
  }, CONCURRENT_BUILD_TIMEOUT_MS)

  it('… and the SAME migration still fails with SQLSTATE 25001 when it stays transactional', async () => {
    // The negative half of the pair. If this ever goes green, the opt-out is
    // not what made the test above pass and this whole change is theatre.
    await seedWidgets([1, 2, 3])
    const version = `${FIXTURE_PREFIX}concurrently_in_tx`
    const migration: Migration = {
      version,
      up: async (client: PoolClient) => {
        await client.query(CONCURRENT_INDEX_SQL)
      },
    }

    const err = await runMigrations([migration]).catch((e: unknown) => e)

    expect(sqlstateOf(err)).toBe('25001')
    expect((err as Error).message).toContain('cannot run inside a transaction block')
    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBeNull()
    expect(await bookkeeping(version)).toBeUndefined()
  }, CONCURRENT_BUILD_TIMEOUT_MS)

  // ── The negative proof: the default lane is untouched. ────────────────────

  it('a transactional migration still runs inside a transaction and rolls its work back', async () => {
    const version = `${FIXTURE_PREFIX}rollback`
    const migration: Migration = {
      version,
      up: async (client: PoolClient) => {
        await client.query(`CREATE TABLE ${FIXTURE_PREFIX}widgets (n INTEGER)`)
        throw new Error('deliberate failure after the DDL')
      },
    }

    await expect(runMigrations([migration])).rejects.toThrow('deliberate failure after the DDL')

    // Both halves rolled back together — this is the guarantee the opt-out
    // gives up, and the one every other migration in the repo still has.
    expect(await tableExists(`${FIXTURE_PREFIX}widgets`)).toBe(false)
    expect(await bookkeeping(version)).toBeUndefined()
  })

  it('positive control: the same transactional migration without the throw commits both halves', async () => {
    // Without this, a runner that refused EVERY migration would pass the test
    // above.
    const version = `${FIXTURE_PREFIX}commit`
    const migration: Migration = {
      version,
      up: async (client: PoolClient) => {
        await client.query(`CREATE TABLE ${FIXTURE_PREFIX}widgets (n INTEGER)`)
      },
    }

    await runMigrations([migration])

    expect(await tableExists(`${FIXTURE_PREFIX}widgets`)).toBe(true)
    expect(await bookkeeping(version)).toEqual({ status: 'applied' })
  })

  // ── What a partial non-transactional failure leaves behind. ───────────────

  it('a non-transactional failure is NOT rolled back, and leaves a detectable running row', async () => {
    const version = `${FIXTURE_PREFIX}partial`
    const migration: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'fixture: proves the partial-failure state',
      up: async (client: PoolClient) => {
        await client.query(`CREATE TABLE ${FIXTURE_PREFIX}widgets (n INTEGER)`)
        throw new Error('deliberate failure after the DDL')
      },
    }

    await expect(runMigrations([migration])).rejects.toThrow('deliberate failure after the DDL')

    // The half-applied schema survives — stated as an assertion rather than a
    // caveat, because it is the cost of the feature.
    expect(await tableExists(`${FIXTURE_PREFIX}widgets`)).toBe(true)
    // And it is DETECTABLE: the row says running, not applied and not absent.
    expect(await bookkeeping(version)).toEqual({ status: 'running' })
  })

  it('the next boot REFUSES rather than retrying a half-applied migration', async () => {
    const version = `${FIXTURE_PREFIX}partial`
    const failing: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'fixture: proves the partial-failure state',
      up: async (client: PoolClient) => {
        await client.query(`CREATE TABLE ${FIXTURE_PREFIX}widgets (n INTEGER)`)
        throw new Error('deliberate failure after the DDL')
      },
    }
    await expect(runMigrations([failing])).rejects.toThrow()

    // Second boot. A blind retry would re-run the CREATE TABLE and fail with a
    // confusing 42P07; a runner that trusted the row would skip a migration
    // that never finished. It does neither.
    let ranAgain = false
    const onReboot: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'fixture: proves the partial-failure state',
      up: async () => {
        ranAgain = true
      },
    }
    const err = await runMigrations([onReboot]).catch((e: unknown) => e)

    expect(ranAgain).toBe(false)
    const message = (err as Error).message
    expect(message).toContain('was left INCOMPLETE by an earlier run')
    expect(message).toContain('fixture: proves the partial-failure state')
    expect(message).toContain(`UPDATE schema_migrations SET status = 'applied'`)
    expect(message).toContain(`DELETE FROM schema_migrations WHERE version = '${version}'`)
  })

  it('the documented operator recovery actually recovers', async () => {
    const version = `${FIXTURE_PREFIX}partial`
    const failing: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'fixture: proves the partial-failure state',
      up: async (client: PoolClient) => {
        await client.query(`CREATE TABLE ${FIXTURE_PREFIX}widgets (n INTEGER)`)
        throw new Error('deliberate failure after the DDL')
      },
    }
    await expect(runMigrations([failing])).rejects.toThrow()

    // Step 2b, verbatim from the message: undo the effects, delete the row.
    await db.query(`DROP TABLE ${FIXTURE_PREFIX}widgets`)
    await db.query(`DELETE FROM schema_migrations WHERE version = $1`, [version])

    const fixed: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'fixture: proves the partial-failure state',
      up: async (client: PoolClient) => {
        await client.query(`CREATE TABLE ${FIXTURE_PREFIX}widgets (n INTEGER)`)
      },
    }
    await runMigrations([fixed])

    expect(await tableExists(`${FIXTURE_PREFIX}widgets`)).toBe(true)
    expect(await bookkeeping(version)).toEqual({ status: 'applied' })
  })

  it('a completed non-transactional migration is not re-run on the next boot', async () => {
    await seedWidgets([1, 2])
    const version = `${FIXTURE_PREFIX}once`
    let runs = 0
    const migration: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'fixture: idempotency of the applied check',
      up: async (client: PoolClient) => {
        runs += 1
        await client.query(CONCURRENT_INDEX_SQL)
      },
    }

    await runMigrations([migration])
    await runMigrations([migration])

    expect(runs).toBe(1)
  }, CONCURRENT_BUILD_TIMEOUT_MS)

  // ── Two replicas reaching the same new migration at once. ────────────────

  it('two concurrent boots run it ONCE, and the loser returns cleanly', async () => {
    // The branch the advisory lock exists for, and the only one the runner's
    // three-way decision cannot reach sequentially: the loser re-reads the row
    // INSIDE the lock and must see `applied` and skip. If it instead read a
    // `running` row it would diagnose a crashed partial and refuse — turning
    // every multi-replica deploy carrying a non-transactional migration into a
    // crashloop on all but one replica.
    //
    // Both calls are started before either can finish (the sleep in `up()`
    // guarantees the second reaches the lock while the first still holds it),
    // so this races the real code rather than simulating a race.
    await seedWidgets([1, 2, 3])
    const version = `${FIXTURE_PREFIX}concurrent`
    let runs = 0
    const migration: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'fixture: proves the concurrent-boot branch',
      up: async (client: PoolClient) => {
        runs += 1
        await new Promise((resolve) => setTimeout(resolve, 300))
        await client.query(CONCURRENT_INDEX_SQL)
      },
    }

    const results = await Promise.allSettled([
      runMigrations([migration]),
      runMigrations([migration]),
    ])

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(runs).toBe(1)
    expect(await bookkeeping(version)).toEqual({ status: 'applied' })
    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBe(true)
  }, CONCURRENT_BUILD_TIMEOUT_MS)

  // ── The INVALID index a failed CONCURRENTLY build leaves behind. ──────────

  it('a failed CONCURRENTLY build leaves an INVALID index, and the helper heals it', async () => {
    // Produce a real one rather than asserting about a hypothetical: a UNIQUE
    // index over duplicate rows fails in the second pass and leaves the index
    // in place with indisvalid = false.
    await seedWidgets([7, 7])
    const version = `${FIXTURE_PREFIX}invalid`
    const migration: Migration = {
      version,
      transactional: false,
      nonTransactionalReason: 'CREATE UNIQUE INDEX CONCURRENTLY',
      up: async (client: PoolClient) => {
        await createIndexConcurrently(client, {
          name: `${FIXTURE_PREFIX}idx`,
          definition: `ON ${FIXTURE_PREFIX}widgets (n)`,
          unique: true,
        })
      },
    }

    await expect(runMigrations([migration])).rejects.toThrow()

    // The exact hazard, demonstrated: the index exists and is unusable.
    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBe(false)
    expect(await bookkeeping(version)).toEqual({ status: 'running' })

    // Operator recovery, then a retry. A bare `CREATE INDEX CONCURRENTLY IF
    // NOT EXISTS` would see the name taken and report success over the dud;
    // the helper drops it first, so the retry produces a VALID index.
    await db.query(`DELETE FROM ${FIXTURE_PREFIX}widgets WHERE ctid NOT IN
      (SELECT MIN(ctid) FROM ${FIXTURE_PREFIX}widgets GROUP BY n)`)
    await db.query(`DELETE FROM schema_migrations WHERE version = $1`, [version])

    await runMigrations([migration])

    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBe(true)
    expect(await bookkeeping(version)).toEqual({ status: 'applied' })
  }, CONCURRENT_BUILD_TIMEOUT_MS)

  it('a bare IF NOT EXISTS retry silently keeps the dud — which is why the helper drops first', async () => {
    // The hazard, demonstrated rather than asserted. This is the failure the
    // drop-if-invalid step exists for, and it is invisible: the retry reports
    // success and the planner never uses the index again.
    await seedWidgets([7, 7])
    const invalidBuild = await db
      .query(
        `CREATE UNIQUE INDEX CONCURRENTLY ${FIXTURE_PREFIX}idx ON ${FIXTURE_PREFIX}widgets (n)`,
      )
      .catch((e: unknown) => e)
    expect(sqlstateOf(invalidBuild)).toBe('23505')
    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBe(false)

    // Fix the data, then retry the naive way. It "succeeds".
    await db.query(`DELETE FROM ${FIXTURE_PREFIX}widgets WHERE ctid NOT IN
      (SELECT MIN(ctid) FROM ${FIXTURE_PREFIX}widgets GROUP BY n)`)
    await db.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${FIXTURE_PREFIX}idx ON ${FIXTURE_PREFIX}widgets (n)`,
    )
    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBe(false)

    // The helper, on the identical state, produces a usable index.
    const client = await db.connect()
    try {
      await createIndexConcurrently(client, {
        name: `${FIXTURE_PREFIX}idx`,
        definition: `ON ${FIXTURE_PREFIX}widgets (n)`,
        unique: true,
      })
    } finally {
      client.release()
    }
    expect(await indexIsValid(db as never, `${FIXTURE_PREFIX}idx`)).toBe(true)
  }, CONCURRENT_BUILD_TIMEOUT_MS)

  it('dropIndexConcurrently removes an index and is safe to repeat', async () => {
    // The `down()` counterpart. Exercised directly because no migration uses
    // the opt-out yet, and an untested destructive helper is worse than none.
    await seedWidgets([1, 2])
    const client = await db.connect()
    try {
      await createIndexConcurrently(client, {
        name: `${FIXTURE_PREFIX}idx`,
        definition: `ON ${FIXTURE_PREFIX}widgets (n)`,
      })
      expect(await indexIsValid(client, `${FIXTURE_PREFIX}idx`)).toBe(true)

      await dropIndexConcurrently(client, `${FIXTURE_PREFIX}idx`)
      expect(await indexIsValid(client, `${FIXTURE_PREFIX}idx`)).toBeNull()

      // IF EXISTS — a non-transactional down() must survive its own retry.
      await dropIndexConcurrently(client, `${FIXTURE_PREFIX}idx`)
      expect(await indexIsValid(client, `${FIXTURE_PREFIX}idx`)).toBeNull()

      await expect(dropIndexConcurrently(client, 'widgets"; DROP TABLE x --')).rejects.toThrow(
        'unsafe index name',
      )
    } finally {
      client.release()
    }
  }, CONCURRENT_BUILD_TIMEOUT_MS)

  it('two concurrent boots ADD the status column exactly once', async () => {
    // The bootstrap's own race. Both callers find the column missing, so both
    // attempt the ALTER — the path `ensureStatusColumn` exists to survive. The
    // loser must come back with the column present and no error, not with a
    // failed boot.
    const legacy = `${FIXTURE_PREFIX}legacy_race`
    await db.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [legacy])
    await db.query(`ALTER TABLE schema_migrations DROP COLUMN status`)

    const results = await Promise.allSettled([runMigrations([]), runMigrations([])])

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_attribute
       WHERE attrelid = to_regclass('schema_migrations')
         AND attname = 'status' AND NOT attisdropped`,
    )
    expect(rows[0].n).toBe('1')
    // And the row that predated the column is applied, not incomplete.
    expect(await bookkeeping(legacy)).toEqual({ status: 'applied' })
  })

  // ── Legacy bookkeeping rows. ─────────────────────────────────────────────

  it('rows written before the status column are treated as applied, not as incomplete', async () => {
    // Every production database predates #2150. If the added column read as
    // "incomplete" for existing rows, every backend on earth would refuse to
    // boot — so this asserts the ADD COLUMN default really does the backfill.
    const version = `${FIXTURE_PREFIX}legacy`
    await db.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version])
    expect(await bookkeeping(version)).toEqual({ status: 'applied' })

    let ran = false
    await runMigrations([
      {
        version,
        up: async () => {
          ran = true
        },
      },
    ])
    expect(ran).toBe(false)
  })
})
