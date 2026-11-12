/**
 * #4819 — the ROUTE's confirm booking, pinned on the real database.
 *
 * This file is the characterization half of slice 3 of epic #4816: it runs the
 * real `signPayment` state machine against a real Postgres row and pins what a
 * route-confirmed payment records TODAY — the three fiat values in the confirm
 * write, the evidence hook called once, the accounting feed called once, the
 * first-payment event emitted once, and the row enumerated by
 * `listUnpushedPaymentIds` (whose SQL requires one fiat value). The extraction
 * that follows must leave every assertion here byte-identical.
 *
 * The only stand-ins are the seams a test cannot own: the delegation submit
 * (a network call to a bundler), the price source (a network call to
 * CoinGecko), and the two fire-and-forget side effects (spied so their CALL is
 * observable). The booking writes themselves are the real repository SQL.
 *
 * Zero `db.js` mocks; real Postgres on the #1220 harness.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { listUnpushedPaymentIds } from '../../../infra/repositories/accounting-feed-syncs.js'
import { serializeUserOp } from '../../../rails/execution-rail.js'

const { mockSubmit, mockFeed, mockFunnel, mockPrice } = vi.hoisted(() => ({
  mockSubmit: vi.fn(),
  mockFeed: vi.fn(),
  mockFunnel: vi.fn(),
  mockPrice: vi.fn(),
}))

// The submit is the one network seam: the rail's bundler call is not part of
// this test. Everything after it — the confirm write, the evidence hook, the
// feed, the funnel — is the real code path.
vi.mock('../../../rails/delegation-authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/delegation-authorization.js')>()
  return { ...actual, submitDelegationPayment: (...a: unknown[]) => mockSubmit(...a) }
})
// The two fire-and-forget side effects are spied, not replaced: the assertion
// is that the booking CALLS them, once each, with the payment's own ids.
vi.mock('../../accounting/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../accounting/index.js')>()
  return { ...actual, feedSettledPaymentBestEffort: (...a: unknown[]) => mockFeed(...a) }
})
vi.mock('../../../infra/repositories/onboarding-funnel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/onboarding-funnel.js')>()
  return { ...actual, emitFirstPaymentSettled: (...a: unknown[]) => mockFunnel(...a) }
})
// The price source is the second network seam. The REAL
// `getFiatValuesForTokenAmount` runs on top of it, so its failure→nulls
// behaviour is exercised rather than mocked away.
vi.mock('../../../infra/prices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/prices.js')>()
  return { ...actual, getTokenPrice: (...a: unknown[]) => mockPrice(...a) }
})

const { signPayment } = await import('../sign-payment.js')

const CHAIN_ID = 84532
const DELEGATE_ADDRESS = `0x${'11'.repeat(20)}`
const ACCOUNT_ADDRESS = `0x${'aa'.repeat(20)}`
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = `0x${'44'.repeat(20)}`
const SIGNATURE = `0x${'ab'.repeat(97)}`
const TX_HASH = `0x${'cd'.repeat(32)}`

let seq = 0

async function seedOwner(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`confirm-booking-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'confirm booking agent') RETURNING id`,
    [userId],
  )
  return { agentId: agent.rows[0].id, userId }
}

/** A delegation-rail direct intent waiting for its signature. */
async function seedPendingIntent(owner: { agentId: string; userId: string }): Promise<string> {
  const preparedUserOp = serializeUserOp({
    sender: ACCOUNT_ADDRESS,
    nonce: 7n,
    callData: '0xdeadbeef',
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000n,
    paymaster: `0x${'22'.repeat(20)}`,
    paymasterVerificationGasLimit: 30_000n,
    paymasterPostOpGasLimit: 10_000n,
    paymasterData: '0x',
    signature: '0x',
  })
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, chain_id, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, execution_rail, delegation_hash, prepared_user_op,
       payment_rail, status, expires_at
     ) VALUES (
       $1, $2, $3, $4, 'USDC', $5,
       $6, '1000000', '1', $7,
       0, $8, 'delegation', $9, $10,
       'direct', 'pending_signature', NOW() + interval '1 hour'
     )
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      ACCOUNT_ADDRESS,
      CHAIN_ID,
      USDC,
      RECIPIENT,
      DELEGATE_ADDRESS,
      `0x${String(++seq).padStart(64, 'b')}`.slice(0, 66),
      `0x${String(seq).padStart(64, 'e')}`.slice(0, 66),
      preparedUserOp,
    ],
  )
  return result.rows[0].id
}

async function readRow(id: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT status, tx_hash, confirmed_at, usd_value, eur_value, sek_value, machine_metadata
       FROM payment_intents WHERE id = $1`,
    [id],
  )
  return result.rows[0] as unknown as Record<string, unknown>
}

function agentOf(owner: { agentId: string; userId: string }) {
  return {
    id: owner.agentId,
    user_id: owner.userId,
    name: 'confirm booking agent',
    delegate_address: DELEGATE_ADDRESS,
    account_address: ACCOUNT_ADDRESS,
    chain_id: CHAIN_ID,
    status: 'active',
    account_type: 'delegator_hybrid',
    execution_rail: 'delegation',
  }
}

describeDb('#4819 — the route confirm booking (characterization)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    mockSubmit.mockReset()
    mockFeed.mockReset()
    mockFunnel.mockReset()
    mockPrice.mockReset()
    mockPrice.mockResolvedValue({ usd: 1, eur: 0.9, sek: 10.76 })
  })

  it('a route-confirmed payment books the fiat triple, the evidence hook, the feed and the funnel — once each', async () => {
    const owner = await seedOwner()
    const paymentId = await seedPendingIntent(owner)
    mockSubmit.mockResolvedValue({
      txHash: TX_HASH,
      userOpHash: `0x${'ef'.repeat(32)}`,
      actualGasUsed: 100_000n,
      actualGasCost: 1_000n,
    })
    const recordMachinePaymentEvidence = vi.fn(async () => undefined)

    const decided = await signPayment({
      agent: agentOf(owner),
      paymentId,
      signature: SIGNATURE,
      log: { warn: () => {} },
      mppDemoRetired: () => ({ statusCode: 410, body: { error: 'retired' } }),
      recordMachinePaymentEvidence,
    })

    expect(decided.code).toBe(200)

    // The row: confirmed, with the receipt's hash and all three fiat values.
    const row = await readRow(paymentId)
    expect(row.status).toBe('confirmed')
    expect(row.tx_hash).toBe(TX_HASH)
    expect(row.confirmed_at).not.toBeNull()
    expect(Number(row.usd_value)).toBe(1)
    expect(Number(row.eur_value)).toBe(0.9)
    expect(Number(row.sek_value)).toBe(10.76)

    // The side effects: one evidence call, one feed call, one funnel event.
    expect(recordMachinePaymentEvidence).toHaveBeenCalledTimes(1)
    expect(recordMachinePaymentEvidence).toHaveBeenCalledWith(paymentId, owner.agentId, expect.anything())
    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(mockFeed).toHaveBeenCalledWith(owner.userId, paymentId)
    expect(mockFunnel).toHaveBeenCalledTimes(1)
    expect(mockFunnel).toHaveBeenCalledWith(paymentId)

    // The underlag candidate list sees it — the SQL requires one fiat value.
    expect(await listUnpushedPaymentIds(owner.userId, 'memory', 200, null)).toEqual([paymentId])
  })

  it('a price-source failure still confirms the payment, with the fiat values null', async () => {
    const owner = await seedOwner()
    const paymentId = await seedPendingIntent(owner)
    mockSubmit.mockResolvedValue({
      txHash: TX_HASH,
      userOpHash: `0x${'ef'.repeat(32)}`,
      actualGasUsed: 100_000n,
      actualGasCost: 1_000n,
    })
    mockPrice.mockRejectedValue(new Error('CoinGecko down'))
    const recordMachinePaymentEvidence = vi.fn(async () => undefined)

    const decided = await signPayment({
      agent: agentOf(owner),
      paymentId,
      signature: SIGNATURE,
      log: { warn: () => {} },
      mppDemoRetired: () => ({ statusCode: 410, body: { error: 'retired' } }),
      recordMachinePaymentEvidence,
    })

    expect(decided.code).toBe(200)
    const row = await readRow(paymentId)
    expect(row.status).toBe('confirmed')
    expect(row.usd_value).toBeNull()
    expect(row.eur_value).toBeNull()
    expect(row.sek_value).toBeNull()
    // The booking still runs its side effects; only the fiat capture is empty.
    expect(recordMachinePaymentEvidence).toHaveBeenCalledTimes(1)
    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(mockFunnel).toHaveBeenCalledTimes(1)
    // And with no fiat value the underlag list does not see it — the same
    // shape the reconciler's thin booking produced before this slice.
    expect(await listUnpushedPaymentIds(owner.userId, 'memory', 200, null)).toEqual([])
  })
})
