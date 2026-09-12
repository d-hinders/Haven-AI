/**
 * Real-Postgres proof for migration 081 (#2872, epic #2858): the
 * `fortnox_connections_retired` copy 080 left behind is gone, `up()` is
 * idempotent, `down()` restores 027's exact shape (and nothing else), and
 * `up()` drops it again. No mocks — #1219's rule.
 *
 * The harness applies the FULL migration set, so the post-081 state is the
 * baseline: the first test asserts the drop as production will see it. The
 * reverting tests call `down()` inside `withMigrationReverted` so a failing
 * assertion cannot leave the shared worker schema off head (#2616 / #2621).
 * `up()` is `DROP TABLE IF EXISTS`, so an `afterAll(up)` would be allowed —
 * but every reverting case already restores through the helper, and the
 * head assertion is the guard that catches a leak, so none is registered.
 *
 * MUTATION TARGET (run by hand for the #2872 report): make `up()` a no-op and
 * the FIRST test fails at head (the harness applies the mutated migration) and
 * the LAST test fails inside the restore (the table `down()` recreated is
 * still there).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../081_drop_fortnox_connections_retired.js'

const RETIRED = 'fortnox_connections_retired'

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function columns(table: string): Promise<Array<{ column_name: string; data_type: string; is_nullable: string }>> {
  const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [table],
  )
  return rows
}

async function withClient<T>(fn: (c: Awaited<ReturnType<typeof db.connect>>) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

describeDb('081_drop_fortnox_connections_retired (#2872)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // This file hand-drives up()/down(), which mutates SCHEMA. Fail HERE if the
  // schema is left off head rather than letting the next file inherit it.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered under its own version string', () => {
    expect(version).toBe('081_drop_fortnox_connections_retired')
  })

  it('at head: the retired table is gone and the live tables are untouched', async () => {
    expect(await tableExists(RETIRED)).toBe(false)
    expect(await tableExists('fortnox_connections')).toBe(false)
    expect(await tableExists('accounting_connections')).toBe(true)
    expect(await tableExists('accounting_feed_syncs')).toBe(true)
  })

  it('up() is idempotent — re-running against an already-dropped table does not error', async () => {
    await withClient(async (client) => {
      await up(client)
      await up(client)
    })
    expect(await tableExists(RETIRED)).toBe(false)
  })

  it("down() restores 027's exact shape, EMPTY, and up() drops it again", async () => {
    await withClient(async (client) => {
      await withMigrationReverted(
        () => down(client),
        async () => {
          expect(await tableExists(RETIRED)).toBe(true)
          expect(await columns(RETIRED)).toEqual([
            { column_name: 'access_token', data_type: 'text', is_nullable: 'NO' },
            { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
            { column_name: 'expires_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
            { column_name: 'refresh_token', data_type: 'text', is_nullable: 'NO' },
            { column_name: 'scope', data_type: 'text', is_nullable: 'YES' },
            { column_name: 'token_type', data_type: 'character varying', is_nullable: 'NO' },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
            { column_name: 'user_id', data_type: 'uuid', is_nullable: 'NO' },
          ])
          const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${RETIRED}`)
          expect(rows[0].n).toBe(0)
          // down() is idempotent too: a second run against the restored table is a no-op.
          await down(client)
          expect(await tableExists(RETIRED)).toBe(true)
        },
        () => up(client),
      )
    })
    // The restore step IS the drop under test.
    expect(await tableExists(RETIRED)).toBe(false)
  })
})
