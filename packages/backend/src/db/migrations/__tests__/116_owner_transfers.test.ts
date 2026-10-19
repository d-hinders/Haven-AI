/**
 * Real-Postgres proof for migration 116 — the owner-send record (#4099).
 * No mocks — #1219's rule.
 *
 * Pins the shape the repository relies on (the dedupe arbiter, the cascades)
 * and that up/down round-trip back to head. Repository behaviour is in
 * `infra/repositories/__tests__/owner-transfers.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../116_owner_transfers.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

let seq = 0
async function seedAccount(): Promise<{ userId: string; accountId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`m116-${n}-${Date.now()}@test.example`],
  )
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id) VALUES ($1, $2, 84532) RETURNING id`,
    [user.rows[0].id, `0x${String(n).padStart(4, '0')}${'a'.repeat(36)}`],
  )
  return { userId: user.rows[0].id, accountId: account.rows[0].id }
}

const INSERT = `INSERT INTO owner_transfers
                  (user_id, account_id, chain_id, tx_hash, token_address, to_address, amount_raw)
                VALUES ($1, $2, $3, $4, '0x${'1'.repeat(40)}', '0x${'2'.repeat(40)}', '1')`

describeDb('migration 116 — owner_transfers (#4099)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    // Whatever a failed case left, put the worker schema back at head.
    await run(up)
    await assertWorkerSchemaAtHead()
  })

  it('is registered as version 116_owner_transfers', () => {
    expect(version).toBe('116_owner_transfers')
  })

  it('the identity index refuses a second row for one (chain, tx hash, account)', async () => {
    const { userId, accountId } = await seedAccount()
    const tx = `0x${'f'.repeat(64)}`
    await db.query(INSERT, [userId, accountId, 84532, tx])
    await expect(db.query(INSERT, [userId, accountId, 84532, tx])).rejects.toMatchObject({ code: '23505' })
    // The same hash on another chain is a different transfer.
    await db.query(INSERT, [userId, accountId, 8453, tx])
  })

  it('cascades from its account and its user', async () => {
    const a = await seedAccount()
    const b = await seedAccount()
    await db.query(INSERT, [a.userId, a.accountId, 84532, `0x${'a'.repeat(64)}`])
    await db.query(INSERT, [b.userId, b.accountId, 84532, `0x${'b'.repeat(64)}`])
    await db.query(`DELETE FROM smart_accounts WHERE id = $1`, [a.accountId])
    await db.query(`DELETE FROM users WHERE id = $1`, [b.userId])
    const { rowCount } = await db.query(`SELECT 1 FROM owner_transfers`)
    expect(rowCount).toBe(0)
  })

  it('up is idempotent and down drops exactly the table', async () => {
    await run(up)
    await assertWorkerSchemaAtHead()
    await run(down)
    const gone = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'owner_transfers'`,
    )
    expect(gone.rowCount).toBe(0)
    await run(up)
    await assertWorkerSchemaAtHead()
  })
})
