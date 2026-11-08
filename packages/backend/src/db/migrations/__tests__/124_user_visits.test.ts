/**
 * Real-Postgres proof for migration 124 — the "Since your last visit" marker
 * on `users` (#4709, epic #4701 decision 4). No mocks — #1219's rule.
 *
 * Pins:
 *   - the three columns exist at head, all NULLABLE, all `timestamp with time
 *     zone` (the entry id is `uuid`), with no default — a NULL marker is the
 *     honest state for every existing account;
 *   - `down()` removes every one of them and `up()` restores them;
 *   - the schema is at head after the cycle.
 *
 * The marker's BEHAVIOUR (retry safety, consecutive windows, the boundary
 * rule) is proven against real Postgres in
 * `infra/repositories/__tests__/user-visits.db.test.ts`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../124_user_visits.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

const columns = () =>
  db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users'
        AND column_name IN ('visit_current_at', 'visit_previous_at', 'visit_entry_id')
      ORDER BY column_name`,
  )

describeDb('migration 124 — users visit marker (#4709)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // Re-apply THIS source over the worker schema, so every case below tests
    // the migration as written now — not a schema an earlier run left behind.
    await resetDb()
    try {
      await run(down)
    } finally {
      await run(up)
    }
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered as version 124_user_visits', () => {
    expect(version).toBe('124_user_visits')
  })

  it('the schema is at head with three nullable, defaultless columns', async () => {
    await assertWorkerSchemaAtHead()
    expect((await columns()).rows).toEqual([
      {
        column_name: 'visit_current_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'visit_entry_id',
        data_type: 'uuid',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'visit_previous_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
    ])
  })

  it('down() removes every column; up() restores them', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await columns()).rows).toEqual([])
      },
      () => run(up),
    )
    expect((await columns()).rows).toHaveLength(3)
  })

  it('an existing account keeps a NULL marker — no backfill, no default', async () => {
    const { rows } = await db.query<{
      visit_current_at: Date | null
      visit_previous_at: Date | null
      visit_entry_id: string | null
    }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x')
       RETURNING visit_current_at, visit_previous_at, visit_entry_id`,
      [`visit-124-${Date.now()}@test.example`],
    )
    expect(rows[0]).toEqual({
      visit_current_at: null,
      visit_previous_at: null,
      visit_entry_id: null,
    })
  })
})
