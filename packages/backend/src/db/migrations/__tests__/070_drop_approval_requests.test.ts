/**
 * Real-Postgres proof for the `approval_requests` drop (migration 070, #2055,
 * epic #1440). No mocks — #1219's rule.
 *
 * The harness applies the FULL migration set, so by the time a test body runs
 * the table is already gone; that post-migration state is what production
 * will be in. Tests that need the table back call `down()` first, which
 * doubles as the reversibility proof.
 *
 * The load-bearing test is the FK one: `machine_payment_evidence.
 * approval_request_id` was `ON DELETE CASCADE` (migration 018), so the #2021
 * hazard was a DELETE-first migration silently destroying proof-of-payment
 * evidence. 070 uses `DROP TABLE ... CASCADE`, which drops the dependent
 * CONSTRAINTS and never the child ROWS — the test below proves an evidence
 * row written against a (restored) approval row survives the re-drop with its
 * `approval_request_id` column and value intact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down, version } from '../070_drop_approval_requests.js'

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function columnNames(table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [table],
  )
  return rows.map((r) => r.column_name)
}

async function seedUserAgent(n: number): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`drop070-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, description, delegate_address, api_key_hash, api_key_prefix, safe_id)
     VALUES ($1, 'a', null, $2, 'h', 'sk_agent_070', NULL) RETURNING id`,
    [userId, '0x' + String(n).padStart(40, '7')],
  )
  return { userId, agentId: agent.rows[0].id }
}

describeDb('migration 070: drop approval_requests (#2055)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  afterAll(async () => {
    // Leave the shared worker schema in the migrated (post-070) state,
    // whatever an individual test did — the #2020 leak lesson.
    const client = await db.connect()
    try {
      await up(client)
    } finally {
      client.release()
    }
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('the table is gone after the migration set runs, and up() is idempotent', async () => {
    expect(await tableExists('approval_requests')).toBe(false)
    const client = await db.connect()
    try {
      await up(client) // second run over an already-dropped table must not throw
    } finally {
      client.release()
    }
    expect(await tableExists('approval_requests')).toBe(false)
  })

  it('down() restores the full pre-drop shape (structural reversibility)', async () => {
    const client = await db.connect()
    try {
      await down(client)
      expect(await tableExists('approval_requests')).toBe(true)
      const cols = await columnNames('approval_requests')
      for (const col of [
        'id', 'agent_id', 'user_id', 'safe_address', 'token_symbol', 'token_address',
        'to_address', 'amount_raw', 'amount_human', 'reason', 'status', 'tx_hash',
        'reviewed_at', 'created_at', 'expires_at', 'chain_id', 'usd_value', 'eur_value',
        'executed_at', 'source', 'x402_resource_url', 'payment_rail',
        'payment_resource_url', 'merchant_address', 'machine_challenge_id',
        'machine_idempotency_key', 'machine_metadata', 'send_idempotency_key',
      ]) {
        expect(cols).toContain(col)
      }
      await up(client)
      expect(await tableExists('approval_requests')).toBe(false)
    } finally {
      client.release()
    }
  })

  it('the drop severs FKs without touching evidence ROWS — the #2021 hazard, proven', async () => {
    const client = await db.connect()
    try {
      await down(client)
      const { userId, agentId } = await seedUserAgent(1)
      const approval = await db.query<{ id: string }>(
        `INSERT INTO approval_requests (
           agent_id, user_id, safe_address, token_symbol, token_address, to_address,
           amount_raw, amount_human, status, expires_at, chain_id
         ) VALUES ($1, $2, $3, 'USDC', $4, $5, '1000', '0.001', 'executed', NOW() + INTERVAL '1 day', 8453)
         RETURNING id`,
        [agentId, userId, '0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40), '0x' + 'c'.repeat(40)],
      )
      const approvalId = approval.rows[0].id
      // down() does not restore the 018 FKs (deliberate — see the migration
      // header), so recreate the CASCADE one here to prove the hazard shape
      // this migration was designed against.
      await db.query(
        `ALTER TABLE machine_payment_evidence
           ADD CONSTRAINT test070_evidence_fk FOREIGN KEY (approval_request_id)
           REFERENCES approval_requests(id) ON DELETE CASCADE`,
      )
      const evidence = await db.query<{ id: string }>(
        `INSERT INTO machine_payment_evidence (
           approval_request_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
           token_symbol, token_address, amount_raw, amount_human, resource_url,
           payer_address, settlement_address
         ) VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, 8453, 'USDC', $5, '1000', '0.001', 'https://merchant.test/r', $6, $7)
         RETURNING id`,
        [approvalId, agentId, userId, '0x' + 'd'.repeat(64), '0x' + 'b'.repeat(40), '0x' + 'e'.repeat(40), '0x' + 'f'.repeat(40)],
      )
      const evidenceId = evidence.rows[0].id

      await up(client)

      expect(await tableExists('approval_requests')).toBe(false)
      // The evidence ROW survives, column and value intact.
      const after = await db.query<{ approval_request_id: string | null }>(
        `SELECT approval_request_id FROM machine_payment_evidence WHERE id = $1`,
        [evidenceId],
      )
      expect(after.rows).toHaveLength(1)
      expect(after.rows[0].approval_request_id).toBe(approvalId)
    } finally {
      client.release()
    }
  })
})

describe('migration 070 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe('070_drop_approval_requests')
  })
})
