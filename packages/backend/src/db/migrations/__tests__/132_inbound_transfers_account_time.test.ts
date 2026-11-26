/**
 * Real-Postgres proof for migration 132 — the access path for one account's
 * transfers by time (#4897, epic #4885). No mocks — #1219's rule.
 *
 * Pins: the index exists with exactly (account_id, block_time DESC); the
 * planner uses it for the sales reads' own predicate (one account, a period)
 * rather than scanning the table; `down()` removes it and `up()` restores it.
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
import { down, up, version } from '../132_inbound_transfers_account_time.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

const indexRows = () =>
  db.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'inbound_transfers'
        AND indexname = 'idx_inbound_transfers_account_time'`,
  )

describeDb('migration 132 — inbound transfers by account and time (#4897)', () => {
  beforeAll(async () => {
    await initDbHarness()
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

  it('pins the index to exactly (account_id, block_time DESC)', async () => {
    const idx = await indexRows()
    expect(idx.rows).toHaveLength(1)
    expect(idx.rows[0].indexdef.replace(/\s+/g, ' ')).toMatch(/\(account_id, block_time DESC\)$/)
  })

  it('serves one account\'s period read without scanning the table', async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('m132@test.example', 'x') RETURNING id`,
    )
    const accounts: string[] = []
    for (let i = 0; i < 20; i += 1) {
      const a = await db.query<{ id: string }>(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
         VALUES ($1, '0x' || md5($2::text), 84532, 'delegation', 'delegator_hybrid', false) RETURNING id`,
        [user.rows[0].id, `a${i}`],
      )
      accounts.push(a.rows[0].id)
    }
    await db.query(
      `INSERT INTO inbound_transfers (account_id, user_id, chain_id, tx_hash, log_index, payer_address,
                                      token_address, amount_raw, block_time)
       SELECT ($1::uuid[])[1 + (g % 20)], $2, 84532, '0x' || lpad(to_hex(g), 64, '0'), 0,
              '0x' || md5(g::text), '0x' || md5('t'), '1',
              TIMESTAMPTZ '2026-01-01' + (g || ' minutes')::interval
         FROM generate_series(1, 20000) g`,
      [accounts, user.rows[0].id],
    )
    await db.query('ANALYZE inbound_transfers')
    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT tx_hash FROM inbound_transfers
        WHERE account_id = $1 AND block_time >= TIMESTAMPTZ '2026-01-05' AND block_time < TIMESTAMPTZ '2026-01-08'`,
      [accounts[3]],
    )
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(text).toContain('idx_inbound_transfers_account_time')
    expect(text).not.toMatch(/Seq Scan/)
  })

  it('is registered as version 132_inbound_transfers_account_time', () => {
    expect(version).toBe('132_inbound_transfers_account_time')
  })

  it('down() removes the index and up() restores it', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await indexRows()).rowCount).toBe(0)
      },
      () => run(up),
    )
    expect((await indexRows()).rowCount).toBe(1)
    await assertWorkerSchemaAtHead()
  })
})
