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

const { mockFetch, mockListReceipts, mockGetAgent, mockBalanceOf } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockListReceipts: vi.fn(),
  mockGetAgent: vi.fn(),
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
    getAgent = mockGetAgent
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

const { x402Delegation3009, TIMING, classifyDelegateResidual } = await import(
  './x402-delegation-3009.js'
)

// Real values here would make each no-evidence-row case sit out a 20s wait.
TIMING.evidenceWaitMs = 60
TIMING.pollIntervalMs = 20
TIMING.deliveryWaitMs = 60

/** A merchant response that succeeds — so only the evidence assertions can fail. */
const okMerchantResponse = () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ content: [{ text: 'VPN basic purchased' }] }),
})

const TREASURY = '0x' + 'a1'.repeat(20)

const receipt = (over: Record<string, unknown> = {}) => ({
  payment_id: 'pay_new',
  resource_url: MCP_URL,
  settlement_scheme: 'eip3009',
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
      paymentTo: '0x' + 'dd'.repeat(20),
      demoMerchantUrl: MERCHANT_URL,
      delegationAgentApiKey: 'sk_agent_delegation',
      delegationDelegateKey: DELEGATE_KEY,
      ...over,
    },
  }
}

// The scenario reads receipts twice: once BEFORE the payment (the baseline of
// ids that already exist) and then polling AFTER it. `settled` wires that
// sequence: an empty baseline, then whatever rows the case wants to appear.
function settled(rows: Record<string, unknown>[]) {
  mockListReceipts.mockReset()
  mockListReceipts.mockResolvedValueOnce({ ok: true, data: { receipts: [] } })
  mockListReceipts.mockResolvedValue({ ok: true, data: { receipts: rows } })
}

// Treasury before → delegate baseline → treasury after → delegate residual.
// The treasury must fall, or the budget was never metered; the delegate
// baseline is what the SHARED EOA already held before this payment (#2444),
// so a neighbour's leftovers are not charged to this run.
function balances(before = 1_000_000n, after = 999_000n, residual = 0n, delegateBaseline = 0n) {
  mockBalanceOf.mockReset()
  mockBalanceOf.mockResolvedValueOnce(before)
  mockBalanceOf.mockResolvedValueOnce(delegateBaseline)
  mockBalanceOf.mockResolvedValueOnce(after)
  mockBalanceOf.mockResolvedValue(residual)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(okMerchantResponse())
  mockGetAgent.mockResolvedValue({ ok: true, data: { safe_address: TREASURY } })
  settled([receipt()])
  balances()
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
    settled([
      receipt({ settlement_scheme: 'erc7710', settlement_address: MERCHANT }),
    ])
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/not "eip3009"/)
  })

  it('FAILS when the scheme was never recorded', async () => {
    settled([receipt({ settlement_scheme: undefined })])
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/absent/)
  })

  it('FAILS when no evidence row appears — two legs that cannot be reconciled', async () => {
    settled([])
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no NEW evidence row/)
  })

  it('ignores a receipt that already existed before this run', async () => {
    // Matching "the newest row" would let a previous run's payment satisfy
    // this run's assertions. Identity is by id-not-in-baseline, never by clock.
    // The row already existed before the payment, so it is not this run's.
    mockListReceipts.mockReset()
    mockListReceipts.mockResolvedValue({ ok: true, data: { receipts: [receipt()] } })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/no NEW evidence row/)
  })
})

describe('the two-leg shape', () => {
  it('FAILS when Haven funded something other than the delegate EOA', async () => {
    settled([receipt({ settlement_address: '0x' + 'ff'.repeat(20) })])
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/not the delegate EOA/)
  })

  it('FAILS when the merchant is indistinguishable from the funding target', async () => {
    // The security model requires these recorded separately, so a funding hop
    // can never be read as a merchant payment.
    settled([receipt({ merchant_address: DELEGATE })])
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/indistinguishable from a merchant payment/)
  })

  it('compares addresses case-insensitively — checksum casing is not a failure', async () => {
    settled([receipt({ settlement_address: DELEGATE.toLowerCase() })])
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
  })
})

describe('the budget was actually metered', () => {
  it('FAILS when the treasury did not move — a funding leg that spent no budget', async () => {
    // #946's acceptance criteria name budget decrement explicitly, and none of
    // the address checks would notice: they describe the SHAPE of the transfer,
    // not that value left the account. Treasury USDC only moves through the
    // caveat-enforced redemption.
    balances(1_000_000n, 1_000_000n, 0n)
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/budget delegation was not metered/)
  })

  it('FAILS when the treasury somehow INCREASED', async () => {
    balances(1_000_000n, 1_500_000n, 0n)
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/did not decrease/)
  })

  it('reports the treasury movement in the pass detail', async () => {
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/treasury 1\.0 → 0\.999/)
  })

  it('fails cleanly when the account address cannot be read', async () => {
    mockGetAgent.mockResolvedValue({ ok: true, data: {} })
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/could not read the agent's account address/)
  })
})

describe('residuals', () => {
  it('passes with a zero residual', async () => {
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/0 residual/)
  })

  it('passes with sub-floor dust, and says so', async () => {
    // A balance below the 0.01 USDC sweep floor remains visible rather than
    // silently tolerated until later stranded funds bring it to the threshold.
    // The 0.01 USDC funded here is deliberately LARGER than the 0.005 residue:
    // residue smaller than the payment is genuine rounding dust, whereas
    // residue that reaches the payment is the payment (see #2444 below).
    balances(1_000_000n, 990_000n, 5_000n)
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/0\.005 USDC sub-floor dust/)
  })

  it('FAILS at or above the sweep floor — that is stranding, not dust', async () => {
    balances(2_000_000n, 1_000_000n, 10_000n) // exactly 0.01 USDC left on the EOA
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/stranding, not dust/)
  })

  it('does not charge a neighbour’s pre-existing balance to this payment', async () => {
    // The delegate EOA is shared. 0.005 was already sitting there before this
    // payment funded and settled, so the residual is someone else's and this
    // scenario reports a clean run rather than inventing dust of its own.
    balances(1_000_000n, 999_000n, 5_000n, 5_000n)
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/0 residual/)
  })
})

/**
 * #2444 — the defect this scenario shipped with for four days.
 *
 * `buy_vpn/basic` costs 0.001 USDC and the sweep floor is 0.01, so a delegate
 * still holding the ENTIRE undelivered payment sat below the floor, was logged
 * as "sub-floor dust", and the scenario declared PASS with the money in flight.
 * The late merchant leg then landed inside the measurement window of
 * `x402-delegation-3009-grace-resume`, which runs next against the same EOA and
 * the same merchant, and produced the failure text in run 33640693154.
 *
 * The end-to-end ordering only reproduces with two scenarios adjacent against a
 * live testnet, which no unit test can stage. What a unit test CAN pin is the
 * predicate that let it through: a residual equal to the scenario's own payment
 * must never classify as dust, at any floor.
 */
describe('delivery is a different question from dust (#2444)', () => {
  const FUNDED = 1_000n // 0.001 USDC — buy_vpn/basic, the live amount

  it('does not classify the scenario’s own undelivered payment as dust', () => {
    const v = classifyDelegateResidual({ residual: FUNDED, baseline: 0n, funded: FUNDED })
    expect(v.undelivered).toBe(true)
    expect(v.dust).toBe(false)
    expect(v.caused).toBe(FUNDED)
  })

  it('holds even though the payment is far below the 0.01 USDC sweep floor', () => {
    // This is the whole mechanism: the floor answers "is this negligible?" and
    // says yes, correctly, about an amount that is the entire transaction.
    const v = classifyDelegateResidual({ residual: FUNDED, baseline: 0n, funded: FUNDED })
    expect(v.stranded).toBe(false) // under the floor — the old gate's only test
    expect(v.undelivered).toBe(true) // and still not something to pass on
  })

  it('measures against the baseline, so a neighbour’s residue is not this payment', () => {
    // 0.0005 already there, this payment's 0.001 delivered: caused is 0.
    const v = classifyDelegateResidual({ residual: 500n, baseline: 500n, funded: FUNDED })
    expect(v.undelivered).toBe(false)
    expect(v.dust).toBe(false)
    expect(v.caused).toBe(0n)
  })

  it('clamps at zero when the shared EOA got CLEANER during the window', () => {
    // A neighbour's older balance was swept or delivered. Negative "caused"
    // would otherwise underflow the comparisons into nonsense.
    const v = classifyDelegateResidual({ residual: 0n, baseline: 5_000n, funded: FUNDED })
    expect(v.caused).toBe(0n)
    expect(v.undelivered).toBe(false)
    expect(v.stranded).toBe(false)
  })

  it('still calls genuine sub-payment residue dust', () => {
    const v = classifyDelegateResidual({ residual: 400n, baseline: 0n, funded: FUNDED })
    expect(v.dust).toBe(true)
    expect(v.undelivered).toBe(false)
  })

  it('never reports undelivered when nothing was funded', () => {
    // Guards the degenerate divide: a zero treasury delta is already a hard
    // failure upstream, and must not additionally read as "held back 0 USDC".
    const v = classifyDelegateResidual({ residual: 0n, baseline: 0n, funded: 0n })
    expect(v.undelivered).toBe(false)
  })

  it('FAILS the scenario end to end when the payment never leaves the delegate', async () => {
    // The live shape: 0.001 funded, 0.001 still on the delegate at the deadline.
    // Before #2444 this run reported PASS with "0.001 USDC sub-floor dust".
    balances(1_000_000n, 999_000n, 1_000n)
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/still in flight/)
    // The old pass wording, which this shape used to produce. The failure text
    // deliberately says "not sub-floor dust", so match the pass phrasing.
    expect(r.detail).not.toMatch(/left by design/)
  })

  it('PASSES when the late merchant leg lands inside the delivery wait', async () => {
    // The wait is a poll, not a fixed sleep: the facilitator settles outside
    // Haven's view, so a leg that lands a second later is a pass, not a race.
    mockBalanceOf.mockReset()
    mockBalanceOf
      .mockResolvedValueOnce(1_000_000n) // treasury before
      .mockResolvedValueOnce(0n) // delegate baseline
      .mockResolvedValueOnce(999_000n) // treasury after
      .mockResolvedValueOnce(1_000n) // still undelivered
      .mockResolvedValue(0n) // then it lands
    const r = await x402Delegation3009.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.detail).toMatch(/0 residual/)
  })
})
