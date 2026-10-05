/**
 * #3459 guard — every REAL throwaway-identity scenario (five: the two original
 * legs and the three #3505 budget legs) goes through the cleanup wrapper. A stub-only test stays green while a real scenario leaks,
 * so this drives each leg's `run`
 * themselves against a scripted fetch, ends each early (a failing funding
 * payment), and asserts the agent revoke reached the wire as the throwaway
 * user. Remove the wrapper from either scenario and its case goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioContext } from './types.js'

vi.mock('@haven_ai/sdk', () => ({ signUserOpTypedDataForDelegation: vi.fn() }))
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class { getCode = async () => '0x' },
      Contract: class { balanceOf = async () => 0n },
    },
  }
})

const { delegationLifecycle } = await import('./delegation-lifecycle.js')
const { x402Erc7710FreshAgent } = await import('./x402-erc7710-fresh-agent.js')
const { taskBudgetLifecycle } = await import('./task-budget-lifecycle.js')
const { subBudgetRedemption } = await import('./sub-budget-redemption.js')
const { merchantLockedBudget } = await import('./merchant-locked-budget.js')

const API = 'https://api.example'
const TD = { domain: {}, types: { X: [{ name: 'a', type: 'uint256' }] }, message: { a: 1 } }
const ctx = {
  cfg: {
    apiUrl: API,
    demoMerchantUrl: 'https://demo-merchant.example',
    delegationAgentApiKey: 'sk_agent_standing',
    delegationDelegateKey: '0x' + '22'.repeat(32),
  },
} as unknown as ScenarioContext

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Provisioning succeeds; the standing identity's funding payment is refused. */
function installFake() {
  const revokes: Array<{ auth: string | null; id: string }> = []
  let agents = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(API, '')
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (path === '/auth/signup') return json({ token: 'jwt-throwaway' }, 201)
    if (path === '/accounts/hybrid') return json({}, 201)
    if (path === '/auth/me') {
      return json({ accounts: [{ id: 'safe-1', account_address: '0x' + '11'.repeat(20), account_type: 'delegator_hybrid' }] })
    }
    if (path === '/agents') {
      agents += 1
      return json({ id: `agent-${agents}`, api_key: `sk-test-${agents}` }, 201)
    }
    if (path.endsWith('/delegations/build')) {
      return json({ delegation_hash: '0xhash1', signing_payload: TD, delegate_account_address: '0x' + '33'.repeat(20) }, 201)
    }
    if (path.endsWith('/activate')) return json({ activated: true })
    if (path === '/payments') return json({ error: 'funding refused' }, 500)
    // Early-failure hooks for the #3505 legs: the task create and the merchant read are refused.
    if (path === '/task-budgets') return json({ error: 'create refused' }, 500)
    if (path === '/merchants/haven-demo-store') return json({ error: 'Merchant not found' }, 404)
    const revoke = /^\/agents\/(agent-\d+)\/revoke$/.exec(path)
    if (revoke) {
      revokes.push({ auth: headers.authorization ?? null, id: revoke[1] })
      // Fastify refuses a JSON content type with an empty body before the
      // route runs (FST_ERR_CTP_EMPTY_JSON_BODY): mirror it, so a revoke the
      // real backend would 400 cannot pass here.
      if ((headers['content-type'] ?? '').includes('application/json') && !init?.body) {
        return json({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY' }, 400)
      }
      return json({ success: true })
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
  }))
  return revokes
}

beforeEach(() => vi.unstubAllGlobals())

describe('the real throwaway scenarios revoke their agent', () => {
  it('delegation-lifecycle revokes when it ends in a failure', async () => {
    const revokes = installFake()
    const result = await delegationLifecycle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/funding the throwaway treasury failed/)
    expect(revokes).toEqual([{ auth: 'Bearer jwt-throwaway', id: 'agent-1' }])
    // …and it LANDED: no cleanup warning means the backend accepted it.
    expect(result.cleanupWarning).toBeUndefined()
  })

  it('x402-erc7710-fresh-agent revokes when it ends in a failure', async () => {
    const revokes = installFake()
    const result = await x402Erc7710FreshAgent.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/funding the throwaway treasury failed/)
    expect(revokes).toEqual([{ auth: 'Bearer jwt-throwaway', id: 'agent-1' }])
    // …and it LANDED: no cleanup warning means the backend accepted it.
    expect(result.cleanupWarning).toBeUndefined()
  })

  it('task-budget-lifecycle revokes when its create is refused', async () => {
    const revokes = installFake()
    const result = await taskBudgetLifecycle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/task-budget create failed/)
    expect(revokes).toEqual([{ auth: 'Bearer jwt-throwaway', id: 'agent-1' }])
    expect(result.cleanupWarning).toBeUndefined()
  })

  it('sub-budget-redemption revokes BOTH agents when funding is refused', async () => {
    const revokes = installFake()
    const result = await subBudgetRedemption.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/funding A failed/)
    expect(revokes.map((r) => r.id).sort()).toEqual(['agent-1', 'agent-2'])
    expect(revokes.every((r) => r.auth === 'Bearer jwt-throwaway')).toBe(true)
    expect(result.cleanupWarning).toBeUndefined()
  })

  it('merchant-locked-budget revokes when the merchant read fails', async () => {
    const revokes = installFake()
    const result = await merchantLockedBudget.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.skipped).toBeUndefined()
    expect(result.detail).toMatch(/GET \/merchants\/haven-demo-store failed \(404\)/)
    expect(revokes).toEqual([{ auth: 'Bearer jwt-throwaway', id: 'agent-1' }])
    expect(result.cleanupWarning).toBeUndefined()
  })
})
