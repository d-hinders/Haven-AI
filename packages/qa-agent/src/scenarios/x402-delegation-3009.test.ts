/**
 * The assertions that stop `x402-delegation-3009` passing vacuously (#946).
 *
 * A QA scenario is only worth its runtime if it fails when the thing it claims
 * to cover is broken. The specific hazard here: the merchant round-trip
 * succeeding proves nothing about WHICH settlement scheme ran, so an
 * erc7710-capable merchant would produce a green run with the 3009 bridge
 * untouched. These tests pin each discriminator by feeding it the shape it must
 * reject — the network and chain seams are mocked so the assertion logic is the
 * only thing under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import type { ScenarioContext } from './types.js'

const DELEGATE_KEY = '0x' + '11'.repeat(32)
const DELEGATE = new Wallet(DELEGATE_KEY).address
const MERCHANT = '0x' + 'cc'.repeat(20)
const MERCHANT_URL = 'https://demo-merchant.example'
const MCP_URL = `${MERCHANT_URL}/mcp`

const { mockFetch, mockListReceipts, mockBalanceOf } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockListReceipts: vi.fn(),
  mockBalanceOf: vi.fn(),
}))

vi.mock('@haven_ai/sdk', () => ({
  HavenClient: class {
    fetch = mockFetch
  },
}))
vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    listReceipts = mockListReceipts
  },
}))
vi.mock('ethers', async (importOriginal) => {
  // Wallet and formatUnits stay REAL — the delegate address the scenario
  // derives must be the genuine one, or the address comparison it exists to
  // make would be comparing two mocks.
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class {},
      Contract: class {
        balanceOf = mockBalanceOf
      },
    },
  }
})

const { x402Delegation3009, TIMING } = await import('./x402-delegation-3009.js')

// Real values here would make each no-evidence-row case sit out a 20s wait.
TIMING.evidenceWaitMs = 60
TIMING.pollIntervalMs = 20

/** A merchant response that succeeds — so only the evidence assertions can fail. */
const okMerchantResponse = () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ content: [{ text: 'VPN basic purchased' }] }),
})

const receipt = (over: Record<string, unknown> = {}) => ({
  resource_url: MCP_URL,
  created_at: new Date(Date.now() + 1000).toISOString(),
  challenge_payload: { settlement_scheme: 'eip3009' },
  settlement_address: DELEGATE,
  merchant_address: MERCHANT,
  amount_human: '0.001',
  tx_hash: '0x' + 'ab'.repeat(32),
  ...over,
})

function ctx(over: Partial<ScenarioContext['cfg']> = {}): ScenarioContext {
  return {
    cfg: {
      apiUrl: 'https://dev-backend.example',
      agentApiKey: 'sk_agent_legacy',
      delegateKey: '0x' + '22'.repeat(32),
      paymentTo: '0x' + 'dd'.repeat(20),
      demoMerchantUrl: MERCHANT_URL,
      delegationAgentApiKey: 'sk_agent_delegation',
      delegationDelegateKey: DELEGATE_KEY,
      ...over,
    },
    api: {} as ScenarioContext['api'],
    delegateKey: '0x' + '22'.repeat(32),
    delegateAddress: '0x' + 'ee'.repeat(20),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(okMerchantResponse())
  mockListReceipts.mockResolvedValue({ ok: true, data: { receipts: [receipt()] } })
  mockBalanceOf.mockResolvedValue(0n)
})

describe('preconditions skip rather than fail', () => {
  it('skips without a demo-merchant URL', async () => {
    const r = await x402Delegation3009.run(ctx({ demoMerchantUrl: undefined }))
    expect(r.skipped).toBe(true)
  })

  it.each([
    ['no api key', { delegationAgentApiKey: undefined }],
    ['no delegate key', { delegationDelegateKey: undefined }],
    ['neither', { delegationAgentApiKey: undefined, delegationDelegateKey: undefined }],
  ])('skips with %s, and never calls the merchant', async (_name, over) => {
    // Skipping matters as much as passing: these credentials require an
    // operator to seed a second identity, and a hard failure would turn every
    // existing dev run red the moment this scenario landed.
    const r = await x402Delegation3009.run(ctx(over))
    expect(r.skipped).toBe(true)
    expect(r.pass).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('the merchant round-trip itself', () => {
  it('fails when the merchant still returns 402', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 402, text: async () => '' })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/still HTTP 402/)
  })

  it('fails when the tool result is an MCP error', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ isError: true, content: [{ text: 'insufficient budget' }] }),
    })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/insufficient budget/)
  })
})

describe('the scheme discriminator — the reason this scenario is not vacuous', () => {
  it('FAILS a successful purchase that actually settled via erc7710', async () => {
    // The whole point. Without this the scenario reports green while the 3009
    // bridge — the path with the hot balance and the real merchant reach — has
    // no live coverage at all.
    mockListReceipts.mockResolvedValue({
      ok: true,
      data: {
        receipts: [
          receipt({
            challenge_payload: { settlement_scheme: 'erc7710' },
            settlement_address: MERCHANT,
          }),
        ],
      },
    })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/not "eip3009"/)
  })

  it('FAILS when the scheme was never recorded', async () => {
    mockListReceipts.mockResolvedValue({
      ok: true,
      data: { receipts: [receipt({ challenge_payload: {} })] },
    })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/absent/)
  })

  it('FAILS when no evidence row appears — two legs that cannot be reconciled', async () => {
    mockListReceipts.mockResolvedValue({ ok: true, data: { receipts: [] } })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no evidence row/)
  })

  it('ignores a receipt from an EARLIER run rather than asserting against it', async () => {
    // Matching "the newest row" would let a previous day's payment satisfy
    // today's assertions. The row must post-date this scenario's start.
    mockListReceipts.mockResolvedValue({
      ok: true,
      data: { receipts: [receipt({ created_at: new Date(Date.now() - 86_400_000).toISOString() })] },
    })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no evidence row/)
  })
})

describe('the two-leg shape', () => {
  it('FAILS when Haven funded something other than the delegate EOA', async () => {
    mockListReceipts.mockResolvedValue({
      ok: true,
      data: { receipts: [receipt({ settlement_address: '0x' + 'ff'.repeat(20) })] },
    })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/not the delegate EOA/)
  })

  it('FAILS when the merchant is indistinguishable from the funding target', async () => {
    // The security model requires these recorded separately, so a funding hop
    // can never be read as a merchant payment.
    mockListReceipts.mockResolvedValue({
      ok: true,
      data: { receipts: [receipt({ merchant_address: DELEGATE })] },
    })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/indistinguishable from a merchant payment/)
  })

  it('compares addresses case-insensitively — checksum casing is not a failure', async () => {
    mockListReceipts.mockResolvedValue({
      ok: true,
      data: { receipts: [receipt({ settlement_address: DELEGATE.toLowerCase() })] },
    })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
  })
})

describe('residuals', () => {
  it('passes with a zero residual', async () => {
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/0 residual/)
  })

  it('passes with sub-floor dust, and says so', async () => {
    // Owner decision 2026-07-18: stranding up to the 1 USDC sweep floor is
    // accepted, because sweeping it costs more gas than it recovers — but it
    // must stay VISIBLE rather than silently tolerated.
    mockBalanceOf.mockResolvedValue(5_000n) // 0.005 USDC — the amount live QA saw
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/0\.005 USDC sub-floor dust/)
  })

  it('FAILS at or above the sweep floor — that is stranding, not dust', async () => {
    mockBalanceOf.mockResolvedValue(1_000_000n) // exactly 1 USDC
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/stranding, not dust/)
  })
})
