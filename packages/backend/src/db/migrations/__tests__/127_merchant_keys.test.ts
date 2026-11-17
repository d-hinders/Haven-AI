/**
 * Real-Postgres proof for migration 127 — the receive-only merchant key
 * (#4896, epic #4885). No mocks — #1219's rule.
 *
 * Pins:
 *   - `merchant_keys` exists at head with its ten columns and their nullability;
 *   - `key_hash` is UNIQUE — one row per secret;
 *   - the revocation CHECK refuses a half-revoked row (one of `revoked_by` /
 *     `revoked_at` set, the other null);
 *   - `down()` removes the table and `up()` restores it;
 *   - the schema is at head after the cycle.
 *
 * The table's BEHAVIOUR (a revoked key refused, the off switch, the last-used
 * throttle, account scoping) is proven against real Postgres in
 * `routes/__tests__/merchant-keys.db.test.ts`.
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
import { down, up, version } from '../127_merchant_keys.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

const keyColumns = () =>
  db.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'merchant_keys'
      ORDER BY column_name`,
  )

const keyHashIndex = () =>
  db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'merchant_keys'
        AND indexname = 'merchant_keys_key_hash_key'`,
  )

async function seedUserAndAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`merchant-127-${Date.now()}-${Math.random()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, is_merchant_account)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', false, true) RETURNING id`,
    [userId, '0x' + Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40)],
  )
  return { userId, accountId: account.rows[0].id }
}

describeDb('migration 127 — merchant keys (#4896)', () => {
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

  it('is registered as version 127_merchant_keys', () => {
    expect(version).toBe('127_merchant_keys')
  })

  it('the schema is at head with the ten columns and their nullability', async () => {
    await assertWorkerSchemaAtHead()
    expect((await keyColumns()).rows).toEqual([
      { column_name: 'account_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'created_by', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'key_hash', data_type: 'character varying', is_nullable: 'NO' },
      { column_name: 'key_prefix', data_type: 'character varying', is_nullable: 'NO' },
      { column_name: 'last_used_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'revoked_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'revoked_by', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: 'NO' },
    ])
  })

  it('key_hash is UNIQUE — one row per secret', async () => {
    const { rows } = await keyHashIndex()
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i)
    expect(rows[0].indexdef).toMatch(/\(key_hash\)/)

    const { userId, accountId } = await seedUserAndAccount()
    const insert = (hash: string) =>
      db.query(
        `INSERT INTO merchant_keys (user_id, account_id, key_hash, key_prefix, created_by)
         VALUES ($1, $2, $3, $4, $1)`,
        [userId, accountId, hash, 'sk_merchant_' + hash.slice(0, 12)],
      )
    await insert('a'.repeat(64))
    await expect(insert('a'.repeat(64))).rejects.toMatchObject({ code: '23505' })
  })

  it('the revocation CHECK refuses a half-revoked row', async () => {
    const { userId, accountId } = await seedUserAndAccount()
    let n = 0
    const insert = (revokedBy: string | null, revokedAt: string | null) => {
      n += 1
      const hash = String(n).padStart(64, 'b')
      return db.query(
        `INSERT INTO merchant_keys (user_id, account_id, key_hash, key_prefix, created_by, revoked_by, revoked_at)
         VALUES ($1, $2, $3, $4, $1, $5, $6)`,
        [userId, accountId, hash, 'sk_merchant_' + hash.slice(0, 12), revokedBy, revokedAt],
      )
    }

    await expect(insert(userId, null)).rejects.toMatchObject({ code: '23514' })
    await expect(insert(null, '2026-11-17T00:00:00Z')).rejects.toMatchObject({ code: '23514' })
    // Both set and both null are the two honest states.
    await expect(insert(userId, '2026-11-17T00:00:00Z')).resolves.toBeDefined()
    await expect(insert(null, null)).resolves.toBeDefined()
  })

  it('down() removes the table; up() restores it', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await keyColumns()).rows).toEqual([])
      },
      () => run(up),
    )
    expect((await keyColumns()).rows).toHaveLength(10)
  })
})
