import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioContext } from './types.js'

const { mockSign, mockProve, mockRead, mockProvider } = vi.hoisted(() => ({
  mockSign: vi.fn(),
  mockProve: vi.fn(),
  mockRead: vi.fn(),
  mockProvider: vi.fn(),
}))
vi.mock('@haven_ai/sdk', () => ({ signUserOpTypedDataForDelegation: mockSign }))
vi.mock('../lib/chain.js', async (original) => ({
  ...(await original<typeof import('../lib/chain.js')>()),
  observerProvider: mockProvider,
  proveUsdcTransferSince: mockProve,
}))
vi.mock('../lib/delegation-budget.js', async (original) => ({
  ...(await original<typeof import('../lib/delegation-budget.js')>()),
  readOnchainDelegationBudget: mockRead,
}))

const { merchantLockedBudget } = await import('./merchant-locked-budget.js')
const API = 'https://api.example'
const MERCHANT_URL = 'https://demo-merchant.example'
const TREASURY = '0x' + '11'.repeat(20)
const PAY_TO = '0x' + 'cc'.repeat(20)
const AMOUNT = 1_000n
const TD = { domain: {}, types: { X: [{ name: 'a', type: 'uint256' }] }, primaryType: 'X', message: { a: 1 } }
const ctx = {
  cfg: {
    apiUrl: API,
    demoMerchantUrl: MERCHANT_URL,
    delegationAgentApiKey: 'sk-standing',
    delegationDelegateKey: '0x' + '33'.repeat(32),
  },
} as unknown as ScenarioContext

type Options = {
  funding?: unknown[]
  merchantStatus?: number
  erc7710?: boolean
  livePayTo?: string
}

function install(options: Options = {}) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const out = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
    if (url.startsWith(MERCHANT_URL)) {
      const paid = (init?.headers as Record<string, string>)?.['PAYMENT-SIGNATURE']
      if (paid) {
        return new Response('data: ' + JSON.stringify({ result: { content: [{ text: 'ok' }] } }), { status: 200 })
      }
      const challenge = {
        accepts: [{
          scheme: 'exact', amount: AMOUNT.toString(), payTo: options.livePayTo ?? PAY_TO, asset: '0xusdc', network: 'base-sepolia',
          extra: options.erc7710 === false ? {} : { assetTransferMethod: 'erc7710' },
        }],
      }
      return out(402, {}, { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') })
    }
    const path = url.replace(API, '')
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path, body })
    if (path === '/auth/signup') return out(201, { token: 'jwt' })
    if (path === '/accounts/hybrid') return out(201, {})
    if (path === '/auth/me') return out(200, { accounts: [{ id: 'acct', account_address: TREASURY, account_type: 'delegator_hybrid' }] })
    if (path === '/agents') return out(201, { id: 'agent-1', api_key: 'sk-1' })
    if (path === '/agents/agent-1/delegations/build') {
      return out(201, body?.merchant_slug
        ? { delegation_hash: '0xpinned', signing_payload: TD }
        : { delegation_hash: '0xopen', signing_payload: TD })
    }
    if (/\/delegations\/0x(open|pinned)\/activate$/.test(path)) return out(200, { activated: true })
    if (path === '/agents/agent-1/revoke') return out(200, {})
    if (path === '/merchants/haven-demo-store') {
      return out(options.merchantStatus ?? 200, {
        funding: options.funding ?? [{ chain_id: 84532, pay_to: PAY_TO, pay_to_status: 'verified', erc7710: true }],
      })
    }
    if (path === '/payments') return out(201, { payment_id: 'fund-1', sign_data: { typed_data: TD } })
    if (path === '/payments/fund-1/sign') return out(200, { status: 'confirmed', tx_hash: '0xfund' })
    if (path === '/x402/authorize') return out(201, { payment_id: 'x-1', sign_data: { signature_scheme: 'eip712_delegation', typed_data: TD } })
    if (path === '/x402/x-1/settle') return out(200, { payment_header: 'hdr' })
    throw new Error(`unexpected ${method} ${path}`)
  }))
  return calls
}

/** Remaining by hash; `after` is what each delegation reads once the purchase has settled. */
function scriptReads(after: { pinned: bigint; open: bigint }) {
  const seen: Record<string, number> = {}
  mockRead.mockReset().mockImplementation(async (_chain: number, hash: string) => {
    seen[hash] = (seen[hash] ?? 0) + 1
    const before = 10_000n
    const value = seen[hash] === 1 ? before : hash === '0xpinned' ? after.pinned : after.open
    return { remaining: value, configured: '10000' }
  })
  return seen
}

beforeEach(() => {
  mockSign.mockReset().mockResolvedValue('0x' + 'aa'.repeat(65))
  mockProvider.mockReset().mockReturnValue({ getBlockNumber: async () => 100 })
  mockProve.mockReset().mockResolvedValue({ ok: true, txHash: '0xsettle' })
  scriptReads({ pinned: 9_000n, open: 10_000n })
})

describe('merchant-locked budget', () => {
  it('builds the pinned grant with merchant_slug, proves the Transfer and the pinned-only drop', async () => {
    const calls = install()
    const result = await merchantLockedBudget.run(ctx)
    expect(result.pass).toBe(true)
    expect(result.skipped).toBeUndefined()
    const builds = calls.filter((c) => c.path === '/agents/agent-1/delegations/build')
    expect(builds.map((c) => c.body?.merchant_slug)).toEqual([undefined, 'haven-demo-store'])
    expect(mockProve).toHaveBeenCalledWith(
      { from: TREASURY, to: PAY_TO, amount: AMOUNT }, expect.objectContaining({ fromBlock: 100 }),
    )
    expect(calls.some((c) => c.path === '/agents/agent-1/revoke')).toBe(true)
  })

  it('goes red when the OPEN delegation drops instead of the pinned one', async () => {
    install()
    scriptReads({ pinned: 10_000n, open: 9_000n })
    const result = await merchantLockedBudget.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/OPEN delegation .* dropped by 1000/)
  })

  it('goes red when both drop, and when the pinned drop is not the exact amount', async () => {
    install()
    scriptReads({ pinned: 9_000n, open: 9_000n })
    expect((await merchantLockedBudget.run(ctx)).detail).toMatch(/spent the open budget/)
    scriptReads({ pinned: 9_500n, open: 10_000n })
    expect((await merchantLockedBudget.run(ctx)).detail).toMatch(/expected exactly 1000/)
  })

  it('goes red (never skips) when the merchant does not qualify', async () => {
    for (const funding of [
      [],
      [{ chain_id: 84532, pay_to: null, pay_to_status: 'unstated', erc7710: true }],
      [{ chain_id: 84532, pay_to: PAY_TO, pay_to_status: 'verified', erc7710: false }],
    ]) {
      install({ funding })
      const result = await merchantLockedBudget.run(ctx)
      expect(result.pass).toBe(false)
      expect(result.skipped).toBeUndefined()
      expect(result.detail).toMatch(/does not qualify/)
    }
    install({ merchantStatus: 404 })
    expect((await merchantLockedBudget.run(ctx)).detail).toMatch(/failed \(404\)/)
  })

  it('goes red when the live 402 drops erc7710 or names another payTo', async () => {
    install({ erc7710: false })
    const noScheme = await merchantLockedBudget.run(ctx)
    expect(noScheme.pass).toBe(false)
    expect(noScheme.skipped).toBeUndefined()
    install({ livePayTo: '0x' + 'dd'.repeat(20) })
    expect((await merchantLockedBudget.run(ctx)).detail).toMatch(/differs from haven-demo-store's verified payTo/)
  })

  it('goes red without the exact Transfer on the observer', async () => {
    install()
    mockProve.mockResolvedValue({ ok: false, error: 'none seen' })
    expect((await merchantLockedBudget.run(ctx)).detail).toMatch(/no exact treasury→merchant Transfer: none seen/)
  })
})
