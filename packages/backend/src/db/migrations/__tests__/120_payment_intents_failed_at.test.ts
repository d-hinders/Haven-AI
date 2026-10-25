/**
 * Real-Postgres proof for migration 120 — `payment_intents.failed_at`
 * (#4378). No mocks — #1219's rule.
 *
 * Pins:
 *   - the column exists at head, `TIMESTAMPTZ`, nullable, no default — the
 *     pre-120 rows are exactly the rows the #4370 fallback still covers;
 *   - `down()` drops it and `up()` restores it (the revert cannot strand the
 *     worker schema off head);
 *   - a failure write through one of the writers lands the stamp against
 *     the restored schema — the column is the writers' target.
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
import { down, up, version } from '../120_payment_intents_failed_at.js'
import { failSubmittedIntent } from '../../../infra/repositories/payment-intents.js'

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
      WHERE table_schema = current_schema() AND table_name = 'payment_intents'
        AND column_name = 'failed_at'`,
  )

async function seedSubmittedIntent(): Promise<{ intentId: string; agentId: string }> {
  const email = `${randomUUID()}@example.com`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, '120 agent') RETURNING id`,
    [user.rows[0].id],
  )
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
       status, expires_at, chain_id)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       '0x00000000000000000000000000000000000000aa', '1000000', '1.00',
       '0x00000000000000000000000000000000000000d1', 0, $3, 'submitted',
       NOW() + INTERVAL '1 day', 84532)
     RETURNING id`,
    [agent.rows[0].id, user.rows[0].id, `0x${randomUUID().replaceAll('-', '')}`],
  )
  return { intentId: intent.rows[0].id, agentId: agent.rows[0].id }
}

describeDb('migration 120 — payment_intents.failed_at (#4378)', () => {
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

  it('is registered as version 120_payment_intents_failed_at', () => {
    expect(version).toBe('120_payment_intents_failed_at')
  })

  it('the schema is at head with a nullable, defaultless failed_at', async () => {
    await assertWorkerSchemaAtHead()
    const cols = await columns()
    expect(cols.rows).toEqual([
      { column_name: 'failed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ])
  })

  it('down() drops the column and up() restores it', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await columns()).rows).toEqual([])
      },
      () => run(up),
    )
    expect((await columns()).rows).toHaveLength(1)
  })

  it('a writer stamps the column against the restored schema', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await columns()).rows).toEqual([])
      },
      () => run(up),
    )
    const { intentId, agentId } = await seedSubmittedIntent()
    await failSubmittedIntent('execution reverted', intentId, agentId)
    const row = await db.query<{ failed_at: Date | null; status: string }>(
      `SELECT failed_at, status FROM payment_intents WHERE id = $1`, [intentId],
    )
    expect(row.rows[0].status).toBe('failed')
    expect(row.rows[0].failed_at).not.toBeNull()
    expect(new Date(row.rows[0].failed_at as unknown as string).getTime())
      .toBeGreaterThan(Date.now() - 60_000)
  })
})
