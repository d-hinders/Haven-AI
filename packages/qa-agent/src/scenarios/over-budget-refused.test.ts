/**
 * The assertions that stop `over-budget-refused` and `x402-over-budget-rejected`
 * passing vacuously (#2016).
 *
 * These two legs replace one that reported PASS on the Safe rail's RETIREMENT
 * refusal instead of on the budget check — a green that would have survived
 * deleting over-budget enforcement outright. Every case below feeds a leg a
 * refusal it must NOT accept as proof.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockGetAllowances, mockCreatePayment, mockAuthorizeX402, mockGetAgent } = vi.hoisted(() => ({
  mockGetAllowances: vi.fn(),
  mockCreatePayment: vi.fn(),
  mockAuthorizeX402: vi.fn(),
  mockGetAgent: vi.fn(),
}))

vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    getAllowances = mockGetAllowances
    createPayment = mockCreatePayment
    authorizeX402 = mockAuthorizeX402
    getAgent = mockGetAgent
  },
}))

const { overBudgetRefused } = await import('./over-budget-refused.js')
const { x402OverBudgetRejected } = await import('./x402-over-budget-rejected.js')

const DELEGATE = '0x' + 'a3'.repeat(20)
const MERCHANT = '0x' + 'cc'.repeat(20)

/** The verbatim shape dev returns for an over-budget refusal (2026-08-25). */
const ENFORCER_502 = {
  ok: false,
  status: 502,
  data: {
    error: 'Delegation-rail authorization failed (on-chain policy or bundler)',
    details:
      'UserOperation reverted during simulation with reason: 0x08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000034' +
      '4552433230506572696f645472616e73666572456e666f726365723a7472616e736665722d616d6f756e742d65786365656465' +
      '6400000000000000000000000000',
  },
}

/** The refusal the OLD leg was accepting as proof (#1986's retirement 410). */
const RETIREMENT_410 = {
  ok: false,
  status: 410,
  data: { error: 'The Safe rail is retired — this account can no longer pay.', error_code: 'rail_retired' },
}

const SIGNABLE = {
  ok: true,
  status: 201,
  data: {
    payment_id: 'pay_control',
    status: 'pending_signature',
    sign_data: { hash: '0xabc', signature_scheme: 'eip712_userop', typed_data: { domain: {}, types: {}, primaryType: 'x', message: {} } },
  },
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
  vi.clearAllMocks()
  mockGetAgent.mockResolvedValue({ ok: true, status: 200, data: { delegate_address: DELEGATE } })
  mockGetAllowances.mockResolvedValue(allowances('1000000'))
})

describe('over-budget-refused (POST /payments)', () => {
  it('PASSES on the live enforcer refusal, naming the enforcer', async () => {
    // The positive control for the whole file: without this, every red below
    // is also consistent with a leg that can never pass at all.
    mockCreatePayment.mockResolvedValueOnce(SIGNABLE).mockResolvedValueOnce(ENFORCER_502)
    const r = await overBudgetRefused.run(ctx)
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')
  })

  it('asks for an amount ACTUALLY above the live remaining budget', async () => {
    mockCreatePayment.mockResolvedValueOnce(SIGNABLE).mockResolvedValueOnce(ENFORCER_502)
    await overBudgetRefused.run(ctx)
    // remaining 1000000 atomic (1 USDC) → the over-budget ask must exceed it.
    const [, overAmount] = mockCreatePayment.mock.calls[1]
    expect(Number(overAmount)).toBeGreaterThan(1)
  })

  it('FAILS on the rail-retirement 410 — the defect this leg replaces', async () => {
    mockCreatePayment.mockResolvedValueOnce(SIGNABLE).mockResolvedValueOnce(RETIREMENT_410)
    const r = await overBudgetRefused.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/expected HTTP 502/)
  })

  it('FAILS on a 502 that is a bundler failure, not a policy refusal', async () => {
    mockCreatePayment
      .mockResolvedValueOnce(SIGNABLE)
      .mockResolvedValueOnce({ ok: false, status: 502, data: { error: 'x', details: 'fetch failed: ECONNREFUSED bundler' } })
    const r = await overBudgetRefused.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not come from a caveat enforcer/)
  })

  it('FAILS when the over-budget request IS offered as a signable intent', async () => {
    // Delete the enforcement and this is what happens. It must be red.
    mockCreatePayment.mockResolvedValueOnce(SIGNABLE).mockResolvedValueOnce(SIGNABLE)
    const r = await overBudgetRefused.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/produced a signable intent/)
  })

  it('FAILS when the within-budget control is NOT offered', async () => {
    // An account that can pay nothing would refuse the over-budget request
    // too — and the leg must refuse to read that as budget enforcement.
    mockCreatePayment.mockResolvedValueOnce(RETIREMENT_410).mockResolvedValueOnce(ENFORCER_502)
    const r = await overBudgetRefused.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/control: a within-budget payment was NOT offered/)
  })

  it('FAILS rather than guessing when the budget read is a FALLBACK', async () => {
    mockGetAllowances.mockResolvedValue(allowances('1000000', false))
    const r = await overBudgetRefused.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/FALLBACK/)
  })

  it('FAILS rather than passing when the budget is already exhausted', async () => {
    mockGetAllowances.mockResolvedValue(allowances('0'))
    const r = await overBudgetRefused.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/exhausted/)
  })

  it('SKIPS, not passes, without the delegation identity', async () => {
    const bare: ScenarioContext = { cfg: { ...ctx.cfg, delegationAgentApiKey: undefined } }
    const r = await overBudgetRefused.run(bare)
    expect(r.skipped).toBe(true)
  })
})

describe('x402-over-budget-rejected (POST /x402/authorize)', () => {
  it('PASSES on the live enforcer refusal, naming the enforcer', async () => {
    mockAuthorizeX402.mockResolvedValue({
      ...ENFORCER_502,
      data: { ...ENFORCER_502.data, error: 'Delegation-rail funding authorization failed (on-chain policy or bundler)' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('ERC20PeriodTransferEnforcer:transfer-amount-exceeded')
  })

  it('drives the EIP-3009 funding shape, not erc7710', async () => {
    // The shape IS the scheme. On erc7710 an over-budget authorize returns a
    // signable child delegation (verified live 2026-08-25), so a leg that
    // drifted to that shape would be asserting something false.
    mockAuthorizeX402.mockResolvedValue(ENFORCER_502)
    await x402OverBudgetRejected.run(ctx)
    const [body] = mockAuthorizeX402.mock.calls[0]
    expect(body.payTo.toLowerCase()).toBe(DELEGATE.toLowerCase())
    expect(body.merchantPayTo).toBe(MERCHANT)
    expect(body.settlementScheme).toBe('eip3009')
  })

  it('FAILS on the rail-retirement 410 — the exact false green from 2026-08-25', async () => {
    // This is the regression test for the bug. The OLD leg returned PASS here.
    mockAuthorizeX402.mockResolvedValue(RETIREMENT_410)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
  })

  it('FAILS on any other rejection that is not the budget check', async () => {
    mockAuthorizeX402.mockResolvedValue({
      ok: false, status: 403,
      data: { error: 'Agent has no active budget delegation for USDC to this merchant' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
  })

  it('FAILS on a 502 that is a bundler failure, not a policy refusal', async () => {
    // Reaches the enforcer check specifically. Without this case the status
    // guard above SHADOWS it and the enforcer assertion survives deletion —
    // measured, not assumed: mutation M8 survived until this test existed.
    mockAuthorizeX402.mockResolvedValue({
      ok: false, status: 502,
      data: { error: 'Delegation-rail funding authorization failed (on-chain policy or bundler)', details: 'AA31 paymaster deposit too low' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not come from a caveat enforcer/)
  })

  it('FAILS when the over-budget authorize IS turned into a signable intent', async () => {
    mockAuthorizeX402.mockResolvedValue({
      ok: true, status: 201,
      data: { payment_id: 'x_1', status: 'pending_signature', sign_data: { signature_scheme: 'eip712_delegation' } },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/signable intent/)
  })

  it('FAILS rather than guessing when the budget read is a FALLBACK', async () => {
    mockGetAllowances.mockResolvedValue(allowances('1000000', false))
    mockAuthorizeX402.mockResolvedValue(ENFORCER_502)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/FALLBACK/)
  })
})
