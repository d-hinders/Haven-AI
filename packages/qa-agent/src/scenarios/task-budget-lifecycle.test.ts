import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockUserOpSign, mockWaitDisabled } = vi.hoisted(() => ({
  mockUserOpSign: vi.fn(),
  mockWaitDisabled: vi.fn(),
}))
vi.mock('@haven_ai/sdk', () => ({ signUserOpTypedDataForDelegation: mockUserOpSign }))
vi.mock('../lib/chain.js', async (original) => ({
  ...(await original<typeof import('../lib/chain.js')>()),
  waitForDisabled: mockWaitDisabled,
}))

const { taskBudgetLifecycle } = await import('./task-budget-lifecycle.js')
const API = 'https://api.example'
const TD = { domain: {}, types: { X: [] }, message: {} }
const ctx = { cfg: { apiUrl: API, paymentTo: '0x' + '55'.repeat(20) } } as ScenarioContext

type Options = { postShapeContext?: boolean; openContextStatus?: number; closeContextStatus?: number; closeHash?: boolean; disabled?: boolean }

function fakeApi(options: Options = {}) {
  let taskContextReads = 0
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(API, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    const out = (status: number, value: unknown) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json' },
    })
    if (path === '/auth/signup') return out(201, { token: 'jwt' })
    if (path === '/accounts/hybrid') return out(201, {})
    if (path === '/auth/me') return out(200, { accounts: [{ id: 'acct', account_address: '0x' + '11'.repeat(20), account_type: 'delegator_hybrid' }] })
    if (path === '/agents' && method === 'POST') return out(201, { id: 'agent-a', api_key: 'sk-a' })
    if (path === '/agents/agent-a/delegations/build') return out(201, { delegation_hash: '0xroot', signing_payload: TD })
    if (path === '/agents/agent-a/delegations/0xroot/activate') return out(200, { activated: true })
    if (path === '/agents/agent-a/revoke') return out(200, {})
    if (path === '/task-budgets' && method === 'POST') return out(201, {
      task_budget: { id: 'tb-1', delegation_hash: '0xtask' }, sign_data: { typed_data: { ignored: true } },
    })
    if (path === '/task-budgets/tb-1/sign-context') {
      taskContextReads += 1
      if (taskContextReads === 1 && options.openContextStatus) {
        return out(options.openContextStatus, { error: 'open context exploded' })
      }
      if (taskContextReads === 2 && options.closeContextStatus) {
        return out(options.closeContextStatus, { error: 'Do not know how to serialize a BigInt' })
      }
      return out(200, options.postShapeContext
        ? { task_budget_id: 'tb-1', sign_data: { typed_data: TD } }
        : { task_budget_id: 'tb-1', purpose: 'open', task_sign_context_version: 1, typed_data: TD, expected: {} })
    }
    if (path === '/task-budgets/tb-1/submit' && body?.signature) {
      return taskContextReads === 1
        ? out(200, { status: 'open' })
        : out(200, { status: 'closed', ...(options.closeHash === false ? {} : { close_tx_hash: '0xclose' }) })
    }
    if (path === '/task-budgets/tb-1/close') return out(200, { sign_data: { typed_data: TD } })
    throw new Error(`unexpected ${method} ${path}`)
  }))
  return calls
}

beforeEach(() => {
  mockUserOpSign.mockReset().mockResolvedValue('0x' + 'aa'.repeat(65))
  mockWaitDisabled.mockReset().mockResolvedValue({ ok: true })
})

describe('task-budget lifecycle', () => {
  it('uses GET sign-context for both open and close and proves the disable', async () => {
    const calls = fakeApi()
    const result = await taskBudgetLifecycle.run(ctx)
    expect(result.pass).toBe(true)
    expect(calls.filter((call) => call.path === '/task-budgets/tb-1/sign-context')).toHaveLength(2)
    expect(mockWaitDisabled).toHaveBeenCalledWith('0xtask', expect.anything())
  })

  it('fails on the pre-#3491 close sign-context 500 despite usable inline close bytes', async () => {
    fakeApi({ closeContextStatus: 500 })
    const result = await taskBudgetLifecycle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/close sign-context failed \(500\)/)
  })

  it('does NOT accept the POST shape (sign_data wrapper) from sign-context — the live endpoint is flat', async () => {
    fakeApi({ postShapeContext: true })
    const result = await taskBudgetLifecycle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/open sign-context failed \(200\)/)
  })

  it('fails when the open sign-context read errors', async () => {
    fakeApi({ openContextStatus: 500 })
    expect((await taskBudgetLifecycle.run(ctx)).detail).toMatch(/open sign-context failed \(500\)/)
  })

  it('fails without a close tx hash or without an on-chain disable', async () => {
    fakeApi({ closeHash: false })
    expect((await taskBudgetLifecycle.run(ctx)).detail).toMatch(/close_tx_hash/)
    fakeApi()
    mockWaitDisabled.mockResolvedValue({ ok: false, error: 'still enabled' })
    expect((await taskBudgetLifecycle.run(ctx)).detail).toMatch(/not disabled/)
  })
})
