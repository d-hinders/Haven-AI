/**
 * The fire-and-forget contract of the refusal ledger (#2945), proven on the
 * real harness — this is the test the issue names directly: "a mocked write
 * failure MUST NOT change the refusal the caller receives".
 *
 * `recordRefusalFireAndForget` is the contract's whole body: it returns
 * synchronously (so a handler that has already decided its refusal response
 * is never delayed or broken by the ledger), detaches the write, and on a
 * failing write logs and swallows. The tests below make `recordPaymentRefusal`
 * REJECT while the caller's own promise resolves fine, then prove the real
 * row the succeeding call wrote. The routing tests in
 * routes/__tests__/x402-delegation.test.ts pin which refusal each path asks
 * for; this file owns the never-propagates property itself.
 *
 * Prices are STUBBED (`prices.js`): the booking must come from the same
 * `getFiatValuesForTokenAmount` path settled payments use — a stubbed price
 * with known numbers pins the arithmetic (`amount * price`) and the NULL
 * fall-through on a price outage, without a network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRecord, mockGetTokenPrice, realRefusals } = vi.hoisted(() => ({
  mockRecord: vi.fn(),
  mockGetTokenPrice: vi.fn(),
  // Holds the REAL recordPaymentRefusal, captured in the factory below —
  // a dynamic import inside the implementation would resolve to the MOCK
  // itself (vi.mock intercepts those too) and recurse forever.
  realRefusals: {} as { recordPaymentRefusal?: (...args: any[]) => Promise<any> },
}))

// The repository is the failure seam: make IT reject. The ledger module's
// catch is what must absorb it.
vi.mock('../../../infra/repositories/payment-refusals.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/payment-refusals.js')>()
  realRefusals.recordPaymentRefusal = actual.recordPaymentRefusal
  return { ...actual, recordPaymentRefusal: (...a: unknown[]) => mockRecord(...a) }
})
vi.mock('../../../infra/prices.js', () => ({
  getTokenPrice: (...a: unknown[]) => mockGetTokenPrice(...a),
}))

import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import {
  recordRefusalFireAndForget,
  pickRefusalDetail,
  classifyRevertForLedger,
} from '../refusal-ledger.js'
import { EstimateGasExecutionError } from 'viem'

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`refusalsledger-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, `refusals-ledger-agent-${seq}`],
  )
  return rows[0].id
}

function fakeAddress(n: number): string {
  return `0x${String(n).padStart(40, '0')}`
}

async function seedAccount(userId: string, address: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id)
     VALUES ($1, $2, 84532) RETURNING id`,
    [userId, address],
  )
  return rows[0].id
}

function ledgerInput(userId: string, agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    agentId,
    chainId: 84532,
    tokenSymbol: 'USDC',
    amountAtomic: '100000',
    accountAddress: fakeAddress(700),
    merchantTo: '0x' + 'cc'.repeat(20),
    resourceUrl: 'https://merchant.example/resource',
    reason: 'delegation_budget_exceeded' as const,
    source: 'x402_authorize' as const,
    detail: {
      error_code: 'delegation_budget_exceeded',
      phase: 'insufficient_funds',
      next_action: 'fund_safe_or_raise_allowance',
      remaining_atomic: '50000',
      amount: '0.10',
      components: { account: '0xwhatever' },
    },
    ...overrides,
  }
}

/**
 * Poll (bounded) until the agent's refusal row has landed — the detached
 * write crosses several real pg I/O turns, so a single microtask flush is
 * not enough to observe it.
 */
async function waitForRowCount(agentId: string, expected: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payment_refusals WHERE agent_id = $1`,
      [agentId],
    )
    if (Number(rows[0].count) >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`refusal row never landed (wanted ${expected})`)
}

describeDb('refusal ledger fire-and-forget contract (#2945)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // USDC at $1 / €0.92 — the stub the booking arithmetic is pinned against.
    mockGetTokenPrice.mockResolvedValue({ usd: 1, eur: 0.92, sek: 10.5 })
  })

  afterAll(async () => {
    assertWorkerSchemaAtHead()
  })

  beforeEach(async () => {
    await resetDb()
    mockRecord.mockReset()
    // Default: pass through to the REAL repository (captured in the factory).
    mockRecord.mockImplementation(async (...args: unknown[]) => {
      return realRefusals.recordPaymentRefusal!(...args)
    })
  })

  it('returns synchronously; the real row lands with the price-booked values and the allowlisted detail', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedAccount(userId, fakeAddress(700))

    // THE fire-and-forget property: no await. The return type is void.
    const returned = recordRefusalFireAndForget(
      ledgerInput(userId, agentId) as Parameters<typeof recordRefusalFireAndForget>[0],
    )
    expect(returned).toBeUndefined()
    await waitForRowCount(agentId, 1)

    const { rows } = await db.query<{
      usd_value: string | null
      eur_value: string | null
      amount_atomic: string
      detail: Record<string, string> | null
      account_id: string | null
      reason: string
      source: string
      merchant_to: string | null
      resource_url: string | null
    }>(`SELECT usd_value, eur_value, amount_atomic, detail, account_id, reason, source, merchant_to, resource_url
         FROM payment_refusals WHERE agent_id = $1`, [agentId])
    expect(rows).toHaveLength(1)
    const row = rows[0]
    // 0.10 USDC at the stubbed price: amount_human 0.10 * 1 / * 0.92.
    expect(Number(row.usd_value)).toBeCloseTo(0.1, 6)
    expect(Number(row.eur_value)).toBeCloseTo(0.092, 6)
    expect(row.amount_atomic).toBe('100000')
    // The allowlist in action: `amount` and `components` were in the caller's
    // detail and must NOT have survived the pick.
    expect(row.detail).toEqual({
      error_code: 'delegation_budget_exceeded',
      phase: 'insufficient_funds',
      next_action: 'fund_safe_or_raise_allowance',
      remaining_atomic: '50000',
    })
    expect(row.reason).toBe('delegation_budget_exceeded')
    expect(row.source).toBe('x402_authorize')
    expect(row.merchant_to).toBe('0x' + 'cc'.repeat(20))
    expect(row.resource_url).toBe('https://merchant.example/resource')
    // account_id resolved through smart_accounts (the FK's vocabulary).
    expect(row.account_id).not.toBeNull()
  })

  it('THE mocked-write-failure proof: recordPaymentRefusal REJECTS and the caller is never told', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)

    mockRecord.mockRejectedValue(new Error('ledger write exploded'))

    // The caller-facing contract: resolves (void), never rejects, never
    // throws — even though the write beneath it is failing.
    expect(() =>
      recordRefusalFireAndForget(
        ledgerInput(userId, agentId) as Parameters<typeof recordRefusalFireAndForget>[0],
      ),
    ).not.toThrow()
    // Give the failing write every chance to have run (and been absorbed):
    // a full second of event-loop turns, then assert nothing landed and
    // nothing propagated.
    await new Promise((resolve) => setTimeout(resolve, 1000))

    expect(mockRecord).toHaveBeenCalledTimes(1)
    // And nothing was written — the failure was absorbed, not retried.
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payment_refusals WHERE agent_id = $1`,
      [agentId],
    )
    expect(Number(rows[0].count)).toBe(0)
  })

  it('a price outage books NULLs (never a fabricated zero), and the row still lands', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    mockGetTokenPrice.mockRejectedValue(new Error('coingecko down'))

    recordRefusalFireAndForget(
      ledgerInput(userId, agentId) as Parameters<typeof recordRefusalFireAndForget>[0],
    )
    await waitForRowCount(agentId, 1)

    const { rows } = await db.query<{ usd_value: string | null; eur_value: string | null }>(
      `SELECT usd_value, eur_value FROM payment_refusals WHERE agent_id = $1`,
      [agentId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].usd_value).toBeNull()
    expect(rows[0].eur_value).toBeNull()
  })

  it('an unresolvable account books account_id NULL and still records the refusal', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    // No smart_accounts row for this address — the FK column must be NULL,
    // the refusal row must exist anyway.
    recordRefusalFireAndForget(
      ledgerInput(userId, agentId, { accountAddress: fakeAddress(999) }) as Parameters<typeof recordRefusalFireAndForget>[0],
    )
    await waitForRowCount(agentId, 1)

    const { rows } = await db.query<{ account_id: string | null }>(
      `SELECT account_id FROM payment_refusals WHERE agent_id = $1`,
      [agentId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].account_id).toBeNull()
  })
})

describe('refusal ledger unit contracts', () => {
  it('pickRefusalDetail copies only allowlisted string keys', () => {
    expect(
      pickRefusalDetail({
        error_code: 'x',
        phase: 'y',
        next_action: 'z',
        remaining_atomic: '1',
        budget_atomic: '2',
        amount: '0.10',
        shortfall_atomic: '3',
        components: { account: '0xa' },
        merchant_address: '0xb',
      }),
    ).toEqual({
      error_code: 'x',
      phase: 'y',
      next_action: 'z',
      remaining_atomic: '1',
      budget_atomic: '2',
    })
    expect(pickRefusalDetail(null)).toEqual({})
    expect(pickRefusalDetail(undefined)).toEqual({})
  })

  it('classifyRevertForLedger: expiry text -> delegation_expired, other reverts -> onchain_revert, infrastructure -> null', () => {
    expect(classifyRevertForLedger(
      new Error("before execution's timestamp is before this caveat's beforeThreshold"),
    )).toBe('delegation_expired')
    // Wrapped one level (viem wraps the contract error as cause).
    expect(classifyRevertForLedger(
      new EstimateGasExecutionError(
        Object.assign(new Error('Caption: TimestampEnforcer.beforeThreshold reverted'), {
          shortMessage: 'Caption: TimestampEnforcer.beforeThreshold reverted',
        }) as never,
        {},
      ),
    )).toBe('delegation_expired')
    expect(classifyRevertForLedger(
      new EstimateGasExecutionError(
        Object.assign(new Error('ERC20PeriodTransferEnforcer:transfer-amount-exceeded'), {
          shortMessage: 'ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
        }) as never,
        {},
      ),
      // The period-budget enforcer's own custom error names the refusal, and
      // the classifier resolves it to the SAME value the x402 pre-checks use:
      // the direct POST /payments route has no pre-check, so this revert IS
      // its over-budget answer. The `onchain_revert` bucket stays what the
      // issue says it is — rare since #2706.
    )).toBe('delegation_budget_exceeded')
    // The timestamp enforcer's custom-error spelling (the shape QA evidence
    // carries: `TimestampEnforcer:expired-delegation`).
    expect(classifyRevertForLedger(new Error('TimestampEnforcer:expired-delegation'))).toBe(
      'delegation_expired',
    )
    expect(classifyRevertForLedger(new Error('redemption UserOp included but reverted'))).toBe('onchain_revert')
    // NOT refusals — the guardrails refused nothing; the infrastructure broke.
    expect(classifyRevertForLedger(new Error('DELEGATION_RAIL_BUNDLER_URL is not configured'))).toBeNull()
    expect(classifyRevertForLedger(new Error('fetch failed'))).toBeNull()
    expect(classifyRevertForLedger(null)).toBeNull()
  })
})
