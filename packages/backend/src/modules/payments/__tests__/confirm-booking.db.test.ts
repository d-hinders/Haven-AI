/**
 * #4819 — a payment the reconciler confirms is booked like one the route
 * confirms, on the real database, with BOTH writers in the same file.
 *
 * The acceptance criteria this file answers:
 *
 * - a payment confirmed by `runSubmissionReconcileTick` has the three fiat
 *   values set when the price source answers, the evidence hook called once,
 *   the accounting feed called once, and is returned by
 *   `listUnpushedPaymentIds` until it is pushed — the same assertions the
 *   route-confirmed control makes in `sign-payment-confirm-booking.db.test.ts`;
 * - when the price source fails the payment still ends `confirmed` with null
 *   fiat values, as on the route;
 * - after a reconciler confirm `machine_metadata->>'submission_outcome'` is
 *   not `unknown`;
 * - both directions of the race book once — a tick losing the compare-and-set
 *   to the route, and the route losing to the tick — one evidence call and one
 *   feed call in total;
 * - the epic's second read-only census counts the payments already confirmed
 *   with the thin booking.
 *
 * The seams are the ones a test cannot own: the delegation submit (a bundler
 * call), the price source (CoinGecko), and the two fire-and-forget side
 * effects (spied so their CALL is observable). Every booking write is the real
 * repository SQL against real Postgres on the #1220 harness.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { listUnpushedPaymentIds } from '../../../infra/repositories/accounting-feed-syncs.js'
import {
  bookSubmittedOutcomePending,
  countReconcilerThinBookings,
} from '../../../infra/repositories/payment-intents.js'
import { serializeUserOp } from '../../../rails/execution-rail.js'
import { bookConfirmedPayment } from '../confirm-booking.js'
import { runSubmissionReconcileTick, type ReconcileLogger } from '../submission-reconciler.js'

const { mockFeed, mockFunnel, mockPrice } = vi.hoisted(() => ({
  mockFeed: vi.fn(),
  mockFunnel: vi.fn(),
  mockPrice: vi.fn(),
}))

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

const CHAIN_ID = 84532
const DELEGATE_ADDRESS = `0x${'11'.repeat(20)}`
const ACCOUNT_ADDRESS = `0x${'aa'.repeat(20)}`
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = `0x${'44'.repeat(20)}`
const ROUTE_TX_HASH = `0x${'cd'.repeat(32)}`
const RECEIPT_TX_HASH = `0x${'ef'.repeat(32)}`
const USER_OP_HASH = `0x${'ab'.repeat(32)}`

const log: ReconcileLogger = { info: () => {}, warn: () => {} }

let seq = 0

async function seedOwner(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`reconciler-booking-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'reconciler booking agent') RETURNING id`,
    [userId],
  )
  return { agentId: agent.rows[0].id, userId }
}

interface SeedOptions {
  status?: string
  metadata?: Record<string, unknown> | null
  signedAtOffset?: number
}

/** A delegation-rail direct intent in whatever state the test needs. */
async function seedIntent(
  owner: { agentId: string; userId: string },
  opts: SeedOptions = {},
): Promise<string> {
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
       payment_rail, machine_metadata, status, expires_at, signed_at
     ) VALUES (
       $1, $2, $3, $4, 'USDC', $5,
       $6, '1000000', '1', $7,
       0, $8, 'delegation', $9, $10,
       'direct', $11::jsonb, $12, NOW() + interval '1 hour',
       NOW() + ($13 * interval '1 second')
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
      opts.metadata === undefined ? null : JSON.stringify(opts.metadata),
      opts.status ?? 'submitted',
      opts.signedAtOffset ?? -300,
    ],
  )
  return result.rows[0].id
}

/** An outcome-pending row, exactly as the sign route books one (#3564/#4817). */
async function seedOutcomePending(owner: { agentId: string; userId: string }): Promise<string> {
  const id = await seedIntent(owner, { signedAtOffset: -300 })
  const booked = await bookSubmittedOutcomePending({
    userOpHash: USER_OP_HASH,
    intentId: id,
    agentId: owner.agentId,
  })
  expect(booked).toBe(true)
  return id
}

async function readRow(id: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT status, tx_hash, confirmed_at, usd_value, eur_value, sek_value, machine_metadata
       FROM payment_intents WHERE id = $1`,
    [id],
  )
  return result.rows[0] as unknown as Record<string, unknown>
}

/** The candidate snapshot the tick would have read before the race. */
function candidateOf(id: string, owner: { agentId: string; userId: string }) {
  return {
    id,
    agent_id: owner.agentId,
    user_id: owner.userId,
    chain_id: CHAIN_ID,
    signed_at: new Date(Date.now() - 300_000).toISOString(),
    user_op_hash: USER_OP_HASH,
    token_symbol: 'USDC',
    amount_human: '1',
  }
}

function includedReceipt() {
  return { state: 'included' as const, success: true, txHash: RECEIPT_TX_HASH }
}

describeDb('#4819 — the reconciler confirm books like the route confirm', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    mockFeed.mockReset()
    mockFunnel.mockReset()
    mockPrice.mockReset()
    mockPrice.mockResolvedValue({ usd: 1, eur: 0.9, sek: 10.76 })
  })

  it('a reconciler-confirmed payment books the fiat triple, the evidence hook, the feed and the funnel — once each', async () => {
    const owner = await seedOwner()
    const paymentId = await seedOutcomePending(owner)
    const recordEvidence = vi.fn(async () => undefined)

    const result = await runSubmissionReconcileTick(log, {
      readReceipt: async () => includedReceipt(),
      recordEvidence,
    })

    expect(result).toMatchObject({ candidates: 1, confirmed: 1, unresolved: 0 })

    const row = await readRow(paymentId)
    expect(row.status).toBe('confirmed')
    expect(row.tx_hash).toBe(RECEIPT_TX_HASH)
    expect(row.confirmed_at).not.toBeNull()
    expect(Number(row.usd_value)).toBe(1)
    expect(Number(row.eur_value)).toBe(0.9)
    expect(Number(row.sek_value)).toBe(10.76)
    // A confirmed row no longer reads "unknown".
    expect((row.machine_metadata as Record<string, unknown>).submission_outcome).toBe('resolved')

    expect(recordEvidence).toHaveBeenCalledTimes(1)
    expect(recordEvidence).toHaveBeenCalledWith(paymentId, owner.agentId, expect.anything())
    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(mockFeed).toHaveBeenCalledWith(owner.userId, paymentId)
    expect(mockFunnel).toHaveBeenCalledTimes(1)
    expect(mockFunnel).toHaveBeenCalledWith(paymentId)

    // The underlag candidate list sees it — the SQL requires one fiat value.
    expect(await listUnpushedPaymentIds(owner.userId, 'memory', 200, null)).toEqual([paymentId])
  })

  it('a price-source failure still confirms the payment, with the fiat values null', async () => {
    const owner = await seedOwner()
    const paymentId = await seedOutcomePending(owner)
    mockPrice.mockRejectedValue(new Error('CoinGecko down'))
    const recordEvidence = vi.fn(async () => undefined)

    const result = await runSubmissionReconcileTick(log, {
      readReceipt: async () => includedReceipt(),
      recordEvidence,
    })

    expect(result).toMatchObject({ candidates: 1, confirmed: 1 })
    const row = await readRow(paymentId)
    expect(row.status).toBe('confirmed')
    expect(row.usd_value).toBeNull()
    expect(row.eur_value).toBeNull()
    expect(row.sek_value).toBeNull()
    // The booking still runs its side effects; only the fiat capture is empty.
    expect(recordEvidence).toHaveBeenCalledTimes(1)
    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(mockFunnel).toHaveBeenCalledTimes(1)
    // No fiat value means no underlag candidate — the same shape the route
    // produces on a price failure.
    expect(await listUnpushedPaymentIds(owner.userId, 'memory', 200, null)).toEqual([])
  })

  it('RACE, tick loses: the route\'s booking confirms first, the tick books nothing — one evidence call and one feed call in total', async () => {
    const owner = await seedOwner()
    const paymentId = await seedOutcomePending(owner)
    const recordEvidence = vi.fn(async () => undefined)

    // The route's writer is `bookConfirmedPayment` — the exact function
    // `signPayment` calls on its success path. (In this slice the full route
    // cannot reach it for an outcome-pending row: its claim refuses a
    // `submitted` row. #4818's intake is what makes the route and the tick
    // race on a LIVE row; the compare-and-set under test is the same one.)
    const routeBooked = await bookConfirmedPayment({
      intentId: paymentId,
      txHash: ROUTE_TX_HASH,
      agentId: owner.agentId,
      userId: owner.userId,
      tokenSymbol: 'USDC',
      amountHuman: '1',
      log,
      recordEvidence,
    })
    expect(routeBooked).toBe(true)

    // The tick had already read the candidate list; its receipt now arrives.
    const result = await runSubmissionReconcileTick(log, {
      findCandidates: async () => [candidateOf(paymentId, owner)],
      readReceipt: async () => includedReceipt(),
      recordEvidence,
    })
    expect(result).toMatchObject({ candidates: 1, confirmed: 0, unresolved: 1 })

    const row = await readRow(paymentId)
    expect(row.status).toBe('confirmed')
    // The route's hash stands — the tick's lost write changed nothing.
    expect(row.tx_hash).toBe(ROUTE_TX_HASH)
    expect(recordEvidence).toHaveBeenCalledTimes(1)
    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(mockFunnel).toHaveBeenCalledTimes(1)
  })

  it('RACE, route loses: the tick confirms first, the route\'s booking books nothing — one evidence call and one feed call in total', async () => {
    const owner = await seedOwner()
    const paymentId = await seedOutcomePending(owner)
    const recordEvidence = vi.fn(async () => undefined)

    const result = await runSubmissionReconcileTick(log, {
      findCandidates: async () => [candidateOf(paymentId, owner)],
      readReceipt: async () => includedReceipt(),
      recordEvidence,
    })
    expect(result).toMatchObject({ candidates: 1, confirmed: 1 })

    // The route's writer arrives second and loses the compare-and-set.
    const routeBooked = await bookConfirmedPayment({
      intentId: paymentId,
      txHash: ROUTE_TX_HASH,
      agentId: owner.agentId,
      userId: owner.userId,
      tokenSymbol: 'USDC',
      amountHuman: '1',
      log,
      recordEvidence,
    })
    expect(routeBooked).toBe(false)

    const row = await readRow(paymentId)
    expect(row.status).toBe('confirmed')
    // The tick's receipt hash stands, not the route's submit hash.
    expect(row.tx_hash).toBe(RECEIPT_TX_HASH)
    expect(recordEvidence).toHaveBeenCalledTimes(1)
    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(mockFunnel).toHaveBeenCalledTimes(1)
  })

  it('the census counts confirmed rows still carrying the thin booking, and nothing else', async () => {
    const owner = await seedOwner()
    // A row the OLD reconciler confirmed: confirmed, marker still 'unknown'.
    const thin = await seedIntent(owner, {
      status: 'confirmed',
      metadata: { user_op_hash: USER_OP_HASH, submission_outcome: 'unknown' },
    })
    // A row this slice's booking confirmed: the marker is resolved.
    const booked = await seedOutcomePending(owner)
    await runSubmissionReconcileTick(log, {
      readReceipt: async () => includedReceipt(),
      recordEvidence: async () => undefined,
    })
    // An outcome-pending row that is still open — not confirmed, not counted.
    await seedOutcomePending(owner)
    expect(await countReconcilerThinBookings()).toBe(1)
    const counted = await db.query<{ id: string }>(
      `SELECT id FROM payment_intents WHERE status = 'confirmed' AND machine_metadata->>'submission_outcome' = 'unknown'`,
    )
    expect(counted.rows.map((r) => r.id)).toEqual([thin])
    expect(counted.rows.map((r) => r.id)).not.toContain(booked)
  })
})
