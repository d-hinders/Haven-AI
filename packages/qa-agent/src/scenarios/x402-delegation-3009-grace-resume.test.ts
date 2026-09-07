import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Wallet } from 'ethers'
import type { ScenarioContext } from './types.js'

const DELEGATE_KEY = `0x${'11'.repeat(32)}`
const DELEGATE = new Wallet(DELEGATE_KEY).address
const TREASURY = `0x${'aa'.repeat(20)}`
const MERCHANT = `0x${'bb'.repeat(20)}`

const {
  mockAuthorize,
  mockSign,
  mockPoll,
  mockStatus,
  mockGetAgent,
  mockResume,
  mockBalanceOf,
  mockPrepareSweep,
  mockSignTyped,
  mockFetch,
} = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockSign: vi.fn(),
  mockPoll: vi.fn(),
  mockStatus: vi.fn(),
  mockGetAgent: vi.fn(),
  mockResume: vi.fn(),
  mockBalanceOf: vi.fn(),
  mockPrepareSweep: vi.fn(),
  mockSignTyped: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('@haven_ai/sdk', () => ({
  HavenClient: class {
    resumeX402Payment = mockResume
    prepareSweep = mockPrepareSweep
    submitSweep = vi.fn()
  },
  buildSweepTypedData: vi.fn(),
  signUserOpTypedDataForDelegation: mockSignTyped,
}))
vi.mock('../lib/haven-api.js', () => ({
  HavenApi: class {
    authorizeX402 = mockAuthorize
    signPayment = mockSign
    pollUntilSettled = mockPoll
    getMachinePaymentStatus = mockStatus
    getAgent = mockGetAgent
  },
}))
vi.mock('../lib/merchant-mcp.js', () => ({
  MCP_HEADERS: { 'Content-Type': 'application/json' },
  mcpBody: vi.fn(() => '{"jsonrpc":"2.0"}'),
  decodeChallenge: vi.fn(() => ({
    resource: { url: 'https://merchant.example/mcp' },
    accepts: [{ payTo: MERCHANT, amount: '1000', asset: '0xusdc', network: 'eip155:84532' }],
  })),
  readMcpOutcome: vi.fn(() => ({ served: true })),
}))
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class {},
      Contract: class { balanceOf = mockBalanceOf },
    },
  }
})

const { x402Delegation3009GraceResume, evaluateResumeMoneyProof } = await import(
  './x402-delegation-3009-grace-resume.js'
)

function ctx(over: Partial<ScenarioContext['cfg']> = {}): ScenarioContext {
  return {
    cfg: {
      apiUrl: 'https://dev-backend.example',
      paymentTo: MERCHANT,
      demoMerchantUrl: 'https://merchant.example',
      delegationAgentApiKey: 'sk_agent_delegation',
      delegationDelegateKey: DELEGATE_KEY,
      ...over,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockResolvedValue(new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': 'x' } }))
  mockGetAgent.mockResolvedValue({ ok: true, data: { safe_address: TREASURY } })
  mockAuthorize.mockResolvedValue({
    ok: true, status: 201,
    data: { payment_id: 'pay_2159', sign_data: { signature_scheme: 'eip712_userop', typed_data: {} } },
  })
  mockSignTyped.mockResolvedValue('0xsigned')
  mockSign.mockResolvedValue({ ok: true, status: 200, data: {} })
  mockPoll.mockResolvedValue({ status: 'confirmed', tx_hash: '0xfunding' })
  mockStatus.mockResolvedValue({
    ok: true,
    status: 200,
    data: { phase: 'funded_but_unsettled', next_action: 'retry_original_x402_request' },
  })
  mockResume.mockResolvedValue(new Response(JSON.stringify({ result: { content: [{ text: 'paid' }] } }), { status: 200 }))
  mockPrepareSweep.mockResolvedValue({ nothing_stranded: true })
  // treasury / merchant / delegate before, then each after resume.
  mockBalanceOf
    .mockResolvedValueOnce(1_000_000n)
    .mockResolvedValueOnce(0n)
    .mockResolvedValueOnce(0n)
    .mockResolvedValueOnce(999_000n)
    .mockResolvedValueOnce(1_000n)
    .mockResolvedValueOnce(0n)
})

describe('x402-delegation-3009-grace-resume (#2159)', () => {
  it('skips without the delegation credentials', async () => {
    const result = await x402Delegation3009GraceResume.run(ctx({ delegationDelegateKey: undefined }))
    expect(result.skipped).toBe(true)
    expect(mockAuthorize).not.toHaveBeenCalled()
  })

  it('proves the server recovery state and resumes through the SDK gate', async () => {
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(true)
    expect(mockStatus).toHaveBeenCalledWith('pay_2159')
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringContaining('x402-delegation-3009-grace-resume'),
    }))
    expect(mockResume).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'pay_2159',
      url: 'https://merchant.example/mcp',
      idempotencyKey: expect.stringContaining('x402-delegation-3009-grace-resume'),
    }))
    expect(result.detail).toMatch(/no unsettled funding of its own/)
  })

  it('fails if the resumed purchase does not debit treasury and credit merchant equally', async () => {
    mockBalanceOf
      .mockReset()
      .mockResolvedValue(0n)
      .mockResolvedValueOnce(1_000_000n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(999_000n)
      .mockResolvedValueOnce(500n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(999_000n)
      .mockResolvedValueOnce(500n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(500n)
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30_001)
    const result = await x402Delegation3009GraceResume.run(ctx())
    now.mockRestore()
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/money proof failed/)
    expect(mockPrepareSweep).toHaveBeenCalledOnce()
  })

  it('is not poisoned by the neighbour’s late merchant leg (#2444)', async () => {
    // The exact shape of run 33640693154. `x402-delegation-3009` runs first
    // against the SAME delegate EOA and the SAME merchant; its 0.001 USDC was
    // still on the delegate when this scenario snapshotted, and landed at the
    // merchant inside this window. Absolute balances then read merchant +0.002
    // against an expected +0.001 and the proof failed a correct payment.
    mockBalanceOf
      .mockReset()
      .mockResolvedValueOnce(1_000_000n) // treasury before
      .mockResolvedValueOnce(0n) // merchant before
      .mockResolvedValueOnce(1_000n) // delegate before — the neighbour's undelivered leg
      .mockResolvedValueOnce(999_000n) // treasury after: −0.001, this scenario's own
      .mockResolvedValueOnce(2_000n) // merchant after: +0.002, two legs landed
      .mockResolvedValue(0n) // delegate after: drained, both legs gone
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(true)
    expect(mockPrepareSweep).not.toHaveBeenCalled()
  })

  it('attempts cleanup when status lookup throws after confirmed funding', async () => {
    mockStatus.mockRejectedValue(new Error('status endpoint unavailable'))
    mockBalanceOf
      .mockReset()
      .mockResolvedValueOnce(1_000_000n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(500n)
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/post-funding recovery failed: status endpoint unavailable/)
    expect(mockPrepareSweep).toHaveBeenCalledOnce()
  })
})

/**
 * #2444 — the money proof must measure the deltas THIS scenario caused.
 *
 * The end-to-end defect needs two scenarios adjacent against a live testnet, so
 * it cannot be reproduced below a live run. The arithmetic that decides the
 * verdict can be, and is pinned here directly.
 */
describe('evaluateResumeMoneyProof — caused deltas, not absolute balances (#2444)', () => {
  const AMOUNT = 1_000n
  const clean = {
    amount: AMOUNT,
    treasuryBefore: 1_000_000n,
    treasuryAfter: 999_000n,
    merchantBefore: 0n,
    merchantAfter: 1_000n,
    delegateBefore: 0n,
    delegateAfter: 0n,
  }

  it('settles on a clean window', () => {
    const p = evaluateResumeMoneyProof(clean)
    expect(p.settled).toBe(true)
    expect(p.causedMerchantDelta).toBe(AMOUNT)
    expect(p.delegateDrain).toBe(0n)
  })

  it('settles when a neighbour’s in-flight leg lands inside the window', () => {
    // Run 33640693154's numbers. Merchant observed +0.002; 0.001 of it drained
    // off the delegate's pre-existing balance and was never this scenario's.
    const p = evaluateResumeMoneyProof({
      ...clean,
      merchantAfter: 2_000n,
      delegateBefore: 1_000n,
      delegateAfter: 0n,
    })
    expect(p.merchantDelta).toBe(2_000n)
    expect(p.delegateDrain).toBe(1_000n)
    expect(p.causedMerchantDelta).toBe(AMOUNT)
    expect(p.settled).toBe(true)
  })

  it('is NOT a loosened bound — a genuine merchant shortfall still fails', () => {
    // The subtraction only removes value that demonstrably came off the
    // delegate. Nothing drained here, so the observed shortfall stands.
    const p = evaluateResumeMoneyProof({ ...clean, merchantAfter: 500n })
    expect(p.settled).toBe(false)
    expect(p.fault).toBe('merchant')
    expect(p.causedMerchantDelta).toBe(500n)
  })

  it('still fails a merchant overpayment the delegate cannot account for', () => {
    // +0.002 at the merchant with a delegate that never moved is a real
    // double-spend shape, not a neighbour's leg, and must stay red.
    const p = evaluateResumeMoneyProof({ ...clean, merchantAfter: 2_000n })
    expect(p.settled).toBe(false)
    expect(p.fault).toBe('merchant')
  })

  it('fails when this scenario’s OWN funding is left on the delegate', () => {
    // The opposite fault, and the one the neighbour was allowed to commit.
    // A delegate ABOVE its baseline is unsettled funding, never a drain.
    const p = evaluateResumeMoneyProof({
      ...clean,
      merchantAfter: 0n,
      delegateAfter: 1_000n,
    })
    expect(p.delegateDrain).toBe(0n)
    expect(p.delegateSurplus).toBe(1_000n)
    expect(p.settled).toBe(false)
  })

  it('reports the DELEGATE fault when treasury and merchant both reconcile', () => {
    // Both money legs balance, yet the delegate ends 0.001 above baseline —
    // an extra funding leg that never settled. The drain subtraction must not
    // absorb it: a delegate above baseline is never a drain.
    const p = evaluateResumeMoneyProof({ ...clean, delegateAfter: 1_000n })
    expect(p.treasuryDelta).toBe(AMOUNT)
    expect(p.causedMerchantDelta).toBe(AMOUNT)
    expect(p.fault).toBe('delegate')
    expect(p.settled).toBe(false)
  })

  it('absorbs at most ONE neighbour leg — an arbitrary drain cannot be netted out', () => {
    // haven-reviewer's finding on this diff: subtracting an UNBOUNDED drain
    // lets any amount leaving the delegate excuse any matching merchant
    // excess. 0.003 drains and 0.004 lands; only 0.001 (one leg) is
    // absorbable, so the remainder stays unexplained and the proof fails
    // rather than silently reconciling.
    const p = evaluateResumeMoneyProof({
      ...clean,
      merchantAfter: 4_000n,
      delegateBefore: 3_000n,
      delegateAfter: 0n,
    })
    expect(p.delegateDrain).toBe(3_000n)
    expect(p.absorbedDrain).toBe(AMOUNT)
    expect(p.causedMerchantDelta).toBe(3_000n)
    expect(p.fault).toBe('merchant')
    expect(p.settled).toBe(false)
  })

  it('absorbs the full drain when it is within the one-leg bound', () => {
    // The boundary itself: exactly one leg is still absorbed in full, so the
    // cap does not break the adjacency case it was built to allow.
    const p = evaluateResumeMoneyProof({
      ...clean,
      merchantAfter: 2_000n,
      delegateBefore: AMOUNT,
      delegateAfter: 0n,
    })
    expect(p.absorbedDrain).toBe(AMOUNT)
    expect(p.delegateDrain).toBe(AMOUNT)
    expect(p.settled).toBe(true)
  })

  it('fails when the treasury did not move by the paid amount', () => {
    const p = evaluateResumeMoneyProof({ ...clean, treasuryAfter: 1_000_000n })
    expect(p.settled).toBe(false)
    expect(p.fault).toBe('treasury')
  })
})
