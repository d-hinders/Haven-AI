/**
 * #1674 — the cold-start leg's own discriminators. The shared plumbing
 * (challenge decode, money maths) is the settle leg's and the libs'; what is
 * pinned HERE is what only this leg can catch:
 *
 *   - a fixture that is not actually fresh proves nothing and must FAIL
 *     loudly rather than green-wash the counterfactual path;
 *   - authorize succeeding while the account still has no code is the exact
 *     #1667 regression signal, caught BEFORE settle would revert on-chain;
 *   - the happy path requires the code flip to happen at authorize.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import type { ScenarioContext } from './types.js'

const DELEGATE_KEY = '0x' + '11'.repeat(32)
const MERCHANT = '0x' + 'cc'.repeat(20)
const TREASURY = '0x' + 'aa'.repeat(20)
const DELEGATE_ACCOUNT = '0x' + 'bb'.repeat(20)
const MERCHANT_URL = 'https://demo-merchant.example'
const AMOUNT = 1500n

const { mockFetch, mockAuthorize, mockSettle, mockBalanceOf, mockGetCode, mockProvision, mockPay } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockAuthorize: vi.fn(),
    mockSettle: vi.fn(),
    mockBalanceOf: vi.fn(),
    mockGetCode: vi.fn(),
    mockProvision: vi.fn(),
    mockPay: vi.fn(),
  }))

vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    authorizeX402 = mockAuthorize
    settleX402 = mockSettle
  },
}))
vi.mock('../lib/throwaway-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/throwaway-identity.js')>()
  return {
    ...actual,
    provisionThrowawayIdentity: mockProvision,
    payViaDelegation: mockPay,
  }
})
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class {
        getCode = mockGetCode
      },
      Contract: class {
        balanceOf = mockBalanceOf
      },
    },
  }
})

const { x402Erc7710FreshAgent } = await import('./x402-erc7710-fresh-agent.js')

const ctx = {
  cfg: {
    apiUrl: 'https://api.example',
    demoMerchantUrl: MERCHANT_URL,
    delegationAgentApiKey: 'sk_agent_standing',
    delegationDelegateKey: DELEGATE_KEY,
  },
} as unknown as ScenarioContext

function identity() {
  const delegate = new Wallet(DELEGATE_KEY)
  return {
    owner: delegate,
    delegate,
    token: 'jwt',
    safeId: 'saf-1',
    safeAddress: TREASURY,
    agentId: 'agt-1',
    agentApiKey: 'sk_agent_fresh',
    delegateAccountAddress: DELEGATE_ACCOUNT,
    grantHash: '0xgrant',
    grantAndActivate: vi.fn(),
  }
}

function challengeResponse() {
  const challenge = {
    accepts: [{
      scheme: 'exact',
      amount: AMOUNT.toString(),
      payTo: MERCHANT,
      asset: '0x' + 'dd'.repeat(20),
      network: 'base-sepolia',
      extra: { assetTransferMethod: 'erc7710' },
    }],
    resource: { url: `${MERCHANT_URL}/mcp` },
  }
  return {
    status: 402,
    headers: new Headers({ 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') }),
    text: async () => '',
  }
}

function paidResponse() {
  return {
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ text: 'ok' }] } }),
  }
}

const CHILD_TYPED_DATA = {
  domain: { name: 'DelegationManager' },
  types: { Delegation: [{ name: 'delegator', type: 'address' }] },
  message: { delegator: DELEGATE_ACCOUNT },
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: clear leaves queued mockResolvedValueOnce
  // implementations behind, so an earlier test's unconsumed 402 challenge
  // would become a later test's merchant retry response.
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mockFetch)
  mockProvision.mockResolvedValue(identity())
  mockPay.mockResolvedValue({ ok: true, status: 200, tx: '0xfund' })
  mockAuthorize.mockResolvedValue({
    ok: true, status: 200,
    data: {
      payment_id: 'pay_fresh',
      sign_data: { signature_scheme: 'eip712_delegation', typed_data: CHILD_TYPED_DATA },
    },
  })
  mockSettle.mockResolvedValue({ ok: true, status: 200, data: { payment_header: 'hdr' } })
  mockFetch
    .mockResolvedValueOnce(challengeResponse())
    .mockResolvedValue(paidResponse())
  // Money: treasury 10000→8500, merchant 0→1500, delegate EOA 0→0.
  mockBalanceOf
    .mockResolvedValueOnce(10_000n) // treasury before
    .mockResolvedValueOnce(0n) // merchant before
    .mockResolvedValueOnce(0n) // delegate before
    .mockResolvedValueOnce(10_000n - AMOUNT) // treasury after
    .mockResolvedValueOnce(AMOUNT) // merchant after
    .mockResolvedValueOnce(0n) // delegate after
})

describe('the counterfactual precondition', () => {
  it('FAILS when the "fresh" account already has code — the run would prove nothing', async () => {
    mockGetCode.mockResolvedValue('0x60016001')

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/already has code before any payment/)
    // And it must stop there: no money moved, no authorize issued.
    expect(mockAuthorize).not.toHaveBeenCalled()
    expect(mockPay).not.toHaveBeenCalled()
  })

  it('FAILS when the grant build carries no delegate_account_address to assert on', async () => {
    mockProvision.mockResolvedValue({ ...identity(), delegateAccountAddress: null })

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/cannot assert the counterfactual/)
  })
})

describe('the #1667 regression signal', () => {
  it('FAILS when authorize succeeds but the account still has NO code', async () => {
    // The exact prod defect: nothing deployed the delegator, so redemption
    // would revert InvalidEOASignature. Caught here, before settle.
    mockGetCode.mockResolvedValueOnce('0x').mockResolvedValueOnce('0x')

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/still has no code/)
    expect(result.detail).toMatch(/InvalidEOASignature/)
    expect(mockSettle).not.toHaveBeenCalled()
  })
})

describe('the cold-start happy path', () => {
  it('passes when the code flips at authorize and the money proof holds', async () => {
    mockGetCode.mockResolvedValueOnce('0x').mockResolvedValueOnce('0x60016001')

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(true)
    expect(result.detail).toMatch(/counterfactual → deployed by authorize/)
    // The account was funded from the standing identity before paying.
    expect(mockPay).toHaveBeenCalledWith(
      'https://api.example', 'sk_agent_standing', DELEGATE_KEY, TREASURY, expect.any(String),
    )
  })

  it('FAILS when the delegate EOA moved — a funding leg ran on the no-funding-leg path', async () => {
    mockGetCode.mockResolvedValueOnce('0x').mockResolvedValueOnce('0x60016001')
    mockBalanceOf.mockReset()
    mockBalanceOf
      .mockResolvedValueOnce(10_000n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(10_000n - AMOUNT)
      .mockResolvedValueOnce(AMOUNT)
      .mockResolvedValueOnce(777n) // delegate after — the smoking gun

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/funding leg ran/)
  })
})
