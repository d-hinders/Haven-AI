/**
 * The assertions that stop `x402-erc7710-settle` passing vacuously (#1064).
 *
 * Same discipline as the 3009 leg's tests: the scenario is only worth its
 * runtime if it fails when the property it claims is broken. Pinned here:
 * the erc7710-advertisement gate (skip with the exact remedy), the
 * eip712_delegation discriminator (a 3009-shaped authorize must fail, not
 * proceed), the exact-amount treasury metering, and the delegate-EOA-
 * untouched (no funding leg) invariant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import type { ScenarioContext } from './types.js'

const DELEGATE_KEY = '0x' + '11'.repeat(32)
const DELEGATE = new Wallet(DELEGATE_KEY).address
const MERCHANT = '0x' + 'cc'.repeat(20)
const TREASURY = '0x' + 'aa'.repeat(20)
const MERCHANT_URL = 'https://demo-merchant.example'

const { mockFetch, mockGetAgent, mockAuthorize, mockSettle, mockGetPayment, mockBalanceOf } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockGetAgent: vi.fn(),
    mockAuthorize: vi.fn(),
    mockSettle: vi.fn(),
    mockGetPayment: vi.fn(),
    mockBalanceOf: vi.fn(),
  }))

vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    getAgent = mockGetAgent
    authorizeX402 = mockAuthorize
    settleX402 = mockSettle
    getPayment = mockGetPayment
  },
}))
vi.mock('ethers', async (importOriginal) => {
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

const { x402Erc7710Settle } = await import('./x402-erc7710-settle.js')

vi.stubGlobal('fetch', mockFetch)

const ctx = {
  cfg: {
    apiUrl: 'https://api.example',
    demoMerchantUrl: MERCHANT_URL,
    delegationAgentApiKey: 'sk_agent_qa',
    delegationDelegateKey: DELEGATE_KEY,
  },
} as unknown as ScenarioContext

function challengeResponse(accepts: Array<Record<string, unknown>>) {
  const payload = { x402Version: 2, accepts, resource: { url: `${MERCHANT_URL}/vpn` } }
  return {
    status: 402,
    headers: new Headers({ 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(payload)).toString('base64') }),
    text: async () => '',
  }
}

const ERC7710_ACCEPTS = {
  scheme: 'exact',
  amount: '1000',
  payTo: MERCHANT,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'base-sepolia',
  extra: { assetTransferMethod: 'erc7710' },
}

function servedResponse() {
  return {
    status: 200,
    headers: new Headers(),
    text: async () =>
      `data: ${JSON.stringify({ result: { content: [{ text: 'ok' }], isError: false } })}\n`,
  }
}

/** Typed data the REAL wallet can sign — the scenario signs verbatim. */
const SIGN_DATA = {
  signature_scheme: 'eip712_delegation',
  typed_data: {
    domain: { name: 'DelegationManager', version: '1', chainId: 84532 },
    types: {
      Delegation: [
        { name: 'delegate', type: 'address' },
        { name: 'salt', type: 'uint256' },
      ],
    },
    primaryType: 'Delegation',
    message: { delegate: DELEGATE, salt: 1 },
  },
}

beforeEach(() => {
  mockFetch.mockReset()
  mockGetAgent.mockReset()
  mockAuthorize.mockReset()
  mockSettle.mockReset()
  mockGetPayment.mockReset()
  mockBalanceOf.mockReset()
  mockGetAgent.mockResolvedValue({ ok: true, status: 200, data: { safe_address: TREASURY } })
  mockGetPayment.mockResolvedValue({ ok: true, status: 200, data: { status: 'submitted', to: MERCHANT } })
})

/** balances keyed by address, returned in call order for [treasury, merchant, delegate]. */
function balances(seq: Record<string, bigint[]>) {
  const counters: Record<string, number> = {}
  mockBalanceOf.mockImplementation(async (addr: string) => {
    const key = addr.toLowerCase()
    const values = seq[key] ?? [0n]
    const i = Math.min(counters[key] ?? 0, values.length - 1)
    counters[key] = (counters[key] ?? 0) + 1
    return values[i]
  })
}

describe('the erc7710-advertisement gate', () => {
  it('skips with the exact operator remedy when the merchant is 3009-only', async () => {
    mockFetch.mockResolvedValueOnce(
      challengeResponse([{ scheme: 'exact', amount: '1000', payTo: MERCHANT }]),
    )
    const result = await x402Erc7710Settle.run(ctx)
    expect(result.skipped).toBe(true)
    expect(result.detail).toMatch(/MERCHANT_X402_ERC7710/)
  })
})

describe('the scheme discriminator', () => {
  it('FAILS when authorize returns a 3009-shaped payload instead of the child delegation', async () => {
    mockFetch.mockResolvedValueOnce(challengeResponse([ERC7710_ACCEPTS]))
    balances({ [TREASURY.toLowerCase()]: [10_000n], [MERCHANT.toLowerCase()]: [0n], [DELEGATE.toLowerCase()]: [0n] })
    mockAuthorize.mockResolvedValue({
      ok: true, status: 201,
      data: { payment_id: 'p-1', sign_data: { signature_scheme: 'eip712_userop', typed_data: SIGN_DATA.typed_data } },
    })
    const result = await x402Erc7710Settle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/eip712_userop/)
    expect(mockSettle).not.toHaveBeenCalled()
  })
})

describe('the money invariants', () => {
  function happyPathUpTo(balancesSeq: Record<string, bigint[]>) {
    mockFetch
      .mockResolvedValueOnce(challengeResponse([ERC7710_ACCEPTS]))
      .mockResolvedValueOnce(servedResponse())
    balances(balancesSeq)
    mockAuthorize.mockResolvedValue({ ok: true, status: 201, data: { payment_id: 'p-1', sign_data: SIGN_DATA } })
    mockSettle.mockResolvedValue({ ok: true, status: 200, data: { payment_header: 'aGVhZGVy' } })
  }

  it('passes when treasury −amount, merchant +amount, delegate untouched', async () => {
    happyPathUpTo({
      [TREASURY.toLowerCase()]: [10_000n, 9_000n],
      [MERCHANT.toLowerCase()]: [0n, 1_000n],
      [DELEGATE.toLowerCase()]: [500n, 500n],
    })
    const result = await x402Erc7710Settle.run(ctx)
    expect(result.pass).toBe(true)
    expect(result.skipped).toBeUndefined()
    expect(mockSettle).toHaveBeenCalledWith('p-1', expect.stringMatching(/^0x/))
  })

  it('FAILS when the treasury moved by anything but the exact amount', async () => {
    happyPathUpTo({
      [TREASURY.toLowerCase()]: [10_000n, 8_500n], // −1500, expected −1000
      [MERCHANT.toLowerCase()]: [0n, 1_000n],
      [DELEGATE.toLowerCase()]: [500n, 500n],
    })
    const result = await x402Erc7710Settle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/expected exactly/)
  })

  it('FAILS when the delegate EOA balance changed — a funding leg ran', async () => {
    happyPathUpTo({
      [TREASURY.toLowerCase()]: [10_000n, 9_000n],
      [MERCHANT.toLowerCase()]: [0n, 1_000n],
      [DELEGATE.toLowerCase()]: [500n, 1_500n],
    })
    const result = await x402Erc7710Settle.run(ctx)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/funding leg/)
  })
})
