/**
 * Real-Postgres proof for migration 109 — the delivery-quality reports
 * table (#3770). No mocks — #1219's rule.
 *
 * Pins: the table, its unique (payment, agent) index and the agent listing
 * index exist; the quality enum and the 2000-char note bound are enforced by
 * the database; the upsert's last-write-wins per (payment, agent); `down()`
 * drops exactly what `up()` created; and `up()` is idempotent.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../109_machine_payment_delivery_reports.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

async function insertTestUser(): Promise<string> {
  const email = `${randomBytes(8).toString('hex')}@example.com`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  return rows[0].id
}

/** One agent + one settled intent, the minimum a report row can reference. */
async function insertAgentAndSettledIntent(): Promise<{ userId: string; agentId: string; intentId: string }> {
  const userId = await insertTestUser()
  const { rows: agentRows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, api_key_hash, delegate_address)
     VALUES ($1, 'dq-agent', 'hash',
             '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
     RETURNING id`,
    [userId],
  )
  const { rows: intentRows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (user_id, agent_id, chain_id, token_symbol, token_address,
        account_address, to_address, amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, tx_hash, expires_at)
     VALUES ($1, $2, 8453, 'USDC',
             '0xcccccccccccccccccccccccccccccccccccccccc',
             '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             '0xcccccccccccccccccccccccccccccccccccccccc',
             '10000', '0.01',
             '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
             0, '0x' || repeat('ab', 32), 'confirmed', '0x' || repeat('cd', 32), now() + interval '1 hour')
     RETURNING id`,
    [userId, agentRows[0].id],
  )
  return { userId, agentId: agentRows[0].id, intentId: intentRows[0].id }
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
    [name],
  )
  return Number(rows[0].n) === 1
}

describeDb(`migration ${version}`, () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    // Leave the worker schema at head for the next file.
    await run(up)
    await assertWorkerSchemaAtHead()
  })

  it('creates the table with its two indexes', async () => {
    expect(await tableExists('machine_payment_delivery_reports')).toBe(true)
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'machine_payment_delivery_reports'`,
    )
    const names = rows.map((r) => r.indexname).sort()
    expect(names).toContain('uq_machine_payment_delivery_reports_payment_agent')
    expect(names).toContain('idx_machine_payment_delivery_reports_agent')
  })

  it('stores a verdict and enforces the quality enum + note bound at the database', async () => {
    const { userId, agentId, intentId } = await insertAgentAndSettledIntent()

    const { rows } = await db.query(
      `INSERT INTO machine_payment_delivery_reports (payment_intent_id, agent_id, user_id, quality, note)
       VALUES ($1, $2, $3, 'unusable', 'returned junk') RETURNING quality, note`,
      [intentId, agentId, userId],
    )
    expect(rows[0]).toEqual({ quality: 'unusable', note: 'returned junk' })

    await expect(
      db.query(`INSERT INTO machine_payment_delivery_reports (payment_intent_id, agent_id, user_id, quality)
                VALUES ($1, $2, $3, 'fine')`, [intentId, agentId, userId]),
    ).rejects.toThrow()
    await expect(
      db.query(`INSERT INTO machine_payment_delivery_reports (payment_intent_id, agent_id, user_id, quality, note)
                VALUES ($1, $2, $3, 'ok', $4)`, [intentId, agentId, userId, 'x'.repeat(2001)]),
    ).rejects.toThrow()
  })

  it('is one row per (payment, agent) — last write wins, never a duplicate', async () => {
    const { userId, agentId, intentId } = await insertAgentAndSettledIntent()
    const upsert = (quality: string, note: string | null) =>
      db.query(
        `INSERT INTO machine_payment_delivery_reports (payment_intent_id, agent_id, user_id, quality, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (payment_intent_id, agent_id)
         DO UPDATE SET quality = EXCLUDED.quality, note = EXCLUDED.note, updated_at = NOW()`,
        [intentId, agentId, userId, quality, note],
      )

    await upsert('unusable', 'junk')
    await upsert('ok', null)

    const { rows } = await db.query<{ quality: string; note: string | null }>(
      `SELECT quality, note FROM machine_payment_delivery_reports WHERE payment_intent_id = $1 AND agent_id = $2`,
      [intentId, agentId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ quality: 'ok', note: null })
  })

  it('up() is idempotent and down() drops exactly what up() created', async () => {
    await run(up)
    expect(await tableExists('machine_payment_delivery_reports')).toBe(true)
    await run(down)
    expect(await tableExists('machine_payment_delivery_reports')).toBe(false)
    await run(up)
    expect(await tableExists('machine_payment_delivery_reports')).toBe(true)
  })
})
