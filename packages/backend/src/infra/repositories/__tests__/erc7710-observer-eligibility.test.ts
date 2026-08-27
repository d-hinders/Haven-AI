/**
 * Real-DB tests for the erc7710 settlement-observer eligibility scan (#2117).
 *
 * The query `FIND_PENDING_ERC7710_SETTLEMENTS_SQL` decides which `submitted`
 * intents the passive observer may complete — i.e. which settled payments it
 * is allowed to push into the Fortnox evidence pipeline. Every conjunct of
 * its WHERE clause is a guard against completing the WRONG thing, so every
 * guard is exercised on BOTH sides: the row that must be returned and the
 * row that must not. Window-bounded so an expired intent is left alone; the
 * observer must never hammer the RPC for a settlement that can no longer be
 * in-window.
 *
 * Zero mocks; real Postgres on the #1220 harness.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS,
  findPendingErc7710Settlements,
} from '../x402-authorizations.js'

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`obs-elig-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'elig agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

interface IntentSeed {
  agentId: string
  userId: string
  status?: string
  scheme?: string | null
  executionRail?: string | null
  /** COALESCE(payment_rail, source) — override via source and/or paymentRail. */
  source?: string | null
  paymentRail?: string | null
  txHash?: string | null
  /** created_at offset from NOW, in seconds (negative = past). */
  createdOffsetSec?: number
}

async function seedIntent(seed: IntentSeed): Promise<string> {
  const metadata = seed.scheme === null ? null : JSON.stringify({ settlement_scheme: seed.scheme ?? 'erc7710' })
  const createdAt = seed.createdOffsetSec === undefined ? 'NOW()' : `NOW() + (${seed.createdOffsetSec} * interval '1 second')`
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail, execution_rail, machine_metadata, tx_hash,
        created_at)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000aa',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             1, $3, $4, NOW() + interval '10 minutes',
             $5, $6, $7, $8::jsonb, $9,
             ${createdAt})
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66),
      seed.status ?? 'submitted',
      seed.source ?? 'x402',
      seed.paymentRail ?? null,
      seed.executionRail === undefined ? 'delegation' : seed.executionRail,
      metadata,
      seed.txHash ?? null,
    ],
  )
  return result.rows[0].id
}

describeDb('erc7710 settlement-observer eligibility (#2117)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('returns a pending erc7710 intent whose window is still open, oldest first', async () => {
    const { agentId, userId } = await seedAgent()
    await seedIntent({ agentId, userId, createdOffsetSec: -30 })
    await seedIntent({ agentId, userId, createdOffsetSec: -10 })
    await seedIntent({ agentId, userId, createdOffsetSec: -120 })

    const rows = await findPendingErc7710Settlements(ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS, 50)
    expect(rows).toHaveLength(3)
    // Oldest-first: the payment that has been invisible longest is completed first.
    const created = rows.map((r) => new Date(r.created_at ?? '').getTime())
    expect(created[0]).toBeLessThan(created[1])
    expect(created[1]).toBeLessThan(created[2])
    // Each row is evidence-source shaped (consumable by the seam without reshape).
    expect(rows[0]).toMatchObject({
      kind: 'payment_intent',
      status: 'submitted',
      execution_rail: 'delegation',
    })
  })

  it('excludes intents that are not at the observer-completable lifecycle', async () => {
    const { agentId, userId } = await seedAgent()
    await seedIntent({ agentId, userId }) // eligible baseline
    await seedIntent({ agentId, userId, status: 'confirmed' })
    await seedIntent({ agentId, userId, status: 'pending_signature' })
    await seedIntent({ agentId, userId, status: 'failed' })
    await seedIntent({ agentId, userId, scheme: 'eip3009' })
    await seedIntent({ agentId, userId, executionRail: null })
    await seedIntent({ agentId, userId, source: 'direct' })
    await seedIntent({ agentId, userId, paymentRail: 'not_x402', source: null })
    await seedIntent({ agentId, userId, txHash: `0x${'b'.repeat(64)}` })

    const rows = await findPendingErc7710Settlements(ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS, 50)
    expect(rows).toHaveLength(1)
  })

  it('excludes intents whose window has fully expired and ones in the future', async () => {
    const { agentId, userId } = await seedAgent()
    await seedIntent({ agentId, userId, createdOffsetSec: -60 }) // eligible
    const tooOld = ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS + 60
    await seedIntent({ agentId, userId, createdOffsetSec: -tooOld })
    await seedIntent({ agentId, userId, createdOffsetSec: 60 }) // future — not settled yet

    const rows = await findPendingErc7710Settlements(ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS, 50)
    expect(rows).toHaveLength(1)
  })

  it('respects the per-tick scan limit and the max-age parameter', async () => {
    const { agentId, userId } = await seedAgent()
    for (let i = 0; i < 5; i++) await seedIntent({ agentId, userId, createdOffsetSec: -(40 + i) })
    await seedIntent({ agentId, userId, createdOffsetSec: -150 }) // older than maxAge=100

    const limited = await findPendingErc7710Settlements(ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS, 3)
    expect(limited).toHaveLength(3)
    // Oldest three first (limit with oldest-first ordering).
    const created = limited.map((r) => new Date(r.created_at ?? '').getTime())
    expect(created[0]).toBeLessThan(created[1])
    expect(created[1]).toBeLessThan(created[2])

    const tight = await findPendingErc7710Settlements(100, 50)
    // The five seeded within the last 100s qualify; the -150s one is outside
    // the max-age and must stay out.
    expect(tight).toHaveLength(5)
  })
})
