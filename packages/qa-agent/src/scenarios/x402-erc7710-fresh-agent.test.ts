/**
 * #1674 — the cold-start leg's own discriminators. The shared plumbing
 * (challenge decode, money maths) is the settle leg's and the libs'; what is
 * pinned HERE is what only this leg can catch:
 *
 *   - a fixture that is not actually fresh proves nothing and must FAIL
 *     loudly rather than green-wash the counterfactual path;
 *   - authorize succeeding while the account still has no code stops the leg
 *     BEFORE settle — and after #2445 it is POLLED to a deadline, so the two
 *     halves worth pinning are that a late-appearing code still passes and
 *     that a never-appearing one still FAILS (a poll that always succeeds is
 *     not a guard);
 *   - the failure text must not re-assert the cause #2445 removed: authorize
 *     returning 200 means the backend's node saw the deploy mined, so "the
 *     deploy did not run" is exactly what this read cannot conclude;
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
const FACILITATOR = '0x' + 'fa'.repeat(20)
const ASSET = '0x' + 'dd'.repeat(20)

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

const { x402Erc7710FreshAgent, TIMING } = await import('./x402-erc7710-fresh-agent.js')

// Real waits are 30 s / 90 s. The cases that matter here are the ones that
// never converge, so they would sit out both in full.
TIMING.deployVisibleWaitMs = 60
TIMING.settleWaitMs = 60
TIMING.pollIntervalMs = 20

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

/**
 * The decoded challenge — ONE object feeds the header AND the authorize-body
 * pin below. Carries `extensions` in the dev demo merchant's shape
 * (`DEMO_MERCHANT_EXTENSIONS`, packages/demo-merchant-mcp/src/x402.ts, #2361)
 * so the pinned body is the post-#2364 challenge the settle-side echo is
 * built from. Hand-copied, NOT imported (qa-agent does not depend on
 * demo-merchant-mcp) and nothing re-syncs it — tolerable because the pin
 * proves VERBATIM passthrough of whatever was decoded; the block's exact
 * content is illustrative, not load-bearing.
 */
const CHALLENGE = {
  x402Version: 2,
  accepts: [{
    scheme: 'exact',
    amount: AMOUNT.toString(),
    payTo: MERCHANT,
    asset: ASSET,
    network: 'base-sepolia',
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
  }],
  resource: { url: `${MERCHANT_URL}/mcp` },
  extensions: {
    'haven-demo': { version: '1', echoRule: 'x402 v2: clients must echo this extensions object in PaymentPayload' },
  },
}

function challengeResponse() {
  return {
    status: 402,
    headers: new Headers({ 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(CHALLENGE)).toString('base64') }),
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

describe('the post-authorize code read (#2445)', () => {
  it('STILL FAILS when the code never appears — the poll must be able to lose', async () => {
    // The guard's whole value: a poll that always converges asserts nothing.
    // Every read returns 0x, so the loop must exhaust its deadline and fail.
    mockGetCode.mockResolvedValue('0x')

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/still reports no code/)
    // It polled rather than reading once: the counterfactual precondition read
    // plus at least two attempts inside the deadline.
    expect(mockGetCode.mock.calls.length).toBeGreaterThan(2)
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('PASSES when the code appears on a later poll — the read lag #2445 is about', async () => {
    // Pre-#2445 this exact sequence failed the run and blamed the deploy.
    mockGetCode
      .mockResolvedValueOnce('0x') // counterfactual precondition
      .mockResolvedValueOnce('0x') // first post-authorize read: node behind
      .mockResolvedValue('0x60016001') // caught up

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(true)
    expect(mockSettle).toHaveBeenCalled()
  })

  it('does NOT blame the deploy — authorize returning 200 rules that cause out', async () => {
    // `ensureHybridDeployed` throws on an unconfirmed or reverted deploy and
    // `delegation-authorize.ts` turns that into a 502, so a 200 means the
    // backend's node saw the account deployed. The old text asserted the
    // opposite and sent triage into #1667's code.
    mockGetCode.mockResolvedValue('0x')

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.detail).not.toMatch(/deploy did not run/)
    expect(result.detail).not.toMatch(/InvalidEOASignature/)
    // What it says instead: the backend's node saw it, ours has not caught up.
    expect(result.detail).toMatch(/backend's node saw/)
    expect(result.detail).toMatch(/has not caught up/)
    expect(result.detail).toMatch(/RPC_URL_BASE_SEPOLIA/)
  })
})

describe('the authorize body (#2384)', () => {
  it('sends the decoded challenge VERBATIM as paymentRequired, with the erc7710 entry\'s fields', async () => {
    // #2373: same pin as x402-erc7710-settle — the stored copy of this
    // challenge feeds the settle-side resource/extensions echo (#2361), and
    // dropping the field was invisible to unit CI. Deep-equal on purpose.
    mockGetCode.mockResolvedValueOnce('0x').mockResolvedValueOnce('0x60016001')

    const result = await x402Erc7710FreshAgent.run(ctx)

    expect(result.pass).toBe(true)
    expect(mockAuthorize).toHaveBeenCalledTimes(1)
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({
      url: `${MERCHANT_URL}/mcp`,
      payTo: MERCHANT,
      amount: AMOUNT.toString(),
      asset: ASSET,
      network: 'base-sepolia',
      maxTimeoutSeconds: 300,
      facilitatorAddresses: [FACILITATOR],
      paymentRequired: CHALLENGE,
    }))
    // objectContaining is recursive-equal, not strict: pin the challenge
    // strictly too, so an extra or undefined-valued key cannot slip past.
    const [body] = mockAuthorize.mock.calls[0]
    expect(body.paymentRequired).toStrictEqual(CHALLENGE)
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
