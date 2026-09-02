/**
 * The orphaned-schema reap's safety predicate (#2418).
 *
 * The reap exists because a long-lived developer database accumulates
 * `test_w<N>` schemas from killed vitest runs, and every one of them inflates
 * `pg_class` — the floor of every WARM `resetDb()` (#2354). Dropping them is
 * only safe if "orphaned" is DECIDABLE, so these tests pin the three rules
 * that decide it (`schema-reap.ts`) from both sides: what must be dropped, and
 * what must survive.
 *
 * The live-run test drives a SECOND connection deliberately. A session
 * advisory lock is invisible to `pg_try_advisory_lock` from the session that
 * already holds it — it simply re-acquires and reports success — so a
 * single-connection version of this test would pass against a reap with no
 * lock check at all. The second connection is what makes the assertion able to
 * fail, and it is what the mutation run proves.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Client } from 'pg'

import { resolveTestDatabaseUrl } from '../db-availability.js'
// `describeDb` only — this file deliberately does not use the harness's
// schema, so it never races the run's own workers.
import { describeDb } from '../db-harness.js'
import {
  claimRetainedWorkerIds,
  planSchemaReap,
  reapOrphanWorkerSchemas,
  retainedWorkerIdCeiling,
  SCHEMA_OWNER_LOCK_NAMESPACE,
} from '../schema-reap.js'

/**
 * Ids far above any retention ceiling and disjoint per worker, so this file is
 * safe to run in parallel with itself and can never collide with an id a real
 * vitest run would be handed.
 */
const BASE_ID = 900_000 + Number(process.env.VITEST_WORKER_ID ?? '0') * 10
const ORPHAN_ID = BASE_ID
const LIVE_ID = BASE_ID + 1
const ORPHAN_SCHEMA = `test_w${ORPHAN_ID}`
const LIVE_SCHEMA = `test_w${LIVE_ID}`
/** Below our ids, so only OUR fixtures are ever candidates in this file. */
const CEILING = BASE_ID - 1

async function connect(): Promise<Client> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: resolveTestDatabaseUrl() })
  await client.connect()
  return client
}

async function schemaExists(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [name])
  return rows.length > 0
}

describeDb('orphaned worker-schema reap (#2418)', () => {
  let reaper: Client
  let sibling: Client

  beforeAll(async () => {
    reaper = await connect()
    sibling = await connect()
  })

  afterAll(async () => {
    for (const name of [ORPHAN_SCHEMA, LIVE_SCHEMA]) {
      await reaper.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {})
    }
    await sibling.end().catch(() => {})
    await reaper.end().catch(() => {})
  })

  it('drops an unlocked orphan and leaves a LIVE run alone', async () => {
    await reaper.query(`CREATE SCHEMA IF NOT EXISTS ${ORPHAN_SCHEMA}`)
    await reaper.query(`CREATE SCHEMA IF NOT EXISTS ${LIVE_SCHEMA}`)
    // A live run: a DIFFERENT session holds the ownership lock, exactly as
    // global setup does for the whole of its run.
    const held = await sibling.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [SCHEMA_OWNER_LOCK_NAMESPACE, LIVE_ID],
    )
    expect(held.rows[0].locked).toBe(true)

    try {
      const dropped = await reapOrphanWorkerSchemas(reaper, { retainCeiling: CEILING })

      expect(dropped).toContain(ORPHAN_SCHEMA)
      expect(dropped).not.toContain(LIVE_SCHEMA)
      expect(await schemaExists(reaper, ORPHAN_SCHEMA)).toBe(false)
      expect(await schemaExists(reaper, LIVE_SCHEMA)).toBe(true)
    } finally {
      await sibling.query('SELECT pg_advisory_unlock($1, $2)', [
        SCHEMA_OWNER_LOCK_NAMESPACE,
        LIVE_ID,
      ])
    }
  })

  it('retains ids at or below the ceiling even when they are unlocked', async () => {
    await reaper.query(`CREATE SCHEMA IF NOT EXISTS ${ORPHAN_SCHEMA}`)
    // Nobody holds ORPHAN_ID's lock; only the ceiling protects it here. This
    // is the rule that stops the reap destroying the warm-reuse the harness
    // depends on.
    const dropped = await reapOrphanWorkerSchemas(reaper, { retainCeiling: ORPHAN_ID })
    expect(dropped).not.toContain(ORPHAN_SCHEMA)
    expect(await schemaExists(reaper, ORPHAN_SCHEMA)).toBe(true)
  })

  it('leaves the application schema and every live worker schema untouched', async () => {
    const before = await reaper.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname !~ '^test_w[0-9]+$'",
    )
    await reapOrphanWorkerSchemas(reaper, { retainCeiling: CEILING })
    const after = await reaper.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname !~ '^test_w[0-9]+$'",
    )
    expect(after.rows.map((r) => r.nspname).sort()).toEqual(
      before.rows.map((r) => r.nspname).sort(),
    )
    expect(await schemaExists(reaper, 'public')).toBe(true)
  })

  it('is a no-op that drops nothing when there is no orphan', async () => {
    await reaper.query(`DROP SCHEMA IF EXISTS ${ORPHAN_SCHEMA} CASCADE`)
    await reaper.query(`DROP SCHEMA IF EXISTS ${LIVE_SCHEMA} CASCADE`)
    expect(await reapOrphanWorkerSchemas(reaper, { retainCeiling: CEILING })).toEqual([])
  })

  it('releases the lock it took, so the id is reusable by a later run', async () => {
    await reaper.query(`CREATE SCHEMA IF NOT EXISTS ${ORPHAN_SCHEMA}`)
    expect(await reapOrphanWorkerSchemas(reaper, { retainCeiling: CEILING })).toContain(
      ORPHAN_SCHEMA,
    )
    const reacquired = await sibling.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [SCHEMA_OWNER_LOCK_NAMESPACE, ORPHAN_ID],
    )
    expect(reacquired.rows[0].locked).toBe(true)
    await sibling.query('SELECT pg_advisory_unlock($1, $2)', [
      SCHEMA_OWNER_LOCK_NAMESPACE,
      ORPHAN_ID,
    ])
  })

  it('stops at its budget instead of draining an unbounded backlog', async () => {
    await reaper.query(`CREATE SCHEMA IF NOT EXISTS ${ORPHAN_SCHEMA}`)
    const dropped = await reapOrphanWorkerSchemas(reaper, {
      retainCeiling: CEILING,
      budgetMs: 0,
    })
    expect(dropped).toEqual([])
    expect(await schemaExists(reaper, ORPHAN_SCHEMA)).toBe(true)
  })

  it('claims a contiguous id range, and a concurrent run finds it taken', async () => {
    // Ids in THIS file's private band: the ids a real run claims (0..ceiling)
    // are already held by this very run's global setup, which is the
    // behaviour under test and therefore the last thing to assert against.
    const ids = [BASE_ID + 5, BASE_ID + 6, BASE_ID + 7]
    const claim = async (client: Client): Promise<number[]> => {
      const got: number[] = []
      for (const id of ids) {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS locked',
          [SCHEMA_OWNER_LOCK_NAMESPACE, id],
        )
        if (rows[0].locked) got.push(id)
      }
      return got
    }
    // `sibling` plays the concurrent run that got there first.
    const claimed = await claim(sibling)
    try {
      expect(claimed).toEqual(ids)
      // The second run finds them taken and simply shares the schema, exactly
      // as two concurrent runs did before #2418. Nothing fails.
      expect(await claim(reaper)).toEqual([])
    } finally {
      for (const id of claimed) {
        await sibling.query('SELECT pg_advisory_unlock($1, $2)', [
          SCHEMA_OWNER_LOCK_NAMESPACE,
          id,
        ])
      }
    }
  })

  it('claimRetainedWorkerIds covers every id from 0 to the ceiling INCLUSIVE', async () => {
    // Probed with a RAW lock attempt, not by calling the function again: the
    // run's own global setup already claimed 0..ceiling, so if this asserted
    // via `claimRetainedWorkerIds` the same off-by-one would be present on
    // both sides and cancel out (it did — mutation m6 survived that form).
    // `test_w0` is a real schema whenever VITEST_WORKER_ID is unset, so id 0
    // is load-bearing rather than a boundary curiosity.
    for (const id of [0, 1, retainedWorkerIdCeiling()]) {
      const { rows } = await reaper.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [SCHEMA_OWNER_LOCK_NAMESPACE, id],
      )
      if (rows[0].locked) {
        await reaper.query('SELECT pg_advisory_unlock($1, $2)', [SCHEMA_OWNER_LOCK_NAMESPACE, id])
      }
      expect({ id, claimedByThisRun: rows[0].locked }).toEqual({ id, claimedByThisRun: false })
    }
  })
})

// The pure rules — provable without a database.
it('plans only test_w<N> names above the ceiling', () => {
  expect(
    planSchemaReap(
      ['public', 'test_w1', 'test_w30', 'test_w7', 'information_schema', 'test_wx', 'my_test_w40'],
      10,
    ),
  ).toEqual([{ schema: 'test_w30', workerId: 30 }])
})

it('retains at least a full pool of worker ids', () => {
  // A ceiling below the machine's parallelism would reap ids a run is using.
  expect(retainedWorkerIdCeiling()).toBeGreaterThanOrEqual(16)
})

it('raises the ceiling above an overridden vitest maxWorkers', () => {
  // haven-reviewer's should-fix: a run started with `--maxWorkers=64` assigns
  // ids far above any CPU-derived ceiling. If the ceiling ignored the
  // override, that run would never CLAIM the ids its own workers go on to
  // use, and a concurrent sibling — ceiling also CPU-derived — would find
  // those live schemas above its ceiling and unlocked, and drop them.
  expect(retainedWorkerIdCeiling(64)).toBeGreaterThanOrEqual(128)
  expect(retainedWorkerIdCeiling(64)).toBeGreaterThan(retainedWorkerIdCeiling())
})

it('never LOWERS the ceiling for a small or malformed maxWorkers', () => {
  // The override is a floor to raise to, never a cap to shrink to: a run
  // pinned to one worker still shares the database with runs that are not.
  const base = retainedWorkerIdCeiling()
  for (const configured of [1, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect({ configured, ceiling: retainedWorkerIdCeiling(configured) }).toEqual({
      configured,
      ceiling: base,
    })
  }
  // vitest also accepts a percentage string; anything non-numeric is ignored
  // rather than guessed at.
  expect(retainedWorkerIdCeiling(Number('50%'))).toBe(base)
})
