import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// db-mock-exempt: this file mocks the chain-RPC provider (relayer-reads
// getProvider), never db.js — the positional chains counted here sit on the
// ERC-20 `call` mock, which is exactly the collaborator-a-test-does-not-own
// case scripts/db-mock-ratchet.mjs sanctions (chain RPC, not the database).
const { mockGetBalance, mockCall } = vi.hoisted(() => ({
  mockGetBalance: vi.fn(),
  mockCall: vi.fn(),
}))

vi.mock('../../../infra/chain/relayer-reads.js', () => ({
  getProvider: () => ({ getBalance: mockGetBalance, call: mockCall, provider: null }),
}))

vi.mock('../../../infra/prices.js', () => ({
  fetchTokenPrices: async () => ({
    ETH: { usd: 1000, eur: 900, sek: 10_000 },
    USDC: { usd: 1, eur: 0.9, sek: 10 },
  }),
}))

const { fetchPortfolioForAccount } = await import('../portfolio.js')
const { resetLastKnownBalancesForTests } = await import('../balance-freshness.js')
// balanceOf returning 2 USDC (6 decimals), ABI-encoded.
const TWO_USDC = '0x' + (2_000_000).toString(16).padStart(64, '0')
// balanceOf returning 5 USDC (6 decimals), ABI-encoded.
const FIVE_USDC = '0x' + (5_000_000).toString(16).padStart(64, '0')

// The 60 s portfolio cache would otherwise serve the first clean read to the
// later degraded call; a shifted Date.now expires it deterministically. The
// last-known store timestamps with `new Date()`, not Date.now(), so its as-of
// values stay real.
let clockOffsetMs = 0
const realDateNow = Date.now.bind(Date)

function expirePortfolioCache() {
  clockOffsetMs += 61_000
}

function usdcEntry(portfolio: Awaited<ReturnType<typeof fetchPortfolioForAccount>>) {
  return portfolio.breakdown.find((t) => t.symbol === 'USDC')!
}

describe('fetchPortfolioForAccount — a failed balance read serves the last-known balance (#3295)', () => {
  beforeEach(() => {
    clockOffsetMs = 0
    vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + clockOffsetMs)
    resetLastKnownBalancesForTests()
    mockGetBalance.mockReset().mockResolvedValue(0n)
    mockCall.mockReset().mockResolvedValue(TWO_USDC)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('after a good read, a failed read returns the last-known balance marked stale, not zero', async () => {
    const address = '0x00000000000000000000000000000000000000b1'

    const good = await fetchPortfolioForAccount(84532, address)
    expect(usdcEntry(good).balance).toBe('2000000')
    expect(usdcEntry(good).balanceFreshness).toBeUndefined()

    expirePortfolioCache()
    // The dRPC free-plan refusal that zeroed the dashboard (#2769).
    mockCall.mockRejectedValueOnce(new Error('Batch of more than 3 requests are not allowed on free plan'))
    const degraded = await fetchPortfolioForAccount(84532, address)
    expect(usdcEntry(degraded).balance).toBe('2000000')
    expect(usdcEntry(degraded).balanceFreshness).toEqual({ status: 'stale', asOf: expect.any(String) })
    // The native read stayed clean: no marker on that entry.
    expect(degraded.breakdown.find((t) => t.symbol === 'ETH')!.balanceFreshness).toBeUndefined()
  })

  it('with no prior good read, the entry stays present with a string balance, marked unavailable', async () => {
    const address = '0x00000000000000000000000000000000000000b2'
    mockCall.mockRejectedValue(new Error('RPC down'))

    const degraded = await fetchPortfolioForAccount(84532, address)
    const usdc = usdcEntry(degraded)
    // Additive only: the token entry survives, `balance` is still a decimal
    // string, address/decimals intact — the token registry shape holds.
    expect(usdc.symbol).toBe('USDC')
    expect(typeof usdc.balance).toBe('string')
    expect(usdc.balance).toBe('0')
    expect(usdc.balanceFreshness).toEqual({ status: 'unavailable' })
  })

  it('a clean read sets no marker and refreshes the last-known value', async () => {
    const address = '0x00000000000000000000000000000000000000b3'

    mockCall.mockResolvedValueOnce(TWO_USDC)
    const first = await fetchPortfolioForAccount(84532, address)
    expect(usdcEntry(first).balanceFreshness).toBeUndefined()

    expirePortfolioCache()
    mockCall.mockResolvedValueOnce(FIVE_USDC)
    const second = await fetchPortfolioForAccount(84532, address)
    expect(usdcEntry(second).balance).toBe('5000000')
    expect(usdcEntry(second).balanceFreshness).toBeUndefined()

    expirePortfolioCache()
    mockCall.mockRejectedValueOnce(new Error('RPC down'))
    const degraded = await fetchPortfolioForAccount(84532, address)
    // The stored last-known value is the FRESH 5 USDC, not the earlier 2.
    expect(usdcEntry(degraded).balance).toBe('5000000')
    expect(usdcEntry(degraded).balanceFreshness!.status).toBe('stale')
  })

  it('a failed read is still not cached, so the next request re-reads the chain (#3292 intact)', async () => {
    const address = '0x00000000000000000000000000000000000000b4'
    mockCall.mockResolvedValueOnce(TWO_USDC)
    await fetchPortfolioForAccount(84532, address)

    expirePortfolioCache()
    mockCall.mockRejectedValueOnce(new Error('RPC down'))
    const degraded = await fetchPortfolioForAccount(84532, address)
    expect(usdcEntry(degraded).balanceFreshness!.status).toBe('stale')

    mockCall.mockResolvedValueOnce(FIVE_USDC)
    const recovered = await fetchPortfolioForAccount(84532, address)
    expect(usdcEntry(recovered).balance).toBe('5000000')
    expect(usdcEntry(recovered).balanceFreshness).toBeUndefined()
  })
})
