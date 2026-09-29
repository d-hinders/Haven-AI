/**
 * #3459 guard — the two REAL throwaway-identity scenarios go through the
 * cleanup wrapper. A stub-only test stays green while a real scenario leaks,
 * so this drives `delegationLifecycle.run` and `x402Erc7710FreshAgent.run`
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
  const revokes: Array<{ auth: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(API, '')
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (path === '/auth/signup') return json({ token: 'jwt-throwaway' }, 201)
    if (path === '/accounts/hybrid') return json({}, 201)
    if (path === '/auth/me') {
      return json({ accounts: [{ id: 'safe-1', account_address: '0x' + '11'.repeat(20), account_type: 'delegator_hybrid' }] })
    }
    if (path === '/agents') return json({ id: 'agent-1', api_key: 'sk-test' }, 201)
    if (path.endsWith('/delegations/build')) {
      return json({ delegation_hash: '0xhash1', signing_payload: TD, delegate_account_address: '0x' + '33'.repeat(20) }, 201)
    }
    if (path.endsWith('/activate')) return json({ activated: true })
    if (path === '/payments') return json({ error: 'funding refused' }, 500)
    if (path === '/agents/agent-1/revoke') {
      revokes.push({ auth: headers.authorization ?? null })
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
    expect(revokes).toEqual([{ auth: 'Bearer jwt-throwaway' }])
  })

  it('x402-erc7710-fresh-agent revokes when it ends in a failure', async () => {
    const revokes = installFake()
    const result = await x402Erc7710FreshAgent.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/funding the throwaway treasury failed/)
    expect(revokes).toEqual([{ auth: 'Bearer jwt-throwaway' }])
  })
})
