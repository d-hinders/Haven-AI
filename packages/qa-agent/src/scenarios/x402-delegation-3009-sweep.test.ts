/**
 * The classification rules in `x402-delegation-3009-sweep` (#946).
 *
 * This scenario's hard part is not the happy path — it is telling an unmet
 * PRECONDITION apart from a real sweep REGRESSION. A merchant that settles
 * normally, or a dev backend whose sweep floor is above the QA amount, must
 * produce SKIP; funds that stay on the delegate after a "successful" sweep must
 * produce FAIL. Get that backwards in either direction and the scenario is
 * worse than absent: it either cries wolf daily or hides the one outcome it
 * exists to catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Wallet, verifyTypedData } from 'ethers'
import type { ScenarioContext } from './types.js'

const DELEGATE_KEY = '0x' + '11'.repeat(32)
const DELEGATE = new Wallet(DELEGATE_KEY).address
const MERCHANT_URL = 'https://demo-merchant.example'

const { mockFetch, mockPrepareSweep, mockSubmitSweep, mockBalanceOf, mockBuildTypedData } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockPrepareSweep: vi.fn(),
    mockSubmitSweep: vi.fn(),
    mockBalanceOf: vi.fn(),
    mockBuildTypedData: vi.fn(),
  }))

vi.mock('@haven_ai/sdk', () => ({
  HavenClient: class {
    fetch = mockFetch
    prepareSweep = mockPrepareSweep
    submitSweep = mockSubmitSweep
  },
  buildSweepTypedData: mockBuildTypedData,
}))
vi.mock('ethers', async (importOriginal) => {
  // Wallet stays REAL: the delegate address under assertion must be the genuine
  // one, and `signTypedData` is exercised against real typed data below.
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

const { x402Delegation3009Sweep, SWEEP_TIMING } = await import('./x402-delegation-3009-sweep.js')

SWEEP_TIMING.strandWaitMs = 60
SWEEP_TIMING.pollIntervalMs = 20

const STRANDED = 500_000n // 0.5 USDC

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
  mockFetch.mockResolvedValue({ ok: true, status: 200 })
  mockBalanceOf.mockResolvedValue(STRANDED)
  mockPrepareSweep.mockResolvedValue({
    authorization: { from: DELEGATE, value: String(STRANDED) },
    min_usdc: '0',
  })
  mockBuildTypedData.mockReturnValue({
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: '0x' + 'bb'.repeat(20) },
    types: { Transfer: [{ name: 'from', type: 'address' }] },
    message: { from: DELEGATE },
  })
  mockSubmitSweep.mockResolvedValue({ amount: '0.5', tx_hash: '0x' + 'ab'.repeat(32) })
})

describe('preconditions skip rather than fail', () => {
  it.each([
    ['no demo-merchant URL', { demoMerchantUrl: undefined }],
    ['no delegation api key', { delegationAgentApiKey: undefined }],
    ['no delegation delegate key', { delegationDelegateKey: undefined }],
  ])('skips with %s', async (_name, over) => {
    const r = await x402Delegation3009Sweep.run(ctx(over))
    expect(r.skipped).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('unmet precondition vs. real regression', () => {
  it('SKIPS when nothing was stranded — the merchant settled after all', async () => {
    // Not a sweep failure. Reporting this as FAIL would make the daily run red
    // whenever MERCHANT_SKIP_SETTLE_PRODUCT is unset, which trains people to
    // ignore this line.
    mockBalanceOf.mockResolvedValue(0n)
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.skipped).toBe(true)
    expect(r.detail).toMatch(/MERCHANT_SKIP_SETTLE_PRODUCT/)
    expect(mockPrepareSweep).not.toHaveBeenCalled()
  })

  it('SKIPS when the stranding is below the backend sweep floor', async () => {
    mockPrepareSweep.mockResolvedValue({ below_min: true, min_usdc: '1' })
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.skipped).toBe(true)
    expect(r.detail).toMatch(/SWEEP_MIN_USDC=0/)
  })

  it('SKIPS when the delegate drained to zero before the sweep could run', async () => {
    mockSubmitSweep.mockRejectedValue(new Error('transfer amount exceeds balance'))
    mockBalanceOf.mockResolvedValueOnce(STRANDED).mockResolvedValue(0n)
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.skipped).toBe(true)
    expect(r.detail).toMatch(/settled instead of verify-without-settle/)
  })

  it('FAILS when the submit errored and the money is still sitting there', async () => {
    // Same exception as the case above, opposite classification — the balance
    // afterwards is what separates them.
    mockSubmitSweep.mockRejectedValue(new Error('relayer out of gas'))
    mockBalanceOf.mockResolvedValue(STRANDED)
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/gasless sweep submit failed/)
  })

  it('FAILS when the backend disagrees that anything is stranded', async () => {
    mockPrepareSweep.mockResolvedValue({ nothing_stranded: true, min_usdc: '0' })
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/RPC discrepancy/)
  })
})

describe('the outcome is what is LEFT, not that submit returned', () => {
  it('FAILS when the sweep reports success but the funds never moved', async () => {
    // The assertion that stops this scenario trusting its own tooling: a sweep
    // that returns a tx hash while the delegate still holds the money is
    // exactly the regression worth catching.
    mockPrepareSweep.mockResolvedValue({
      authorization: { from: DELEGATE, value: String(STRANDED) },
      min_usdc: '1',
    })
    mockBalanceOf.mockResolvedValue(STRANDED * 4n) // 2 USDC, above the 1 USDC floor
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/still holds .* stranding, not dust/)
  })

  it('passes when the delegate is left below the floor', async () => {
    mockBalanceOf.mockResolvedValueOnce(STRANDED).mockResolvedValue(0n)
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.pass).toBe(true)
    expect(r.skipped).toBeFalsy()
    expect(r.detail).toMatch(/returned 0\.5 USDC to the treasury/)
  })

  it('signs with the DELEGATION delegate key, not the legacy one', async () => {
    // The two identities are different accounts. Signing with the seeded
    // legacy key would produce an authorization the delegation-rail delegate
    // never authorised — and no address assertion here would catch it.
    await x402Delegation3009Sweep.run(ctx())
    expect(mockSubmitSweep).toHaveBeenCalledTimes(1)
    const [, signature] = mockSubmitSweep.mock.calls[0]
    const typed = mockBuildTypedData.mock.results[0].value
    const recovered = verifyTypedData(typed.domain, typed.types, typed.message, signature)
    expect(recovered).toBe(DELEGATE)
  })
})

describe('the merchant call itself', () => {
  it('fails when the verify-without-settle call errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 })
    const r = await x402Delegation3009Sweep.run(ctx())
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/HTTP 500/)
  })
})
