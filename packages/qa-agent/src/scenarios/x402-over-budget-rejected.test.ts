/**
 * The assertions that stop `x402-over-budget-rejected` passing vacuously, and
 * that pin BOTH refusals #2706 made legitimate on this leg.
 *
 * ## Why this file exists at all
 *
 * Its erc7710 sibling has had a unit test since #2082. This leg had none, and
 * that is not a coincidence in what happened next: #2706 changed the ordinary
 * over-budget answer on the 3009 funding leg from a 502 to a typed 403, the
 * scenario still asserted 502, and it went red on the deploy of that commit and
 * stayed red for four deploys (#2738) with nothing but the live QA run to say
 * so. A scenario nobody tests drifts silently from the product it watches.
 *
 * ## What each case is for
 *
 * The leg now accepts two outcomes, so the risk is no longer "asserts the wrong
 * status" but "accepts anything". Every case below feeds it a refusal it must
 * NOT accept: a 403 for a different reason, a 403 about a different budget, a
 * 502 that is a bundler outage rather than an enforcer, and a signable intent
 * dressed as a refusal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockGetAgent, mockGetAllowances, mockAuthorizeX402 } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockGetAllowances: vi.fn(),
  mockAuthorizeX402: vi.fn(),
}))

vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    getAgent = mockGetAgent
    getAllowances = mockGetAllowances
    authorizeX402 = mockAuthorizeX402
  },
}))

const { x402OverBudgetRejected } = await import('./x402-over-budget-rejected.js')

const DELEGATE = '0x' + 'de'.repeat(20)
const MERCHANT = '0x' + 'cc'.repeat(20)

/** Remaining budget the leg reads, and the amount it therefore asks for. */
const REMAINING = '1000000'

/** The verbatim shape #2706 returns for an over-budget 3009 funding authorize. */
const BUDGET_403 = {
  ok: false,
  status: 403,
  data: {
    error: "This x402 payment of 2.00 USDC exceeds the agent's remaining budget for this period",
    error_code: 'delegation_budget_exceeded',
    phase: 'insufficient_funds',
    next_action: 'fund_safe_or_raise_allowance',
    remaining_atomic: REMAINING,
    shortfall_atomic: '1000000',
  },
}

/**
 * A 502 whose `details` carry the ABI-encoded `Error(string)` payload for
 * `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` — the fail-open path.
 * Hex, not plain text, exactly as the bundler returns it (see revert-reason.ts).
 */
const enforcerHex = Buffer.from('ERC20PeriodTransferEnforcer:transfer-amount-exceeded', 'ascii')
  .toString('hex')
const ENFORCER_502 = {
  ok: false,
  status: 502,
  data: {
    error: 'Delegation-rail funding authorization failed (on-chain policy or bundler)',
    details: `UserOperation reverted during simulation with reason: 0x08c379a0${'00'.repeat(28)}${enforcerHex}`,
  },
}

/**
 * The allowances payload `readOnchainBudget` actually parses — `token_symbol`
 * plus a nested `onchain` reading, mirroring the sibling's fixture so the two
 * legs cannot drift apart in what they believe the API returns.
 */
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

const ctx = {
  cfg: {
    delegationAgentApiKey: 'k',
    paymentTo: MERCHANT,
    demoMerchantUrl: 'https://merchant.test/r',
  },
} as unknown as ScenarioContext

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAgent.mockResolvedValue({ ok: true, status: 200, data: { delegate_address: DELEGATE } })
  mockGetAllowances.mockResolvedValue(allowances(REMAINING))
})

describe('the two refusals it must accept', () => {
  it('passes on the typed 403 the pre-check returns since #2706', async () => {
    mockAuthorizeX402.mockResolvedValue(BUDGET_403)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/403 delegation_budget_exceeded/)
  })

  it('passes on the 502 the enforcer returns when the pre-check fails open', async () => {
    mockAuthorizeX402.mockResolvedValue(ENFORCER_502)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(true)
    // The detail must name the enforcer, not merely the status — a 502 alone
    // is what a bundler outage looks like too.
    expect(r.detail).toMatch(/ERC20PeriodTransferEnforcer:transfer-amount-exceeded/)
    expect(r.detail).toMatch(/failed open/)
  })

  it('drives the 3009 funding shape, not erc7710', async () => {
    mockAuthorizeX402.mockResolvedValue(BUDGET_403)
    await x402OverBudgetRejected.run(ctx)
    // payTo = the delegate EOA and merchantPayTo = the merchant IS the 3009
    // shape. If this leg ever drove payTo = merchant it would be asserting the
    // sibling's path and this scenario would prove nothing about the bridge.
    expect(mockAuthorizeX402).toHaveBeenCalledWith(
      expect.objectContaining({
        payTo: DELEGATE,
        merchantPayTo: MERCHANT,
        settlementScheme: 'eip3009',
      }),
    )
  })

  it('asks for an amount derived from the live budget, not a constant', async () => {
    mockAuthorizeX402.mockResolvedValue(BUDGET_403)
    await x402OverBudgetRejected.run(ctx)
    const { amount } = mockAuthorizeX402.mock.calls[0][0]
    expect(BigInt(amount)).toBeGreaterThan(BigInt(REMAINING))
  })
})

describe('the refusals it must NOT accept', () => {
  it('fails a 403 that is not the budget pre-check', async () => {
    // A revoked delegation refuses here too, and proves nothing about budget.
    mockAuthorizeX402.mockResolvedValue({
      ok: false,
      status: 403,
      data: { error: 'no active budget delegation' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not come from the budget pre-check/)
  })

  it('fails a 403 about a different budget than the one under test', async () => {
    mockAuthorizeX402.mockResolvedValue({
      ...BUDGET_403,
      data: { ...BUDGET_403.data, remaining_atomic: '999' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/consulted a different delegation/)
  })

  it('fails a 502 that is a bundler outage rather than an enforcer refusal', async () => {
    mockAuthorizeX402.mockResolvedValue({
      ok: false,
      status: 502,
      data: { error: 'Delegation-rail funding authorization failed', details: 'ECONNREFUSED' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not come from a caveat enforcer/)
  })

  it('fails a signable intent however it is dressed', async () => {
    // The #420 invariant is about signability, not the status code — a 403 that
    // still handed back sign_data would be the worst possible pass.
    mockAuthorizeX402.mockResolvedValue({
      ...BUDGET_403,
      data: { ...BUDGET_403.data, sign_data: { signature_scheme: 'eip712_delegation' } },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/signable intent/)
  })

  it('fails a rail-retirement 410, which refuses without consulting any budget', async () => {
    mockAuthorizeX402.mockResolvedValue({
      ok: false,
      status: 410,
      data: { error: 'The Safe rail is retired' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    // This is the exact vacuous pass #2016 was filed about.
    expect(r.detail).toMatch(/expected either 403/)
  })

  it('refuses to run at all when the budget read is a fallback', async () => {
    // Deriving "over budget" from a number the chain did not supply makes the
    // refusal unattributable — the leg must refuse rather than guess.
    mockGetAllowances.mockResolvedValue(allowances(REMAINING, false))
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(mockAuthorizeX402).not.toHaveBeenCalled()
  })
})
