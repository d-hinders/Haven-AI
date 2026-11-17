/**
 * Real-Postgres proof for migration 126 — merchant services (#4895, epic
 * #4885). No mocks — #1219's rule.
 *
 * Pins:
 *   - `smart_accounts.is_merchant_account` exists at head, NOT NULL, boolean,
 *     defaulting to false (the honest state for every pre-existing account);
 *   - `smart_accounts_one_merchant_per_user` is a UNIQUE index on `(user_id)`
 *     with the PARTIAL predicate `WHERE is_merchant_account` — the database
 *     invariant behind "one merchant account per user";
 *   - `merchant_service_settings` exists with its five columns;
 *   - `down()` removes all three objects and `up()` restores them;
 *   - the schema is at head after the cycle.
 *
 * The marker's BEHAVIOUR (the index refusing a second merchant account, the
 * setting and marker committing with the account) is proven against real
 * Postgres in `routes/__tests__/merchant-services.db.test.ts`.
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
import { down, up, version } from '../126_merchant_services.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

const markerColumn = () =>
  db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'smart_accounts'
        AND column_name = 'is_merchant_account'`,
  )

const merchantIndex = () =>
  db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'smart_accounts'
        AND indexname = 'smart_accounts_one_merchant_per_user'`,
  )

const settingColumns = () =>
  db.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'merchant_service_settings'
      ORDER BY column_name`,
  )

describeDb('migration 126 — merchant services (#4895)', () => {
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

  it('is registered as version 126_merchant_services', () => {
    expect(version).toBe('126_merchant_services')
  })

  it('the schema is at head with the marker column NOT NULL, boolean, default false', async () => {
    await assertWorkerSchemaAtHead()
    expect((await markerColumn()).rows).toEqual([
      {
        column_name: 'is_merchant_account',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      },
    ])
  })

  it('the one-merchant-per-user index is UNIQUE on (user_id) and PARTIAL on the marker', async () => {
    const { rows } = await merchantIndex()
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i)
    expect(rows[0].indexdef).toMatch(/\(user_id\)/)
    expect(rows[0].indexdef).toMatch(/WHERE is_merchant_account/i)
  })

  it('the setting table carries the five columns', async () => {
    expect((await settingColumns()).rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'disabled_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'enabled', data_type: 'boolean', is_nullable: 'NO' },
      { column_name: 'enabled_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: 'NO' },
    ])
  })

  it('down() removes the column, the index and the table; up() restores them', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await markerColumn()).rows).toEqual([])
        expect((await merchantIndex()).rows).toEqual([])
        expect((await settingColumns()).rows).toEqual([])
      },
      () => run(up),
    )
    expect((await markerColumn()).rows).toHaveLength(1)
    expect((await merchantIndex()).rows).toHaveLength(1)
    expect((await settingColumns()).rows).toHaveLength(6)
  })

  it('an existing account keeps the marker false — no backfill', async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`merchant-126-${Date.now()}@test.example`],
    )
    const { rows } = await db.query<{ is_merchant_account: boolean }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', true)
       RETURNING is_merchant_account`,
      [user.rows[0].id, '0x' + 'ab'.repeat(20)],
    )
    expect(rows[0].is_merchant_account).toBe(false)
  })
})
