/**
 * Real-DB tests for `findConfirmedX402PaymentIntents` (#3763).
 *
 * What is at stake: this query is the source of every synthesized x402 row in
 * the transaction history — the twin-collapse pipelines and the CSV export
 * all read through it — and it now carries the merchant's settlement hash
 * beside the funding one. No real-DB test of it existed before #3763; the
 * settlement read gives it one. What the mocks cannot prove: that the JSONB
 * key is actually READ (`machine_metadata.merchant_settlement_tx_hash`), that
 * a scheme-less or erc7710 row is untouched, and that the tenant/account
 * scoping holds.
 *
 * Zero mocks; the harness is real Postgres (#1220), per
 * `docs/contributing/testing-strategy.md`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { findConfirmedX402PaymentIntents } from '../transaction-history.js'

let seq = 0

const FUNDING_HASH = `0x${'a'.repeat(64)}`
const SETTLEMENT_HASH = `0x${'b'.repeat(64)}`
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const MERCHANT = '0x00000000000000000000000000000000000000aa'

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`x402hist-${++seq}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

interface Seed {
  userId: string
  /** Defaults to the seeded account's address/chain; pass to diverge. */
  accountAddress?: string
  chainId?: number
  settlementScheme?: string | null
  /** Writes `machine_metadata.merchant_settlement_tx_hash` when set. */
  settlementTxHash?: string | null
  status?: string
  source?: string
  txHash?: string | null
}

async function seedAccount(userId: string): Promise<{ accountId: string; address: string }> {
  const address = `0x${'c'.repeat(40)}`
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, name)
     VALUES ($1, $2, 8453, 'delegation', 'delegator_hybrid', 'Main') RETURNING id`,
    [userId, address],
  )
  return { accountId: account.rows[0].id, address }
}

async function seedAgent(userId: string): Promise<string> {
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'history agent') RETURNING id`,
    [userId],
  )
  return agent.rows[0].id
}

async function seedIntent(userId: string, agentId: string, seed: Seed): Promise<string> {
  const metadata: Record<string, string> = {}
  if (seed.settlementScheme !== undefined && seed.settlementScheme !== null) {
    metadata.settlement_scheme = seed.settlementScheme
  }
  if (seed.settlementTxHash) {
    metadata.merchant_settlement_tx_hash = seed.settlementTxHash
  }
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, source, payment_rail, execution_rail,
        machine_metadata, tx_hash, expires_at, created_at)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '1000000', '1.00', '0x00000000000000000000000000000000000000d1',
             0, $10, $6, $7, $7, 'delegation',
             $8::jsonb, $9, NOW() + interval '10 minutes', NOW()) RETURNING id`,
    [
      agentId,
      userId,
      seed.accountAddress ?? `0x${'c'.repeat(40)}`,
      TOKEN,
      MERCHANT,
      seed.status ?? 'confirmed',
      seed.source ?? 'x402',
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      seed.txHash === undefined ? FUNDING_HASH : seed.txHash,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
    ],
  )
  return result.rows[0].id
}

describeDb('findConfirmedX402PaymentIntents (#3763)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('an eip3009 payment with a recorded settlement reads the JSONB hash beside the funding one', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const { accountId } = await seedAccount(userId)
    await seedIntent(userId, agentId, {
      userId,
      settlementScheme: 'eip3009',
      settlementTxHash: SETTLEMENT_HASH,
    })

    const rows = await findConfirmedX402PaymentIntents(userId, [accountId])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tx_hash: FUNDING_HASH,
      settlement_tx_hash: SETTLEMENT_HASH,
      settlement_scheme: 'eip3009',
    })
  })

  it('an eip3009 payment with NO recorded settlement reads null — the common case, never a placeholder', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const { accountId } = await seedAccount(userId)
    // Same shape, no `merchant_settlement_tx_hash` key at all.
    await seedIntent(userId, agentId, { userId, settlementScheme: 'eip3009' })

    const rows = await findConfirmedX402PaymentIntents(userId, [accountId])

    expect(rows).toHaveLength(1)
    expect(rows[0].settlement_tx_hash).toBeNull()
    expect(rows[0].settlement_scheme).toBe('eip3009')
  })

  it('an erc7710 payment is returned unchanged with a null settlement — one transaction, no funding leg', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const { accountId } = await seedAccount(userId)
    await seedIntent(userId, agentId, {
      userId,
      settlementScheme: 'erc7710',
      // erc7710 settles account → merchant in ONE transaction; the history
      // row's `tx_hash` IS that settlement and no merchant hash is recorded.
      settlementTxHash: null,
    })

    const rows = await findConfirmedX402PaymentIntents(userId, [accountId])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tx_hash: FUNDING_HASH,
      settlement_tx_hash: null,
      settlement_scheme: 'erc7710',
    })
  })

  it('stays tenant- and status-scoped: another user, another account and an unconfirmed intent never surface', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const { accountId } = await seedAccount(userId)
    await seedIntent(userId, agentId, {
      userId,
      settlementScheme: 'eip3009',
      settlementTxHash: SETTLEMENT_HASH,
    })

    // Same-shape intent under a DIFFERENT user — the seed's default address
    // no longer matches the seeded account, so the smart_accounts JOIN alone
    // excludes it; a wrong `user_id` guard would leak it through some other
    // account. Seed it under a fresh user/agent pair with no account row.
    const otherUserId = await seedUser()
    const otherAgentId = await seedAgent(otherUserId)
    await seedIntent(otherUserId, otherAgentId, {
      userId: otherUserId,
      accountAddress: `0x${'d'.repeat(40)}`,
      settlementScheme: 'eip3009',
      settlementTxHash: SETTLEMENT_HASH,
    })
    // And an unconfirmed intent for the right user — excluded by status.
    await seedIntent(userId, agentId, {
      userId,
      settlementScheme: 'eip3009',
      status: 'submitted',
      txHash: null,
    })

    const rows = await findConfirmedX402PaymentIntents(userId, [accountId])

    // Exactly the one confirmed intent behind the CALLER's account — the
    // other user's and the unconfirmed one are gone.
    expect(rows).toHaveLength(1)
    expect(rows[0].account_id).toBe(accountId)
  })
})
