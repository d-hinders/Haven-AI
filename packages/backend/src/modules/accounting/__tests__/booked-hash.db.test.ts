/**
 * B2 on the REAL database (#3767): the booked hash is PINNED at the first
 * claim, so a settlement recorded between two attempts cannot change the
 * bytes a destination already saw — the retry re-pushes the identical
 * transaction (same externalRef, no IDEMPOTENCY_KEY_REUSE) instead of
 * silently switching the booking.
 *
 * Everything runs for real: the entry builder, the pin, the sync rows, the
 * claim, the connector. Only the chain reads are irrelevant here (no report
 * is verified on-chain in this suite) and the entitlement gate is stubbed.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true) },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>()
  return { ...actual, config: { ...actual.config, accountingEnabled: true } }
})

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getSyncState } from '../../../infra/repositories/accounting-feed-syncs.js'
import { InMemoryConnector, clearConnectors, registerConnector } from '../connector.js'
import type { FeedTransaction } from '../feed-transaction.js'
import { ProviderError } from '../provider.js'
import { resetRetrySweepState } from '../retry-sweep.js'
import { feedSettledPayment } from '../feed-orchestrator.js'

const NOW = new Date()

/** A real eip3009 intent + evidence row: no settlement, funding 20 min old. */
async function seedUnfedEip3009(userId: string): Promise<{ id: string; funding: string }> {
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'b2 eip3009') RETURNING id`,
    [userId],
  )
  const user = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])
  void user
  const id = randomUUID()
  const funding = `0x${'f1'.repeat(32)}`
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, confirmed_at, expires_at, source, payment_rail, execution_rail,
        machine_metadata, x402_resource_url, payment_resource_url, merchant_address,
        x402_merchant_address, delegation_hash, created_at)
     VALUES ($1, $2, $3, $4, 8453, 'USDC', $5, $5,
             '1000', '0.001', '0x00000000000000000000000000000000000000d1', 0, $6,
             'confirmed', $7, NOW() - interval '20 minutes', NOW() + interval '10 minutes',
             'x402', 'x402', 'eip3009',
             '{"settlement_scheme":"eip3009"}'::jsonb,
             'https://merchant.example/api', 'https://merchant.example/api', $5, $5, $8,
             NOW() - interval '20 minutes')`,
    [
      id, agent.rows[0].id, userId,
      `0x${'c'.repeat(40)}`,
      `0x${'a'.repeat(40)}`,
      `0x${'3'.repeat(64)}`,
      funding,
      `0x${'b'.repeat(64)}`,
    ],
  )
  await db.query(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
        resource_url, payer_address, settlement_address, token_symbol, token_address,
        amount_raw, amount_human, confirmed_at, amount_sek, fx_rates)
     VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, 8453,
             'https://merchant.example/api',
             '0x00000000000000000000000000000000000000f1',
             '0x00000000000000000000000000000000000000aa',
             'USDC', '0x0000000000000000000000000000000000000002',
             '1000', '0.001', NOW() - interval '20 minutes', '10.42', '{"SEK":10.42}'::jsonb)`,
    [id, agent.rows[0].id, userId, funding],
  )
  return { id, funding }
}

async function seedUserAndConnection(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`b2-${Date.now()}-${Math.random().toString(36).slice(2)}@test.example`],
  )
  const userId = user.rows[0].id
  await db.query(
    `INSERT INTO accounting_connections (user_id, provider, auth_kind, secrets_ciphertext, secrets_key_version, is_active_destination)
     VALUES ($1, 'memory', 'api_key', '{}'::bytea, 0, true)`,
    [userId],
  )
  return userId
}

describeDb('booked-hash pin: stable bytes across attempts (#3767 B2)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    resetRetrySweepState()
    clearConnectors()
    mocks.accountingFeedAvailable.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    clearConnectors()
  })

  it('a settlement recorded between two attempts does not change the pushed transaction', async () => {
    const userId = await seedUserAndConnection()
    const { id, funding } = await seedUnfedEip3009(userId)
    // Grace has passed (confirmed 20 min ago): the first attempt books the
    // funding hash and pins it.

    const SETTLEMENT = `0x${'5e'.repeat(32)}`
    class FailOnce extends InMemoryConnector {
      readonly pushes: FeedTransaction[] = []
      private failed = false
      override async pushTransaction(u: string, tx: FeedTransaction) {
        if (!this.failed) {
          this.failed = true
          throw new ProviderError('memory request failed (HTTP 500)', 500, 'memory')
        }
        this.pushes.push(tx)
        return super.pushTransaction(u, tx)
      }
    }
    const connector = new FailOnce()
    connector.connect(userId)
    registerConnector(connector)

    await expect(feedSettledPayment(userId, id)).resolves.toMatchObject({ outcome: 'failed' })

    // The merchant's verified settlement lands AFTER the failed attempt…
    await db.query(
      `UPDATE payment_intents
         SET machine_metadata = machine_metadata || jsonb_build_object('merchant_settlement_tx_hash', $2::text)
       WHERE id = $1`,
      [id, SETTLEMENT],
    )

    // …and the retry pushes the IDENTICAL booking: the pin, not the new hash.
    await expect(feedSettledPayment(userId, id)).resolves.toMatchObject({ outcome: 'pushed' })
    expect(connector.pushes).toHaveLength(1)
    expect(connector.pushes[0]!.txHash).toBe(funding)
    expect(connector.pushes[0]!.txHashIsFunding).toBe(true)
    expect(connector.pushes[0]!.txHash).not.toBe(SETTLEMENT)

    // The pin is on the row, labelled as funding, and was written once.
    const { rows } = await db.query<{ machine_metadata: Record<string, string> }>(
      `SELECT machine_metadata FROM payment_intents WHERE id = $1`,
      [id],
    )
    expect(rows[0].machine_metadata.accounting_booked_tx_hash).toBe(funding)
    expect(rows[0].machine_metadata.accounting_booked_tx_kind).toBe('funding')

    // The retry did NOT go through IDEMPOTENCY_KEY_REUSE: attempts is 2, status pushed.
    expect(await getSyncState(userId, 'memory', id)).toMatchObject({ status: 'pushed', attempts: 2 })
  })
})
