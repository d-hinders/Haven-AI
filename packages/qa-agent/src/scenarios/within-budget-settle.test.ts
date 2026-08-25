/**
 * The assertions that stop the re-based `within-budget-settle` passing
 * vacuously (#2016).
 *
 * This leg is also the suite's positive control — the one that proves the money
 * path can still say YES — so a version of it that could pass without a
 * settlement would quietly disarm its two over-budget siblings as well.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockGetAllowances, mockCreatePayment, mockSignPayment, mockPoll, mockSign } = vi.hoisted(() => ({
  mockGetAllowances: vi.fn(),
  mockCreatePayment: vi.fn(),
  mockSignPayment: vi.fn(),
  mockPoll: vi.fn(),
  mockSign: vi.fn(),
}))

vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    getAllowances = mockGetAllowances
    createPayment = mockCreatePayment
    signPayment = mockSignPayment
    pollUntilSettled = mockPoll
  },
}))
vi.mock('@haven_ai/sdk', () => ({ signUserOpTypedDataForDelegation: mockSign }))

const { withinBudgetSettle } = await import('./within-budget-settle.js')

const ctx = {
  cfg: {
    apiUrl: 'https://dev.example',
    paymentTo: '0x' + 'cc'.repeat(20),
    delegationAgentApiKey: 'sk_delegation',
    delegationDelegateKey: '0x' + '22'.repeat(32),
  },
} as unknown as ScenarioContext

const TYPED = { domain: {}, types: {}, primaryType: 'PackedUserOperation', message: {} }
const OFFERED = {
  ok: true, status: 201,
  data: { payment_id: 'pay_1', status: 'pending_signature', sign_data: { hash: '0xh', signature_scheme: 'eip712_userop', typed_data: TYPED } },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSign.mockResolvedValue('0xsig')
  mockGetAllowances.mockResolvedValue({
    ok: true, status: 200,
    data: { allowances: [{ token_symbol: 'USDC', configured_amount: '1.00', onchain: { remaining: '1000000', remaining_is_from_chain: true } }] },
  })
  mockCreatePayment.mockResolvedValue(OFFERED)
  mockSignPayment.mockResolvedValue({ ok: true, status: 200, data: {} })
  mockPoll.mockResolvedValue({ status: 'confirmed', tx_hash: '0xdeadbeef' })
})

describe('within-budget-settle, re-based onto the delegation rail', () => {
  it('passes on a confirmed on-chain settlement', async () => {
    const r = await withinBudgetSettle.run(ctx)
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('0xdeadbeef')
  })

  it('signs the typed data client-side with the DELEGATION delegate key', async () => {
    await withinBudgetSettle.run(ctx)
    expect(mockSign).toHaveBeenCalledWith(ctx.cfg.delegationDelegateKey, TYPED)
  })

  it('FAILS on the rail-retirement 410 instead of reporting a settle defect', async () => {
    mockCreatePayment.mockResolvedValue({
      ok: false, status: 410,
      data: { error: 'The Safe rail is retired — this account can no longer pay.' },
    })
    const r = await withinBudgetSettle.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not return a signable intent/)
  })

  it('FAILS when the intent comes back on the LEGACY raw-hash scheme', async () => {
    // The rail is a property of the account; a raw-hash intent means this leg
    // is not exercising the rail it says it is.
    mockCreatePayment.mockResolvedValue({
      ok: true, status: 201,
      data: { payment_id: 'p', sign_data: { hash: '0xh', signature_scheme: 'raw_hash', typed_data: TYPED } },
    })
    const r = await withinBudgetSettle.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/eip712_userop/)
  })

  it('FAILS when the payment never reaches confirmed', async () => {
    mockPoll.mockResolvedValue({ status: 'failed', error_message: 'reverted' })
    const r = await withinBudgetSettle.run(ctx)
    expect(r.pass).toBe(false)
  })

  it('FAILS when confirmed arrives with no tx hash', async () => {
    mockPoll.mockResolvedValue({ status: 'confirmed' })
    const r = await withinBudgetSettle.run(ctx)
    expect(r.pass).toBe(false)
  })

  it('reports budget exhaustion as a precondition, not as a settlement failure', async () => {
    mockGetAllowances.mockResolvedValue({
      ok: true, status: 200,
      data: { allowances: [{ token_symbol: 'USDC', onchain: { remaining: '5', remaining_is_from_chain: true } }] },
    })
    const r = await withinBudgetSettle.run(ctx)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/budget exhaustion, not a settlement failure/)
  })

  it('SKIPS, not passes, without the delegation identity', async () => {
    const bare = { cfg: { ...ctx.cfg, delegationDelegateKey: undefined } } as unknown as ScenarioContext
    const r = await withinBudgetSettle.run(bare)
    expect(r.skipped).toBe(true)
  })
})
