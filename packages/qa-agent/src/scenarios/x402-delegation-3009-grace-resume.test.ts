import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Wallet } from 'ethers'
import type { ScenarioContext } from './types.js'

const DELEGATE_KEY = `0x${'11'.repeat(32)}`
const DELEGATE = new Wallet(DELEGATE_KEY).address
const TREASURY = `0x${'aa'.repeat(20)}`
const MERCHANT = `0x${'bb'.repeat(20)}`
const MERCHANT_TX = `0x${'f2'.repeat(32)}`

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
  mockListReceipts,
  mockGetReceipt,
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
  mockListReceipts: vi.fn(),
  mockGetReceipt: vi.fn(),
}))

vi.mock('@haven_ai/sdk', async (importOriginal) => ({
  // The REAL parseMerchantSettlement (#4119) decodes the resumed response's
  // PAYMENT-RESPONSE header; only the client and the signing helpers are stubbed.
  ...(await importOriginal<typeof import('@haven_ai/sdk')>()),
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
    listReceipts = mockListReceipts
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
      JsonRpcProvider: class { getTransactionReceipt = mockGetReceipt },
      Contract: class { balanceOf = mockBalanceOf },
    },
  }
})

const { x402Delegation3009GraceResume, evaluateResumeMoneyProof, TIMING } = await import(
  './x402-delegation-3009-grace-resume.js'
)
const { ATTRIBUTION_WINDOW_MS } = await import('../lib/settlement-record.js')

TIMING.receiptWaitMs = 60
TIMING.receiptPollMs = 20

/** The merchant's base64-JSON PAYMENT-RESPONSE header naming its settlement transaction. */
const paymentResponse = (transaction: string) =>
  Buffer.from(JSON.stringify({ success: true, transaction, network: 'eip155:84532' })).toString('base64')

/** The resumed merchant response: served, with the settlement in PAYMENT-RESPONSE unless overridden. */
const resumedResponse = (
  headers: Record<string, string> = { 'PAYMENT-RESPONSE': paymentResponse(MERCHANT_TX) },
  result: Record<string, unknown> = { content: [{ text: 'paid' }] },
) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers })

/** The leg's own recovery read: confirmed funding, no merchant retry yet. */
const RECOVERY = {
  ok: true,
  status: 200,
  data: { phase: 'funded_but_unsettled', next_action: 'retry_original_x402_request' },
}

/** After the resume: settled, with or without the #4119 record flag. */
const settledStatus = (recorded: boolean) => ({
  ok: true,
  status: 200,
  data: { payment_id: 'pay_2159', phase: 'settled', next_action: 'none', ...(recorded ? { merchant_settlement_recorded: true } : {}) },
})

/**
 * The status stub is SEQUENCED by event (#4119 test trap): every read before
 * the resume is the leg's own recovery read, `funded_but_unsettled` — which
 * can never carry the record flag (agent-payment-status.ts) — and every read
 * after it is the settled answer `afterResume` decides.
 */
function statusAroundResume(afterResume: () => ReturnType<typeof settledStatus>) {
  mockStatus.mockImplementation(async () => (mockResume.mock.calls.length === 0 ? RECOVERY : afterResume()))
}

/** Drive a run on a fake clock so the REAL 45 s attribution window is exercised. */
async function onFakeClock<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    let done = false
    const pending = run().finally(() => {
      done = true
    })
    for (let step = 0; step < 2_000 && !done; step++) await vi.advanceTimersByTimeAsync(250)
    if (!done) throw new Error('the run did not settle within 500 s of fake time')
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

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
  // clearAllMocks keeps queued once-values; a run that failed before reading
  // its "after" balances would leak them into the next test.
  mockBalanceOf.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockResolvedValue(new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': 'x' } }))
  mockGetAgent.mockResolvedValue({ ok: true, data: { account_address: TREASURY } })
  mockAuthorize.mockResolvedValue({
    ok: true, status: 201,
    data: { payment_id: 'pay_2159', sign_data: { signature_scheme: 'eip712_userop', typed_data: {} } },
  })
  mockSignTyped.mockResolvedValue('0xsigned')
  mockSign.mockResolvedValue({ ok: true, status: 200, data: {} })
  mockPoll.mockResolvedValue({ status: 'confirmed', tx_hash: '0xfunding' })
  statusAroundResume(() => settledStatus(true))
  mockResume.mockImplementation(async () => resumedResponse())
  mockListReceipts.mockResolvedValue({
    ok: true,
    status: 200,
    data: { receipts: [{ payment_id: 'pay_2159', tx_hash: '0xfunding', settlement_tx_hash: MERCHANT_TX }] },
  })
  mockGetReceipt.mockResolvedValue({ status: 1, blockNumber: 45_212_857 })
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
    // By address, so the proof's polling may read any number of times: the
    // treasury pays 0.001, the merchant receives only 0.0005, and the other
    // 0.0005 stays on the delegate — which the cleanup then finds and sweeps.
    const reads = new Map<string, number>()
    mockBalanceOf.mockReset().mockImplementation(async (address: string) => {
      const n = reads.get(address) ?? 0
      reads.set(address, n + 1)
      if (address === TREASURY) return n === 0 ? 1_000_000n : 999_000n
      return n === 0 ? 0n : 500n // merchant and delegate alike
    })
    // On the fake clock the money proof's REAL 30 s wait runs out; this used
    // to spy `Date.now` call by call, which any new clock read (#4119) shifted.
    const result = await onFakeClock(() => x402Delegation3009GraceResume.run(ctx()))
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

describe('Haven recorded the resumed merchant settlement (#4119)', () => {
  it('passes, and the PASS line shows the recorded hash', async () => {
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(true)
    expect(result.detail).toContain(`merchant settlement recorded: ${MERCHANT_TX}`)
    expect(result.detail).toMatch(/from PAYMENT-RESPONSE/)
    expect(mockGetReceipt).toHaveBeenCalledWith(MERCHANT_TX)
  })

  it('FAILS when the settled status never carries merchant_settlement_recorded, naming the payment', async () => {
    statusAroundResume(() => settledStatus(false))
    const result = await onFakeClock(() => x402Delegation3009GraceResume.run(ctx()))
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/did not record the merchant settlement of payment pay_2159/)
    expect(result.detail).not.toMatch(/TypeError|is not a function/)
  })

  it('FAILS on a late record: absent until after anchor + 45 s, present afterwards', async () => {
    // The anchor is the funding submit (signPayment): here the funding
    // confirms BEFORE the resume, so a timestamp before the resume would not
    // bound the sweep's 60 s floor.
    let fundedAt = Number.NaN
    mockSign.mockImplementation(async () => {
      fundedAt = Date.now()
      return { ok: true, status: 200, data: {} }
    })
    statusAroundResume(() => settledStatus(Date.now() > fundedAt + ATTRIBUTION_WINDOW_MS))
    const result = await onFakeClock(() => x402Delegation3009GraceResume.run(ctx()))
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/pay_2159/)
  })

  it('anchors on the funding submit: a resume that returns past the window is not attributable', async () => {
    // Funding submit at t, resume returning at t + 50 s with the record
    // already present: the #3888 sweep could have made it, so it is red.
    mockResume.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50_000))
      return resumedResponse()
    })
    const result = await onFakeClock(() => x402Delegation3009GraceResume.run(ctx()))
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/cannot be told apart from the #3888 sweep/)
  })

  it('FAILS when Haven recorded a DIFFERENT hash, beside a true flag', async () => {
    mockListReceipts.mockResolvedValue({
      ok: true,
      status: 200,
      data: { receipts: [{ payment_id: 'pay_2159', settlement_tx_hash: `0x${'e9'.repeat(32)}` }] },
    })
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/attributed another transaction to this payment/)
  })

  it('stays green on a case-only hash difference', async () => {
    mockListReceipts.mockResolvedValue({
      ok: true,
      status: 200,
      data: { receipts: [{ payment_id: 'pay_2159', settlement_tx_hash: MERCHANT_TX.toUpperCase().replace('0X', '0x') }] },
    })
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(true)
  })

  it('falls back to the tool result _meta when PAYMENT-RESPONSE carries no transaction', async () => {
    mockResume.mockImplementation(async () =>
      resumedResponse({}, { content: [{ text: 'paid' }], _meta: { 'x402/payment-response': { success: true, transaction: MERCHANT_TX } } }),
    )
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(true)
    expect(result.detail).toMatch(/from _meta/)
  })

  it('FAILS when the resumed response names no settlement transaction', async () => {
    mockResume.mockImplementation(async () => resumedResponse({}))
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/named no settlement transaction/)
  })

  it('FAILS when the merchant settlement REVERTED on-chain', async () => {
    mockGetReceipt.mockResolvedValue({ status: 0, blockNumber: 1 })
    const result = await x402Delegation3009GraceResume.run(ctx())
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/REVERTED on-chain/)
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
