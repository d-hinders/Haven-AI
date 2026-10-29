/**
 * Real-DB tests for the agent ledger export's read (#4327).
 *
 * `listAgentPaymentsForExport` claims two things about what Postgres returns:
 * the export's rows are the FILTERED population the Activity tab shows (failed
 * attempts that never reached the chain included), and the read is capped at
 * `cap + 1` rows so the route can refuse an over-cap export without an
 * unbounded count. Both belong on the #1220 harness, not on a mocked
 * dispatcher. Zero mocks; row builders are local per #1220's rule.
 */
import { beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { listAgentPaymentsForExport, type AgentPaymentActivityFilter } from '../agent-activity.js'

let seq = 0

async function seedUserWithAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`activity-export-${n}-${randomUUID()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'activity export agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/** A payment intent with an explicit status and `created_at`; failed rows carry no tx hash. */
async function seedIntent(
  seed: { userId: string; agentId: string },
  status: string,
  createdAt: string,
): Promise<string> {
  const n = ++seq
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, created_at, confirmed_at, expires_at,
       chain_id, source, execution_rail, tx_hash
     ) VALUES (
       $1, $2, $3, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       $4, $5, $6,
       '0x00000000000000000000000000000000000000d1', 1, $7,
       $8, $9::timestamptz, $10::timestamptz, NOW() + INTERVAL '10 minutes', 84532,
       'api', 'delegation', $11
     ) RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(3e12 + n).padStart(40, '0').slice(-40)}`,
      `0x${String(n).padStart(40, '1').slice(-40)}`,
      `${1000000 + n}`,
      String(n),
      `0x${String(n).padStart(64, 'e')}`,
      status,
      createdAt,
      status === 'confirmed' ? createdAt : null,
      status === 'confirmed' ? `0x${String(n).padStart(64, 'f')}` : null,
    ],
  )
  return result.rows[0].id
}

const NO_FILTER: AgentPaymentActivityFilter = {
  status: null,
  rails: ['x402'],
  from: null,
  to: null,
  q: null,
  paymentId: null,
  token: null,
}

describeDb('listAgentPaymentsForExport (#4327)', () => {
  initDbHarness()
  beforeEach(resetDb)

  it('returns the filtered population — a failed attempt with no tx hash included — newest first', async () => {
    const seed = await seedUserWithAgent()
    const sent = await seedIntent(seed, 'confirmed', '2026-10-01T10:00:00Z')
    const failedOld = await seedIntent(seed, 'failed', '2026-10-02T10:00:00Z')
    const failedNew = await seedIntent(seed, 'failed', '2026-10-03T10:00:00Z')

    const all = await listAgentPaymentsForExport(seed.agentId, NO_FILTER, 10)
    expect(all.map((r) => r.id)).toEqual([failedNew, failedOld, sent])

    const failed = await listAgentPaymentsForExport(seed.agentId, { ...NO_FILTER, status: 'failed' }, 10)
    expect(failed.map((r) => r.id)).toEqual([failedNew, failedOld])
    expect(failed.every((r) => r.tx_hash === null)).toBe(true)
  })

  it('reads cap + 1 rows — the over-cap signal — and never more', async () => {
    const seed = await seedUserWithAgent()
    for (let day = 1; day <= 5; day++) {
      await seedIntent(seed, 'confirmed', `2026-10-0${day}T10:00:00Z`)
    }

    expect(await listAgentPaymentsForExport(seed.agentId, NO_FILTER, 3)).toHaveLength(4)
    expect(await listAgentPaymentsForExport(seed.agentId, NO_FILTER, 5)).toHaveLength(5)
  })

  it("reads only this agent's rows", async () => {
    const mine = await seedUserWithAgent()
    const theirs = await seedUserWithAgent()
    const own = await seedIntent(mine, 'confirmed', '2026-10-01T10:00:00Z')
    await seedIntent(theirs, 'confirmed', '2026-10-01T11:00:00Z')

    const rows = await listAgentPaymentsForExport(mine.agentId, NO_FILTER, 10)
    expect(rows.map((r) => r.id)).toEqual([own])
  })
})
