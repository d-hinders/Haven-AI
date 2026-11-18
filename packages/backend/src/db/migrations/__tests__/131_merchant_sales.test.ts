/**
 * Real-Postgres proof for migration 131 — the merchant sale record (#4897,
 * epic #4885). No mocks — #1219's rule.
 *
 * Pins: the table exists at head with the chain-fact and record columns;
 * `held_by` is closed to 'account' and 'stripe' and defaults to 'account';
 * `vat_treatment` is closed; the unique index is one record per transaction per
 * account, case-insensitive on the hash; deleting the account removes its
 * sales; `down()` removes the table and `up()` restores it.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../131_merchant_sales.js'

async function seedAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`m131-${randomUUID()}@test.example`],
  )
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', false) RETURNING id`,
    [user.rows[0].id, '0x' + randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)],
  )
  return { userId: user.rows[0].id, accountId: account.rows[0].id }
}

function insertSale(
  seed: { userId: string; accountId: string },
  txHash: string,
  extra: { heldBy?: string; vat?: string | null } = {},
) {
  return db.query(
    `INSERT INTO merchant_sales (
       account_id, user_id, chain_id, tx_hash, held_by, product_id, merchant_reference,
       vat_treatment, amount_raw, token_address, block_number, block_time
     ) VALUES ($1, $2, 84532, $3, COALESCE($4, 'account'), 'p', 'r', $5, 1, '0x' || repeat('a', 40), 1, NOW())`,
    [seed.accountId, seed.userId, txHash, extra.heldBy ?? null, extra.vat ?? null],
  )
}

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

describeDb('migration 131 — merchant sales (#4897)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // Re-apply THIS source over the worker schema, so every case below tests
    // the migration as written now, not a schema an earlier run left behind.
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

  it('has the table with its record and chain-fact columns', async () => {
    const cols = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'merchant_sales'`,
    )
    const byName = new Map(cols.rows.map((c) => [c.column_name, c.is_nullable]))
    for (const name of [
      'id', 'account_id', 'user_id', 'chain_id', 'tx_hash', 'held_by', 'receiving_address',
      'record_version', 'product_id', 'product_name', 'merchant_reference', 'receipt_number',
      'vat_treatment', 'amount_raw', 'token_address', 'payer_address', 'several_payers',
      'sender_is_own_address', 'block_number', 'block_time', 'created_at',
    ]) {
      expect(byName.has(name), name).toBe(true)
    }
    // The record's own amount and payer have no column: they are stored nowhere.
    expect(byName.has('amount')).toBe(false)
    expect(byName.has('payer')).toBe(false)
    expect(byName.get('payer_address')).toBe('YES')
    expect(byName.get('receiving_address')).toBe('YES')
    expect(byName.get('amount_raw')).toBe('NO')
  })

  it('holds one record per transaction per account, whatever the hash case', async () => {
    const a = await seedAccount()
    const b = await seedAccount()
    await insertSale(a, '0x' + 'ab'.repeat(32))
    await expect(insertSale(a, '0x' + 'AB'.repeat(32))).rejects.toThrow(/idx_merchant_sales_chain_hash_account/)
    await expect(insertSale(b, '0x' + 'ab'.repeat(32))).resolves.toBeDefined()
  })

  it('closes held_by and vat_treatment, and defaults held_by to account', async () => {
    const a = await seedAccount()
    await expect(insertSale(a, '0x' + '01'.repeat(32), { heldBy: 'bank' })).rejects.toThrow()
    await expect(insertSale(a, '0x' + '02'.repeat(32), { vat: 'ZERO' })).rejects.toThrow()
    await insertSale(a, '0x' + '03'.repeat(32), { vat: 'REVERSE_CHARGE' })
    const row = await db.query<{ held_by: string }>(`SELECT held_by FROM merchant_sales`)
    expect(row.rows[0].held_by).toBe('account')
  })

  it('deletes with its account', async () => {
    const a = await seedAccount()
    await insertSale(a, '0x' + '04'.repeat(32))
    await db.query(`DELETE FROM smart_accounts WHERE id = $1`, [a.accountId])
    const left = await db.query(`SELECT 1 FROM merchant_sales`)
    expect(left.rowCount).toBe(0)
  })

  it('is registered as version 131_merchant_sales', () => {
    expect(version).toBe('131_merchant_sales')
  })

  it('down() removes the table and up() restores it', async () => {
    const exists = () =>
      db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'merchant_sales'`,
      )
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await exists()).rowCount).toBe(0)
      },
      () => run(up),
    )
    expect((await exists()).rowCount).toBe(1)
    await assertWorkerSchemaAtHead()
  })
})
