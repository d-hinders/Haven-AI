/**
 * #3297 — display prices survive a CoinGecko outage.
 *
 * A failed or partial price fetch used to value every affected token at 0 and
 * cache that total for 60 s. The portfolio now keeps the last good price per
 * symbol, backs off CoinGecko for 60 s after a failed fetch, and — when a held
 * token has no price at all — returns an uncached result (#3292's marker).
 *
 * Every test loads a FRESH portfolio module (`vi.resetModules()` + dynamic
 * import), because last-good prices and the backoff are module state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetBalance, mockCall, mockFetchTokenPrices } = vi.hoisted(() => ({
  mockGetBalance: vi.fn(),
  mockCall: vi.fn(),
  mockFetchTokenPrices: vi.fn(),
}))

vi.mock('../../../infra/chain/relayer-reads.js', () => ({
  getProvider: () => ({ getBalance: mockGetBalance, call: mockCall, provider: null }),
}))

vi.mock('../../../infra/prices.js', () => ({
  fetchTokenPrices: (...args: unknown[]) => mockFetchTokenPrices(...args),
}))

// Chain 84532 holds ETH (native) and USDC. 1 ETH and 2 USDC.
const ONE_ETH = 10n ** 18n
const TWO_USDC = '0x' + (2_000_000).toString(16).padStart(64, '0')
const GOOD = {
  ETH: { usd: 1000, eur: 900, sek: 10_000 },
  USDC: { usd: 1, eur: 0.9, sek: 10 },
}
const T0 = new Date('2026-09-25T10:00:00Z').getTime()

async function freshPortfolio() {
  vi.resetModules()
  return (await import('../portfolio.js')).fetchPortfolioForAccount
}

const account = (n: number) => '0x' + n.toString(16).padStart(40, '0')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  mockGetBalance.mockReset().mockResolvedValue(ONE_ETH)
  mockCall.mockReset().mockResolvedValue(TWO_USDC)
  mockFetchTokenPrices.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('last good prices (#3297)', () => {
  it('a FAILED fetch after the TTLs values tokens at the last good prices, not 0', async () => {
    const fetchPortfolio = await freshPortfolio()
    mockFetchTokenPrices.mockImplementation(async () => GOOD)
    expect((await fetchPortfolio(84532, account(1))).totalUsd).toBe(1002)

    vi.setSystemTime(T0 + 61_000) // past both 60 s TTLs
    mockFetchTokenPrices.mockImplementation(async () => {
      throw new Error('CoinGecko API error: 429')
    })
    const degraded = await fetchPortfolio(84532, account(1))
    expect(degraded.totalUsd).toBe(1002)
    expect(degraded.totalSek).toBe(10_020)
  })

  it('a PARTIAL 200 missing one held token values that token at its last good price', async () => {
    const fetchPortfolio = await freshPortfolio()
    mockFetchTokenPrices.mockImplementation(async () => GOOD)
    await fetchPortfolio(84532, account(2))

    vi.setSystemTime(T0 + 61_000)
    mockFetchTokenPrices.mockImplementation(async () => ({
      ETH: { usd: 2000, eur: 1800, sek: 20_000 }, // fresh
      USDC: { usd: 0, eur: 0, sek: 0 }, // "no usable quote"
    }))
    const partial = await fetchPortfolio(84532, account(2))
    const usdc = partial.breakdown.find((b) => b.symbol === 'USDC')!
    expect(usdc.usdValue).toBe(2) // last good 1 USD × 2
    expect(partial.totalUsd).toBe(2002) // fresh ETH + last-good USDC
  })

  it('NO price ever fetched: the result is NOT cached (#3292 marker) and the wire shape is unchanged', async () => {
    const fetchPortfolio = await freshPortfolio()
    mockFetchTokenPrices.mockImplementation(async () => {
      throw new Error('CoinGecko API error: 429')
    })
    const first = await fetchPortfolio(84532, account(3))
    expect(first.totalUsd).toBe(0)
    expect(Object.keys(first).sort()).toEqual(['breakdown', 'totalEur', 'totalSek', 'totalUsd'])

    await fetchPortfolio(84532, account(3))
    // Not cached: the balances were read again on the second request…
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    // …but CoinGecko was not asked again inside the backoff window.
    expect(mockFetchTokenPrices).toHaveBeenCalledTimes(1)
  })

  it('a token held at ZERO needs no price — a clean read is still cached', async () => {
    const fetchPortfolio = await freshPortfolio()
    mockGetBalance.mockResolvedValue(0n)
    mockCall.mockResolvedValue('0x' + '0'.repeat(64))
    mockFetchTokenPrices.mockImplementation(async () => {
      throw new Error('CoinGecko API error: 429')
    })
    await fetchPortfolio(84532, account(4))
    await fetchPortfolio(84532, account(4))
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
  })
})

describe('price-fetch backoff (#3297)', () => {
  it('after a failed fetch, three different accounts within 60 s make exactly ONE CoinGecko request', async () => {
    const fetchPortfolio = await freshPortfolio()
    mockFetchTokenPrices.mockImplementation(async () => {
      throw new Error('CoinGecko API error: 429')
    })
    await fetchPortfolio(84532, account(10))
    vi.setSystemTime(T0 + 20_000)
    await fetchPortfolio(84532, account(11))
    vi.setSystemTime(T0 + 59_000)
    await fetchPortfolio(84532, account(12))
    expect(mockFetchTokenPrices).toHaveBeenCalledTimes(1)
  })

  it('the backoff ends: after 60 s the next request asks CoinGecko again', async () => {
    const fetchPortfolio = await freshPortfolio()
    mockFetchTokenPrices.mockImplementation(async () => {
      throw new Error('CoinGecko API error: 429')
    })
    await fetchPortfolio(84532, account(20))
    vi.setSystemTime(T0 + 60_001)
    mockFetchTokenPrices.mockImplementation(async () => GOOD)
    expect((await fetchPortfolio(84532, account(21))).totalUsd).toBe(1002)
    expect(mockFetchTokenPrices).toHaveBeenCalledTimes(2)
  })

  it('a SUCCESSFUL fetch never starts a backoff', async () => {
    const fetchPortfolio = await freshPortfolio()
    mockFetchTokenPrices.mockImplementation(async () => GOOD)
    await fetchPortfolio(84532, account(30))
    await fetchPortfolio(84532, account(31))
    expect(mockFetchTokenPrices).toHaveBeenCalledTimes(2)
  })
})
