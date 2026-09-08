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

// Mirrors the scenario's own constants, so the fixture's `asset`/`network`
// are the values a real run would carry rather than plausible-looking ones.
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const NETWORK = 'eip155:84532'
const DELEGATE = '0x' + 'a3'.repeat(20)
const MERCHANT = '0x' + 'cc'.repeat(20)

/**
 * The verbatim shape dev returns for an over-budget refusal on the DIRECT
 * payment path (2026-08-25). Still current: `over-budget-refused` reaches the
 * chain, so the enforcer still answers it.
 */
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

/**
 * The typed 403 the x402 EIP-3009 funding leg returns since #2706 (PR #2719),
 * which refuses at a pre-check BEFORE any prepare. Field-for-field the erc7710
 * body; `merchant_address` carries merchantPayTo, since payTo is the funding
 * target on this shape.
 */
const PRECHECK_403 = {
  ok: false,
  status: 403,
  data: {
    error:
      "This x402 payment of 2.00 USDC exceeds the agent's remaining budget for this period " +
      '(1.00 USDC, short by 1.00). There is no approval queue on the delegation rail — an ' +
      'over-budget redemption reverts on-chain. Ask the wallet owner to grant or raise the ' +
      'budget in Haven, then retry.',
    error_code: 'delegation_budget_exceeded',
    // The taxonomy's values, read out of `agent-payment-taxonomy.ts`, not
    // invented: an earlier draft of this fixture carried `phase: 'authorize'`
    // and `next_action: 'ask_owner_to_raise_budget'`, neither of which exists
    // anywhere in the enum. Nothing asserts on them — which is exactly why a
    // fixture that calls itself verbatim has to be.
    phase: 'insufficient_funds',
    next_action: 'fund_safe_or_raise_allowance',
    rail: 'x402',
    chain_id: 84532,
    token: 'USDC',
    asset: USDC,
    network: NETWORK,
    amount: '2.00',
    amount_atomic: '2000000',
    remaining: '1.00',
    remaining_atomic: '1000000',
    shortfall: '1.00',
    shortfall_atomic: '1000000',
    resource_url: 'https://example.test/resource',
    merchant_address: MERCHANT.toLowerCase(),
  },
}

/**
 * A within-budget authorize, offered as signable — the control this leg gained
 * in #2738. `eip712_userop` is what the 3009 FUNDING leg returns
 * (`delegation-authorize.ts`); erc7710 returns `eip712_delegation`. The two are
 * distinguishable, and the leg now checks, so this fixture must carry the 3009
 * value or the control test would be asserting the sibling's shape.
 */
const OFFERED = {
  ok: true,
  status: 201,
  data: { payment_id: 'x_ok', status: 'pending_signature', sign_data: { signature_scheme: 'eip712_userop' } },
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
  // `clearAllMocks` clears CALLS, not queued `mockResolvedValueOnce` values. A
  // case that returns early on a precondition leaves its queue unconsumed, and
  // the next case silently reads it as its own responses — measured: the
  // restored FALLBACK case below made the signable-intent case pass on the
  // leftovers. `mockReset` empties the queue.
  mockAuthorizeX402.mockReset()
  mockCreatePayment.mockReset()
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
  // Every case feeds the CONTROL first (a within-budget authorize that must be
  // offered) and the refusal second, because the leg makes two calls since
  // #2738. A single-call mock would satisfy the control with the refusal and
  // then run out.
  const then = (refusal: unknown) =>
    mockAuthorizeX402.mockResolvedValueOnce(OFFERED).mockResolvedValueOnce(refusal)

  it('PASSES on the typed 403 pre-check, naming the error_code', async () => {
    // The positive control for this half of the file: without it every red
    // below is also consistent with a leg that can never pass at all.
    then(PRECHECK_403)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('delegation_budget_exceeded')
    expect(r.detail).toContain('control that WAS offered')
  })

  it('drives the EIP-3009 funding shape, not erc7710', async () => {
    // The shape IS the scheme. On erc7710 an over-budget authorize returns a
    // signable child delegation (verified live 2026-08-25), so a leg that
    // drifted to that shape would be asserting something false. Checked on the
    // REFUSAL call, not the control, since that is the one under test.
    then(PRECHECK_403)
    await x402OverBudgetRejected.run(ctx)
    const [body] = mockAuthorizeX402.mock.calls[1]
    expect(body.payTo.toLowerCase()).toBe(DELEGATE.toLowerCase())
    expect(body.merchantPayTo).toBe(MERCHANT)
    expect(body.settlementScheme).toBe('eip3009')
  })

  it('asks for an amount ACTUALLY above the live remaining budget', async () => {
    then(PRECHECK_403)
    await x402OverBudgetRejected.run(ctx)
    const [control] = mockAuthorizeX402.mock.calls[0]
    const [over] = mockAuthorizeX402.mock.calls[1]
    // remaining is 1000000 atomic (1 USDC): the control must sit under it and
    // the ask above it, or neither call is testing what it claims.
    expect(Number(control.amount)).toBeLessThan(1000000)
    expect(Number(over.amount)).toBeGreaterThan(1000000)
  })

  it('FAILS when the CONTROL is not offered — a backend refusing everything proves nothing', async () => {
    // #2738. Without this the 403 assertion below is satisfied by a dead
    // merchant URL, a retired rail or a revoked delegation, none of which is
    // the budget check. This is the same class as the 2026-08-25 false green,
    // arriving through the control rather than through the refusal.
    mockAuthorizeX402.mockResolvedValue(PRECHECK_403)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/control: a within-budget 3009 authorize was NOT offered/)
  })

  it('FAILS when the control was dispatched to erc7710, not the 3009 funding leg', async () => {
    // #2738, and this case exists because the guard SURVIVED its first
    // mutation: I added the signature_scheme check and nothing reddened when I
    // removed it again.
    //
    // The failure it pins is real. A dispatch regression routing a
    // `settlementScheme: 'eip3009'` request onto the erc7710 branch passes
    // twice over: the control gets a signable CHILD delegation, and the
    // over-budget call hits the erc7710 pre-check on the SAME delegation, so
    // `error_code` and `remaining_atomic` both match. The leg would report
    // green having never touched the funding path it names.
    mockAuthorizeX402
      .mockResolvedValueOnce({
        ...OFFERED,
        data: { ...OFFERED.data, sign_data: { signature_scheme: 'eip712_delegation' } },
      })
      .mockResolvedValueOnce(PRECHECK_403)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not select the 3009 funding leg/)
  })

  it('FAILS on the rail-retirement 410 — the exact false green from 2026-08-25', async () => {
    then(RETIREMENT_410)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
  })

  it('FAILS on a 403 that is a MISSING delegation, not the budget check', async () => {
    // The reason the typed `error_code` is asserted rather than the status. A
    // revoked or absent delegation refuses with 403 too, and reading that as
    // proof would mean an agent with NO budget at all reports the budget check
    // working.
    then({
      ok: false,
      status: 403,
      data: { error: 'Agent has no active budget delegation for USDC to this merchant' },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not come from the budget pre-check/)
  })

  it('FAILS when the refusal reports a budget other than the live one', async () => {
    // A pre-check reading a stale or different delegation refuses correctly by
    // accident, and would stay green after the delegation it consults drifts
    // away from the one the agent actually spends against.
    then({ ...PRECHECK_403, data: { ...PRECHECK_403.data, remaining_atomic: '999' } })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/consulted a different delegation/)
  })

  it('FAILS on the pre-#2719 enforcer 502 — the pre-check no longer runs', async () => {
    // Deliberately red. Since #2706 the refusal happens BEFORE prepare, so a
    // 502 carrying the enforcer's revert reason means the pre-check was
    // bypassed, deleted, OR failed open on a degraded budget read — all three
    // reach gas estimation, and only the first two are regressions. The leg's
    // own failure text names both causes for exactly that reason. The
    // enforcer's own guarantee is not lost either way: `over-budget-refused`
    // still drives the chain path and still asserts the revert reason.
    then(ENFORCER_502)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/expected HTTP 403/)
    // The two-cause suffix, pinned rather than trusted: it exists so a flapping
    // RPC is not triaged as a deleted pre-check, and an unpinned message is how
    // this leg's `invariant:` string went stale in the first place.
    expect(r.detail).toMatch(/failed OPEN to prepare/)
  })

  it('FAILS rather than guessing when the budget read is a FALLBACK', async () => {
    // Restored: this case was dropped when the leg moved to the two-call shape,
    // and review measured the loss — deleting the scenario's
    // `if ('error' in budget)` precondition left 18/18 green with it gone, and
    // reddened on `dev` with it present. A leg that asks for "over budget"
    // against a GUESSED budget is asking for an arbitrary number.
    mockGetAllowances.mockResolvedValue(allowances('1000000', false))
    then(PRECHECK_403)
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/FALLBACK/)
  })

  it('FAILS when the over-budget authorize IS turned into a signable intent', async () => {
    then({
      ok: true, status: 201,
      data: { payment_id: 'x_1', status: 'pending_signature', sign_data: { signature_scheme: 'eip712_delegation' } },
    })
    const r = await x402OverBudgetRejected.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/signable intent/)
  })
})
