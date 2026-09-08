/**
 * The assertions that stop `x402-over-budget-rejected` passing vacuously.
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
 * The leg's guarantee is a PAIR of claims — an over-budget call is refused by
 * the pre-check, AND a within-budget call on the same shape is still offered —
 * so the risk is not only "asserts the wrong status" but "reports green with
 * half of it deleted". Every case below feeds the leg something it must NOT
 * accept: a control that was never offered, a control dispatched onto the
 * erc7710 branch, a 403 for a different reason, a 403 about a different budget,
 * the fail-open 502, a rail-retirement 410, and a signable intent dressed as a
 * refusal.
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

/**
 * The within-budget control the leg sends FIRST. `eip712_userop` is what the
 * 3009 funding leg returns; the erc7710 branch returns `eip712_delegation`,
 * and telling them apart is the dispatch guard's whole job.
 */
const CONTROL_OFFERED = {
  ok: true,
  status: 201,
  data: { status: 'pending_signature', sign_data: { signature_scheme: 'eip712_userop' } },
}

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

/** The two authorize answers this leg makes, in the order it makes them. */
function authorizeReturns(control: unknown, over: unknown) {
  mockAuthorizeX402.mockResolvedValueOnce(control).mockResolvedValueOnce(over)
}

beforeEach(() => {
  // `mockReset`, not `clearAllMocks` — the same trap the sibling's beforeEach
  // records. Cases below make the leg return EARLY (a refused control, a
  // fallback budget read), leaving an unconsumed `mockResolvedValueOnce`
  // queued; `clearAllMocks` drains call history but NOT that queue, so the
  // leftover answers the next case's first call. Measured, not theorised:
  // with `clearAllMocks` five of these twelve asserted against the previous
  // test's fixture and failed for reasons that were not their own.
  mockGetAgent.mockReset()
  mockGetAllowances.mockReset()
  mockAuthorizeX402.mockReset()
  mockGetAgent.mockResolvedValue({ ok: true, status: 200, data: { delegate_address: DELEGATE } })
  mockGetAllowances.mockResolvedValue(allowances(REMAINING))
})

describe('what it must accept', () => {
  it('passes on the typed 403 the pre-check returns since #2706, against an offered control', async () => {
    authorizeReturns(CONTROL_OFFERED, BUDGET_403)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/403 delegation_budget_exceeded/)
  })

  it('drives the 3009 funding shape on BOTH calls, not erc7710', async () => {
    authorizeReturns(CONTROL_OFFERED, BUDGET_403)
    await x402OverBudgetRejected.run(ctx)
    // payTo = the delegate EOA and merchantPayTo = the merchant IS the 3009
    // shape. If this leg ever drove payTo = merchant it would be asserting the
    // sibling's path and this scenario would prove nothing about the bridge.
    // Both calls are checked: a control on one shape and a refusal on the other
    // is not a control at all.
    for (const [body] of mockAuthorizeX402.mock.calls) {
      expect(body).toMatchObject({
        payTo: DELEGATE,
        merchantPayTo: MERCHANT,
        settlementScheme: 'eip3009',
      })
    }
  })

  it('sends the control WITHIN budget and the probe ABOVE it', async () => {
    authorizeReturns(CONTROL_OFFERED, BUDGET_403)
    await x402OverBudgetRejected.run(ctx)
    const [[control], [over]] = mockAuthorizeX402.mock.calls
    // 1 atomic unit, not 0.001 USDC: `readOnchainBudget` only guarantees
    // remaining >= 1, so a larger control turns a nearly-exhausted budget into
    // a false red on the control instead of a result.
    expect(BigInt(control.amount)).toBeLessThanOrEqual(BigInt(REMAINING))
    expect(BigInt(over.amount)).toBeGreaterThan(BigInt(REMAINING))
  })

  it('asks for an amount DERIVED from the live budget, not a constant above it', async () => {
    // `> REMAINING` alone does not prove derivation: a hardcoded
    // '999999999999' satisfies it, and a hardcoded over-budget constant is
    // exactly the defect #2016 was filed about — it stops being over-budget
    // the moment the account, the rail or the seed changes, and the refusal
    // then proves nothing.
    //
    // So it is checked against the EXACT derivation, at two different budgets:
    // a constant cannot track both.
    for (const remaining of ['1000000', '4734500']) {
      mockGetAllowances.mockReset()
      mockAuthorizeX402.mockReset()
      mockGetAgent.mockResolvedValue({ ok: true, status: 200, data: { delegate_address: DELEGATE } })
      mockGetAllowances.mockResolvedValue(allowances(remaining))
      authorizeReturns(CONTROL_OFFERED, {
        ...BUDGET_403,
        data: { ...BUDGET_403.data, remaining_atomic: remaining },
      })
      await x402OverBudgetRejected.run(ctx)
      const [, [over]] = mockAuthorizeX402.mock.calls
      expect(over.amount).toBe((BigInt(remaining) + 1_000_000n).toString())
    }
  })
})

describe('what it must NOT accept', () => {
  it('fails when the within-budget control was never offered', async () => {
    // A backend refusing every x402 authorize — a misconfigured merchant URL,
    // a retired rail, a dead delegation — reads exactly like working
    // enforcement without this half.
    authorizeReturns({ ok: false, status: 500, data: { error: 'merchant unreachable' } }, BUDGET_403)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/control: a within-budget 3009 authorize was NOT offered/)
  })

  it('fails when the control was dispatched onto the erc7710 branch', async () => {
    // The double pass this guard exists for: the control gets a signable child
    // and the over-budget call hits the erc7710 pre-check on the SAME
    // delegation, so error_code and remaining_atomic both match and the leg
    // reports green having never touched the funding path.
    authorizeReturns(
      { ...CONTROL_OFFERED, data: { ...CONTROL_OFFERED.data, sign_data: { signature_scheme: 'eip712_delegation' } } },
      BUDGET_403,
    )
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not select the 3009 funding leg/)
  })

  it('fails a 403 that is not the budget pre-check', async () => {
    // A revoked delegation refuses here too, and proves nothing about budget.
    authorizeReturns(CONTROL_OFFERED, {
      ok: false,
      status: 403,
      data: { error: 'no active budget delegation' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not come from the budget pre-check/)
  })

  it('fails a 403 about a different budget than the one under test', async () => {
    authorizeReturns(CONTROL_OFFERED, {
      ...BUDGET_403,
      data: { ...BUDGET_403.data, remaining_atomic: '999' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/consulted a different delegation/)
  })

  it('fails the fail-open 502, and names both of its causes', async () => {
    // The 502 is legitimate — a degraded budget read makes the pre-check stand
    // aside and the enforcer refuse instead — but it is NOT this leg's claim,
    // and reading it as a regression when it is a flapping RPC costs a triage
    // cycle. The message has to carry both readings.
    authorizeReturns(CONTROL_OFFERED, {
      ok: false,
      status: 502,
      data: { error: 'Delegation-rail funding authorization failed', details: 'reverted' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/expected HTTP 403/)
    expect(r.detail).toMatch(/failed OPEN/)
  })

  it('fails a signable intent however it is dressed', async () => {
    // The #420 invariant is about signability, not the status code — a 403 that
    // still handed back sign_data would be the worst possible pass.
    authorizeReturns(CONTROL_OFFERED, {
      ...BUDGET_403,
      data: { ...BUDGET_403.data, sign_data: { signature_scheme: 'eip712_userop' } },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/signable intent/)
  })

  it('fails a rail-retirement 410, which refuses without consulting any budget', async () => {
    authorizeReturns(CONTROL_OFFERED, {
      ok: false,
      status: 410,
      data: { error: 'The Safe rail is retired' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    // This is the exact vacuous pass #2016 was filed about.
    expect(r.detail).toMatch(/expected HTTP 403/)
  })

  it('refuses to run at all when the budget read is a fallback', async () => {
    // Deriving "over budget" from a number the chain did not supply makes the
    // refusal unattributable — the leg must refuse rather than guess, and it
    // must do so before it spends an authorize.
    mockGetAllowances.mockResolvedValue(allowances(REMAINING, false))
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/FALLBACK/)
    expect(mockAuthorizeX402).not.toHaveBeenCalled()
  })
})
