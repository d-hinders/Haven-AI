import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockSign, mockProve, mockWaitDisabled, mockReadBudget, mockBlock } = vi.hoisted(() => ({
  mockBlock: vi.fn(),
  mockSign: vi.fn(),
  mockProve: vi.fn(),
  mockWaitDisabled: vi.fn(),
  mockReadBudget: vi.fn(),
}))
vi.mock('@haven_ai/sdk', () => ({ signUserOpTypedDataForDelegation: mockSign }))
vi.mock('../lib/chain.js', async (original) => ({
  ...(await original<typeof import('../lib/chain.js')>()),
  proveUsdcTransfer: mockProve,
  waitForDisabled: mockWaitDisabled,
  observerProvider: () => ({ getBlockNumber: mockBlock }),
}))
vi.mock('../lib/delegation-budget.js', async (original) => ({
  ...(await original<typeof import('../lib/delegation-budget.js')>()),
  readOnchainDelegationBudget: mockReadBudget,
}))

const { subBudgetRedemption, TIMING } = await import('./sub-budget-redemption.js')
TIMING.pollIntervalMs = 1
TIMING.catchUpWaitMs = 200
const API = 'https://api.example'
const TREASURY_A = '0x' + '11'.repeat(20)
const TREASURY_STANDING = '0x' + '22'.repeat(20)
const TD = (hash: string) => ({ domain: {}, types: { X: [] }, message: { hash } })
const ctx = {
  cfg: {
    apiUrl: API,
    paymentTo: TREASURY_STANDING,
    delegationAgentApiKey: 'sk-standing',
    delegationDelegateKey: '0x' + '33'.repeat(32),
  },
} as ScenarioContext

type Options = {
  refusalStatus?: number
  refusalBody?: Record<string, unknown>
  missingTransferAt?: number
  signContext500?: boolean
  postShapeContext?: boolean
}

function installApi(options: Options = {}) {
  let agents = 0
  let payments = 0
  let grantContexts = 0
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  // The live GET /sub-budgets/:id/sign-context is FLAT (typed_data at the top level).
  const ctxBody = (typedData: unknown) => options.postShapeContext
    ? { sub_budget_id: 'x', sign_data: { typed_data: typedData } }
    : { sub_budget_id: 'x', purpose: 'open', sub_budget_sign_context_version: 1, typed_data: typedData }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(API, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path, body })
    const out = (status: number, value: unknown) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json' },
    })

    if (path === '/auth/signup') return out(201, { token: 'jwt-owner' })
    if (path === '/accounts/hybrid') return out(201, {})
    if (path === '/auth/me') return out(200, { accounts: [{ id: 'acct', account_address: TREASURY_A, account_type: 'delegator_hybrid' }] })
    if (path === '/agents' && method === 'POST') {
      agents += 1
      return out(201, { id: agents === 1 ? 'agent-a' : 'agent-b', api_key: agents === 1 ? 'sk-a' : 'sk-b' })
    }
    if (path === '/agents/agent-a/delegations/build') {
      return out(201, { delegation_hash: '0xroot', signing_payload: TD('root') })
    }
    if (path === '/agents/agent-a/delegations/0xroot/activate') return out(200, { activated: true })
    if (/^\/agents\/agent-[ab]\/revoke$/.test(path)) return out(200, {})
    if (path === '/machine-payments/agent') return out(200, { account_address: TREASURY_STANDING })

    if (path === '/payments' && method === 'POST') {
      payments += 1
      if (payments === 4) {
        return out(options.refusalStatus ?? 403, options.refusalBody ?? {
          error: 'Delegation budget exceeded',
          error_code: 'delegation_budget_exceeded',
          remaining_atomic: '2000',
        })
      }
      return out(201, { payment_id: `pay-${payments}`, sign_data: { typed_data: TD(`pay-${payments}`) } })
    }
    if (/^\/payments\/pay-\d+\/sign$/.test(path)) return out(200, { status: 'confirmed', tx_hash: `0xtx${payments}` })

    if (path === '/agents/agent-a/sub-budgets' && method === 'POST') {
      return out(201, {
        sub_budget: { id: 'grant-id', delegation_hash: '0xgrant' },
        parent_child_sub_budget: { id: 'parent-id', delegation_hash: '0xparent' },
      })
    }
    if (path === '/sub-budgets/parent-id/sign-context') return out(200, ctxBody(TD('parent')))
    if (path === '/sub-budgets/grant-id/sign-context') {
      grantContexts += 1
      if (grantContexts === 1 && options.signContext500) return out(500, { error: 'sign context exploded' })
      return out(200, ctxBody(TD(grantContexts === 1 ? 'grant' : 'close')))
    }
    if (/^\/agents\/agent-a\/sub-budgets\/(parent-id|grant-id)\/sign$/.test(path)) {
      return out(200, { status: 'open' })
    }
    if (path === '/sub-budgets/grant-id/close') return out(200, { sign_data: { typed_data: TD('ignored-close') } })
    if (path === '/sub-budgets/grant-id/submit') return out(200, { status: 'closed', close_tx_hash: '0xclose' })
    throw new Error(`unexpected ${method} ${path}`)
  }))
  return calls
}

beforeEach(() => {
  mockSign.mockReset().mockResolvedValue('0x' + 'aa'.repeat(65))
  let block = 0
  mockBlock.mockReset().mockImplementation(async () => block++)
  mockProve.mockReset().mockResolvedValue({ ok: true })
  mockWaitDisabled.mockReset().mockResolvedValue({ ok: true })
  mockReadBudget.mockReset().mockImplementation(async (_chain: number, hash: string) => ({
    remaining: hash === '0xroot' ? 8_000n : 2_000n,
    configured: hash === '0xroot' ? '10000' : '3000',
  }))
})

describe('sub-budget redemption', () => {
  it('pins issue/payment bodies, reads all three hashes, proves Transfer, and accepts the exact 403', async () => {
    const calls = installApi()
    const result = await subBudgetRedemption.run(ctx)
    expect(result.pass).toBe(true)
    expect(calls.find((c) => c.path === '/agents/agent-a/sub-budgets')?.body).toMatchObject({
      sub_agent_id: 'agent-b', period_amount_atomic: '3000', recipient_address: TREASURY_STANDING,
    })
    const bPayments = calls.filter((c) => c.path === '/payments' && c.body?.sub_budget_id === 'grant-id')
    expect(bPayments.map((c) => c.body?.amount)).toEqual(['0.001', '0.002001'])
    expect(mockReadBudget.mock.calls.map((call) => call[1])).toEqual(['0xgrant', '0xparent', '0xroot'])
    expect(mockProve).toHaveBeenNthCalledWith(2, '0xtx3', {
      from: TREASURY_A, to: TREASURY_STANDING, amount: 1_000n,
    }, expect.anything())
    expect(mockWaitDisabled).toHaveBeenCalledWith('0xgrant', expect.anything())
  })

  it('fails on wrong remaining_atomic and names both causes for a 502', async () => {
    installApi({ refusalBody: {
      error: 'Delegation budget exceeded', error_code: 'delegation_budget_exceeded', remaining_atomic: '1999',
    } })
    expect((await subBudgetRedemption.run(ctx)).detail).toMatch(/does not equal grant live remaining/)

    installApi({ refusalStatus: 502, refusalBody: { error: 'execution reverted' } })
    const reverted = await subBudgetRedemption.run(ctx)
    expect(reverted.pass).toBe(false)
    expect(reverted.detail).toMatch(/read failed or lagged/)
    expect(reverted.detail).toMatch(/enforcer refused/)
  })

  it('fails when an exact Transfer is missing or a sign-context read returns 500', async () => {
    installApi()
    mockProve
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'missing Transfer' })
    expect((await subBudgetRedemption.run(ctx)).detail).toMatch(/B redemption has no exact Transfer/)

    mockProve.mockResolvedValue({ ok: true })
    installApi({ signContext500: true })
    expect((await subBudgetRedemption.run(ctx)).detail).toMatch(/sign-context failed \(500\)/)
  })

  it('waits for the observer to reflect B\'s payment before sending the refusal, and fails if it never does', async () => {
    installApi()
    let grantReads = 0
    mockReadBudget.mockImplementation(async (_chain: number, hash: string) => {
      if (hash === '0xroot') return { remaining: 8_000n, configured: '10000' }
      if (hash === '0xgrant') grantReads += 1
      return { remaining: hash === '0xgrant' && grantReads === 1 ? 3_000n : 2_000n, configured: '3000' }
    })
    expect((await subBudgetRedemption.run(ctx)).pass).toBe(true)
    expect(grantReads).toBeGreaterThanOrEqual(2)
    expect(mockBlock.mock.calls.length).toBeGreaterThanOrEqual(3)

    installApi()
    mockReadBudget.mockImplementation(async (_c: number, hash: string) => ({
      remaining: hash === '0xroot' ? 8_000n : 3_000n, configured: '3000',
    }))
    const stale = await subBudgetRedemption.run(ctx)
    expect(stale.pass).toBe(false)
    expect(stale.detail).toMatch(/never saw B's 0.001 USDC reflected/)
  })

  it('does NOT accept the POST shape (sign_data wrapper) from sign-context', async () => {
    installApi({ postShapeContext: true })
    const result = await subBudgetRedemption.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/sign-context failed \(200\)/)
  })
})
