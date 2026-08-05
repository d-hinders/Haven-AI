/**
 * The assertions that stop `delegation-lifecycle` passing vacuously (#1065).
 *
 * Pinned: a payment that SUCCEEDS after revoke fails the leg; a post-revoke
 * 502 fails it with the authority-was-offered explanation (the 403/502
 * distinction is the leg's reason to exist); a replacement that leaves two
 * active rows fails it (the #1053-finding-4 regression); and the missing-
 * identity skip. The whole API is a scripted global-fetch fake — the
 * assertion logic is the only thing under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockSign } = vi.hoisted(() => ({ mockSign: vi.fn() }))
vi.mock('@haven_ai/sdk', () => ({
  signUserOpTypedDataForDelegation: mockSign,
}))

const { delegationLifecycle } = await import('./delegation-lifecycle.js')

const API = 'https://api.example'
const ctx = {
  cfg: {
    apiUrl: API,
    delegationAgentApiKey: 'sk_agent_standing',
    delegationDelegateKey: '0x' + '22'.repeat(32),
  },
} as unknown as ScenarioContext

const TD = { domain: {}, types: { X: [] }, message: {} }

interface FakeOpts {
  /** Status+body for the post-revoke payment authorize. */
  postRevokeAuthorize: { status: number; body: Record<string, unknown> }
  /** Rows returned by the delegations list after replacement. */
  activeAfterReplace?: number
}

/**
 * Scripted API: enough of the backend for the scenario to run start-to-end.
 * Payments before the revoke succeed; the post-revoke one behaves per opts.
 */
function installFakeApi(opts: FakeOpts) {
  let grants = 0
  let revoked = false
  let payments = 0

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(API, '')
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (path === '/auth/signup') return json(201, { token: 'jwt-throwaway' })
    if (path === '/accounts/hybrid') return json(201, {})
    if (path === '/auth/me') {
      return json(200, { safes: [{ id: 'safe-t', safe_address: '0x' + 'ab'.repeat(20), account_type: 'delegator_hybrid' }] })
    }
    if (path === '/agents' && init?.method === 'POST') {
      return json(201, { id: 'agent-t', api_key: 'sk_agent_throwaway' })
    }
    if (path.endsWith('/delegations/build')) {
      grants += 1
      return json(201, { delegation_hash: `0xhash${grants}`, signing_payload: TD })
    }
    if (/\/delegations\/0xhash\d\/activate$/.test(path)) return json(200, { activated: true })
    if (path === '/agents/agent-t/delegations' && (!init || init.method === undefined || init.method === 'GET')) {
      const n = opts.activeAfterReplace ?? 1
      const rows = Array.from({ length: n }, (_v, i) => ({ status: 'active', delegation_hash: `0xhash${grants - i}` }))
      return json(200, { delegations: rows })
    }
    if (/\/delegations\/0xhash\d\/revoke$/.test(path)) {
      return json(200, { signature_scheme: 'eip712_userop', signing_payload: TD, user_operation: { nonce: '1n' } })
    }
    if (/\/revoke\/submit$/.test(path)) {
      revoked = true
      return json(200, { revoked: true })
    }
    if (path === '/machine-payments/agent') return json(200, { safe_address: '0x' + 'cd'.repeat(20) })
    if (path === '/payments' && init?.method === 'POST') {
      payments += 1
      if (revoked) return json(opts.postRevokeAuthorize.status, opts.postRevokeAuthorize.body)
      return json(201, { payment_id: `p-${payments}`, sign_data: { typed_data: TD } })
    }
    if (/\/payments\/p-[\w-]+\/sign$/.test(path)) return json(200, { status: 'confirmed', tx_hash: '0xfeed' })
    throw new Error(`unexpected fake-api call: ${init?.method ?? 'GET'} ${path}`)
  }))
}

beforeEach(() => {
  mockSign.mockReset()
  mockSign.mockResolvedValue('0x' + 'ab'.repeat(65))
})

describe('the missing-identity gate', () => {
  it('skips without the standing funding identity', async () => {
    const bare = { cfg: { apiUrl: API } } as unknown as ScenarioContext
    const result = await delegationLifecycle.run(bare)
    expect(result.skipped).toBe(true)
    expect(result.detail).toMatch(/QA_DELEGATION_AGENT_API_KEY/)
  })
})

describe('the revoke discriminators', () => {
  it('passes when the post-revoke payment is 403 with the no-active-delegation reason', async () => {
    installFakeApi({ postRevokeAuthorize: { status: 403, body: { error: 'Agent has no active budget delegation for USDC to this recipient' } } })
    const result = await delegationLifecycle.run(ctx)
    expect(result.detail).toContain('403')
    expect(result.pass).toBe(true)
  })

  it('FAILS when the payment still SUCCEEDS after revoke', async () => {
    installFakeApi({ postRevokeAuthorize: { status: 201, body: { payment_id: 'p-zombie', sign_data: { typed_data: TD } } } })
    const result = await delegationLifecycle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/circuit breaker/)
  })

  it('FAILS on a post-revoke 502 — authority was still offered to the chain', async () => {
    installFakeApi({ postRevokeAuthorize: { status: 502, body: { error: 'bundler said no' } } })
    const result = await delegationLifecycle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/offered to the chain/)
  })
})

describe('the transactional-activate regression (#1053 finding 4)', () => {
  it('FAILS when replacement leaves two active rows', async () => {
    installFakeApi({
      postRevokeAuthorize: { status: 403, body: { error: 'Agent has no active budget delegation' } },
      activeAfterReplace: 2,
    })
    const result = await delegationLifecycle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/expected exactly 1/)
  })
})
