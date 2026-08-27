/**
 * The assertions that stop `x402-erc7710-over-budget-rejected` passing
 * vacuously (#2082).
 *
 * Its 3009 sibling exists because a leg once reported PASS on the Safe rail's
 * RETIREMENT refusal instead of on the budget check — a green that would have
 * survived deleting over-budget enforcement outright (#2016). This leg asserts
 * a NEW refusal on a path that had none, which is exactly the situation where
 * "some error happened" is easiest to mistake for proof. Every case below
 * feeds it a refusal it must NOT accept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockGetAllowances, mockAuthorizeX402 } = vi.hoisted(() => ({
  mockGetAllowances: vi.fn(),
  mockAuthorizeX402: vi.fn(),
}))

vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    getAllowances = mockGetAllowances
    authorizeX402 = mockAuthorizeX402
  },
}))

const { x402Erc7710OverBudgetRejected } = await import('./x402-erc7710-over-budget-rejected.js')

const MERCHANT = '0x' + 'cc'.repeat(20)

/** The control: a within-budget erc7710 authorize, offered as signable. */
const SIGNABLE_ERC7710 = {
  ok: true,
  status: 201,
  data: {
    payment_id: 'x_control',
    status: 'pending_signature',
    sign_data: { signature_scheme: 'eip712_delegation' },
  },
}

/** The verbatim shape #2082 returns for an over-budget erc7710 authorize. */
const BUDGET_403 = {
  ok: false,
  status: 403,
  data: {
    error: "This x402 payment of 2.00 USDC exceeds the agent's remaining budget for this period",
    error_code: 'delegation_budget_exceeded',
    phase: 'insufficient_funds',
    next_action: 'fund_safe_or_raise_allowance',
    remaining_atomic: '1000000',
    shortfall_atomic: '1000000',
  },
}

/** The refusal a MISSING delegation produces — same status, different reason. */
const NO_DELEGATION_403 = {
  ok: false,
  status: 403,
  data: { error: 'Agent has no active budget delegation for USDC to this merchant' },
}

const RETIREMENT_410 = {
  ok: false,
  status: 410,
  data: { error: 'The Safe rail is retired — this account can no longer pay.', error_code: 'rail_retired' },
}

const ctx: ScenarioContext = {
  cfg: {
    apiUrl: 'https://dev.example',
    paymentTo: MERCHANT,
    delegationAgentApiKey: 'sk_delegation',
    delegationDelegateKey: '0x' + '22'.repeat(32),
    demoMerchantUrl: 'https://merchant.example',
  },
}

function allowances(remaining: string, fromChain = true) {
  return {
    ok: true,
    status: 200,
    data: {
      allowances: [
        {
          token_symbol: 'USDC',
          configured_amount: '1.00',
          onchain: { remaining, remaining_is_from_chain: fromChain },
        },
      ],
    },
  }
}

beforeEach(() => {
  // mockReset, not clearAllMocks: several cases below make the leg return
  // EARLY (a failed control), leaving an unconsumed mockResolvedValueOnce
  // queued. clearAllMocks drains call history but NOT that queue, so the
  // leftover answers the next test's first call — which is how the
  // wrong-scheme case first went red for a reason that was not its own.
  mockGetAllowances.mockReset()
  mockAuthorizeX402.mockReset()
  mockGetAllowances.mockResolvedValue(allowances('1000000'))
})

describe('x402-erc7710-over-budget-rejected (#2082)', () => {
  it('PASSES on the pre-check refusal, naming the remaining budget and shortfall', async () => {
    // The positive control for the file: without it, every red below is also
    // consistent with a leg that can never pass at all.
    mockAuthorizeX402.mockResolvedValueOnce(SIGNABLE_ERC7710).mockResolvedValueOnce(BUDGET_403)
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('delegation_budget_exceeded')
  })

  it('drives the erc7710 shape, not the 3009 funding leg', async () => {
    // The shape IS the scheme. A leg that drifted onto the funding shape would
    // be re-asserting what its sibling already covers and leaving this path
    // uncovered again — the exact gap #2082 closed.
    mockAuthorizeX402.mockResolvedValueOnce(SIGNABLE_ERC7710).mockResolvedValueOnce(BUDGET_403)
    await x402Erc7710OverBudgetRejected.run(ctx)
    const [body] = mockAuthorizeX402.mock.calls[1]
    expect(body.payTo).toBe(MERCHANT)
    expect(body.merchantPayTo).toBeUndefined()
    expect(body.settlementScheme).toBeUndefined()
  })

  it('asks for an amount ACTUALLY above the live remaining budget', async () => {
    mockAuthorizeX402.mockResolvedValueOnce(SIGNABLE_ERC7710).mockResolvedValueOnce(BUDGET_403)
    await x402Erc7710OverBudgetRejected.run(ctx)
    const [body] = mockAuthorizeX402.mock.calls[1]
    expect(BigInt(body.amount)).toBeGreaterThan(1_000_000n)
  })

  it('FAILS when the over-budget authorize IS turned into a signable intent', async () => {
    // Delete the pre-check and this is what dev returns. It must be red.
    mockAuthorizeX402.mockResolvedValue(SIGNABLE_ERC7710)
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/signable intent/)
  })

  it('FAILS on a 403 that is a MISSING delegation, not the budget check', async () => {
    // Same status, and the likeliest way this leg goes vacuously green: an
    // expired QA grant refuses every amount for a reason the leg never tested.
    mockAuthorizeX402.mockResolvedValueOnce(SIGNABLE_ERC7710).mockResolvedValueOnce(NO_DELEGATION_403)
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not come from the budget pre-check/)
  })

  it('FAILS on the rail-retirement 410', async () => {
    mockAuthorizeX402.mockResolvedValueOnce(SIGNABLE_ERC7710).mockResolvedValueOnce(RETIREMENT_410)
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/expected HTTP 403/)
  })

  it('FAILS when the refusal quotes a DIFFERENT budget than the one under test', async () => {
    mockAuthorizeX402
      .mockResolvedValueOnce(SIGNABLE_ERC7710)
      .mockResolvedValueOnce({ ...BUDGET_403, data: { ...BUDGET_403.data, remaining_atomic: '9999' } })
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/consulted a different delegation/)
  })

  it('FAILS when the within-budget control is NOT offered', async () => {
    // An account that can pay nothing would refuse the over-budget request
    // too — the leg must refuse to read that as budget enforcement.
    mockAuthorizeX402.mockResolvedValueOnce(NO_DELEGATION_403).mockResolvedValueOnce(BUDGET_403)
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/control: a within-budget erc7710 authorize was NOT offered/)
  })

  it('FAILS when the control came back on the 3009 scheme', async () => {
    // A dispatch regression that quietly routed erc7710 requests to the
    // funding leg would otherwise make this leg assert the sibling's path.
    mockAuthorizeX402
      .mockResolvedValueOnce({
        ...SIGNABLE_ERC7710,
        data: { ...SIGNABLE_ERC7710.data, sign_data: { signature_scheme: 'eip712_userop' } },
      })
      .mockResolvedValueOnce(BUDGET_403)
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not select erc7710/)
  })

  it('FAILS rather than guessing when the budget read is a FALLBACK', async () => {
    mockGetAllowances.mockResolvedValue(allowances('1000000', false))
    mockAuthorizeX402.mockResolvedValue(BUDGET_403)
    const r = await x402Erc7710OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/FALLBACK/)
  })

  it('SKIPS, not passes, without the delegation identity', async () => {
    const bare: ScenarioContext = { cfg: { ...ctx.cfg, delegationAgentApiKey: undefined } }
    const r = await x402Erc7710OverBudgetRejected.run(bare)
    expect(r.skipped).toBe(true)
  })
})
