/**
 * Real-Postgres proof for migration 097 — merchant-locked budgets (#3331).
 * No mocks — #1219's rule.
 *
 * Pins the schema half of the issue: `merchant_catalog.pay_to` holds only a
 * lowercased 20-byte address (the probe lowercases; the CHECK makes a writer
 * that forgot fail at the database), `agent_delegations.merchant_id` only
 * ever labels a PINNED row (an open budget "for" a merchant is refused),
 * deleting the merchant drops the label and keeps the budget, and `down()`
 * drops exactly what `up()` created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../097_merchant_pay_to.js'

async function runUp(): Promise<void> {
  const client = await db.connect()
  try {
    await up(client)
  } finally {
    client.release()
  }
}

async function runDown(): Promise<void> {
  const client = await db.connect()
  try {
    await down(client)
  } finally {
    client.release()
  }
}

let seq = 0
const RECIPIENT = '0x' + 'ab'.repeat(20)

async function seedMerchant(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchants (slug, name) VALUES ($1, $1) RETURNING id`,
    [`m096-${seq}-${Date.now()}`],
  )
  return rows[0].id
}

async function seedAgent(): Promise<string> {
  seq += 1
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`m096-${seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status)
     VALUES ($1, 'a', $2, 'active') RETURNING id`,
    [user.rows[0].id, '0x' + 'cd'.repeat(20)],
  )
  return agent.rows[0].id
}

async function insertDelegation(agentId: string, recipient: string | null, merchantId: string | null): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, delegation_hash, delegation_json, version, token_address, recipient_address,
        status, budget_atomic, period_seconds, start_date, expires_at, merchant_id)
     VALUES ($1, 84532, $2, '{}', 1, '0x036cbd53842c5426634e7929541ec2318f3dcf7e', $3,
             'active', '1000000', 86400, 0, 0, $4)
     RETURNING id`,
    [agentId, `0x${seq.toString(16).padStart(64, '0')}`, recipient, merchantId],
  )
  return rows[0].id
}

async function insertCatalogRow(merchantId: string, payTo: string | null): Promise<void> {
  seq += 1
  await db.query(
    `INSERT INTO merchant_catalog (name, description, category, resource_url, rail, protocol, merchant_id, pay_to)
     VALUES ($1, 'x', 'api', $2, 'x402', 'http', $3, $4)`,
    [`o-${seq}`, `https://m096-${seq}.example/paid`, merchantId, payTo],
  )
}

async function columnCount(): Promise<string> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND ((table_name = 'merchant_catalog' AND column_name = 'pay_to')
         OR (table_name = 'agent_delegations' AND column_name = 'merchant_id'))`,
  )
  return rows[0].count
}

describeDb('migration 097_merchant_pay_to', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('names itself', () => {
    expect(version).toBe('097_merchant_pay_to')
  })

  it('adds both columns and down() drops them', async () => {
    await runUp()
    expect(await columnCount()).toBe('2')
    await withMigrationReverted(
      () => runDown(),
      async () => {
        expect(await columnCount()).toBe('0')
      },
      () => runUp(),
    )
  })

  it('is idempotent (re-run)', async () => {
    await runUp()
    await runUp()
    expect(await columnCount()).toBe('2')
  })

  it('stores only a lowercased 20-byte pay_to', async () => {
    await runUp()
    const merchantId = await seedMerchant()
    await insertCatalogRow(merchantId, RECIPIENT)
    await insertCatalogRow(merchantId, null)
    await expect(insertCatalogRow(merchantId, '0x' + 'AB'.repeat(20))).rejects.toThrow(/merchant_catalog_pay_to_chk/)
    await expect(insertCatalogRow(merchantId, '0x1234')).rejects.toThrow(/merchant_catalog_pay_to_chk/)
    await expect(insertCatalogRow(merchantId, 'ab'.repeat(21))).rejects.toThrow(/merchant_catalog_pay_to_chk/)
  })

  it('refuses a merchant label on an OPEN budget, allows it on a pinned one', async () => {
    await runUp()
    const merchantId = await seedMerchant()
    const agentId = await seedAgent()
    await insertDelegation(agentId, RECIPIENT, merchantId)
    await insertDelegation(agentId, null, null)
    await expect(insertDelegation(agentId, null, merchantId)).rejects.toThrow(/agent_delegations_merchant_pinned_chk/)
  })

  it('deleting the merchant drops the label and keeps the pinned budget', async () => {
    await runUp()
    const merchantId = await seedMerchant()
    const agentId = await seedAgent()
    const delegationId = await insertDelegation(agentId, RECIPIENT, merchantId)
    await db.query(`DELETE FROM merchants WHERE id = $1`, [merchantId])
    const { rows } = await db.query<{ merchant_id: string | null; recipient_address: string; status: string }>(
      `SELECT merchant_id, recipient_address, status FROM agent_delegations WHERE id = $1`,
      [delegationId],
    )
    expect(rows[0]).toEqual({ merchant_id: null, recipient_address: RECIPIENT, status: 'active' })
  })
})
