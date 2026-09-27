// #3296 — the unpriceable predicate the dashboard's snapshot skip reads.
//
// `isPortfolioUnpriceable` reuses #3292's module-private `degradedResults`
// marker (there is deliberately no second parallel marker) and answers
// whether a `fetchPortfolioForAccount` result was read while DEGRADED:
// a balance leg was rejected, or a held token had no usable price — missing
// from a partial CoinGecko 200 (`fetchTokenPrices` resolves without throwing
// when at least one symbol is usable) or during a thrown-then-backed-off
// fetch with no #3297 last-good quote either.
//
// ORDERING CONSTRAINTS — portfolio.ts carries module-global state, so this
// file's tests are ordered around it (do not reorder casually):
//   - the last-good price map is keyed by symbol and never resets, so the
//     two chains split the symbol space: 84532 tests price only ETH/USDC,
//     chain-100 tests only EURe — xDAI and USDC.e are never priced
//     successfully anywhere in this file, which is what lets the final
//     thrown-fetch test hold xDAI with certainty of no last-good quote;
//   - a THROWN price fetch arms the module's 60s re-fetch backoff, which
//     would make every later read in this process see `{}` prices, so the
//     throw test runs LAST;
//   - a partial (resolved) price map arms no backoff, so the partial-map
//     tests may run anywhere before it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetBalance, mockCall, mockFetchTokenPrices } = vi.hoisted(() => ({
  mockGetBalance: vi.fn(),
  mockCall: vi.fn(),
  mockFetchTokenPrices: vi.fn(),
}))

vi.mock('../../../infra/chain/relayer-reads.js', () => ({
  getProvider: () => ({ getBalance: mockGetBalance, call: mockCall, provider: null }),
}))

vi.mock('../../../infra/prices.js', () => ({
  fetchTokenPrices: mockFetchTokenPrices,
}))

const { fetchPortfolioForAccount } = await import('../portfolio.js')
// The barrel must re-export the predicate — the dashboard imports it from
// there (cross-module imports resolve to the barrel, never a deep file).
const { isPortfolioUnpriceable } = await import('../index.js')

const PRICES_84532 = {
  ETH: { usd: 1000, eur: 900, sek: 10_000 },
  USDC: { usd: 1, eur: 0.9, sek: 10 },
}
const EURE_PRICES = { usd: 1.1, eur: 1, sek: 11 }

/** balanceOf's return, ABI-encoded as a 32-byte word. */
function erc20(amount: bigint): string {
  return '0x' + amount.toString(16).padStart(64, '0')
}

const ONE_ETH = 1n * 10n ** 18n
const ONE_XDAI = 1n * 10n ** 18n

function address(suffix: string): string {
  // Exactly 40 hex chars — an address short of that makes ethers reject the
  // ERC20 balanceOf encoding, which degrades the leg the test means to pass.
  return '0x' + '0'.repeat(40 - suffix.length) + suffix
}

describe('isPortfolioUnpriceable (#3296)', () => {
  beforeEach(() => {
    mockGetBalance.mockReset()
    mockCall.mockReset()
    mockFetchTokenPrices.mockReset()
  })

  it('a clean read is priceable', async () => {
    mockFetchTokenPrices.mockResolvedValue(PRICES_84532)
    mockGetBalance.mockResolvedValue(ONE_ETH)
    mockCall.mockResolvedValue(erc20(2_000_000n)) // 2 USDC

    const portfolio = await fetchPortfolioForAccount(84532, address('c1'))

    expect(portfolio.totalUsd).toBe(1002)
    expect(isPortfolioUnpriceable(portfolio)).toBe(false)
  })

  it('a rejected balance read is unpriceable', async () => {
    mockFetchTokenPrices.mockResolvedValue(PRICES_84532)
    mockGetBalance.mockRejectedValue(new Error('native read failed'))
    mockCall.mockResolvedValue(erc20(2_000_000n)) // 2 USDC, priced fine

    const portfolio = await fetchPortfolioForAccount(84532, address('c2'))

    expect(portfolio.totalUsd).toBe(2)
    expect(isPortfolioUnpriceable(portfolio)).toBe(true)
  })

  it('a held token missing from a partial price map is unpriceable', async () => {
    // Chain 100 holds xDAI natively; the CoinGecko 200 came back partial —
    // EURe priced, xDAI absent. xDAI has no last-good quote yet either.
    mockFetchTokenPrices.mockResolvedValue({ EURe: EURE_PRICES })
    mockGetBalance.mockResolvedValue(ONE_XDAI)
    mockCall.mockResolvedValue(erc20(0n)) // EURe and USDC.e legs empty

    const portfolio = await fetchPortfolioForAccount(100, address('c3'))

    expect(portfolio.totalUsd).toBe(0)
    expect(isPortfolioUnpriceable(portfolio)).toBe(true)
  })

  it('a token absent from the price map while EMPTY is not unpriceable — the token must be held', async () => {
    mockFetchTokenPrices.mockResolvedValue({ EURe: EURE_PRICES })
    mockGetBalance.mockResolvedValue(0n)
    mockCall.mockResolvedValue(erc20(0n))

    const portfolio = await fetchPortfolioForAccount(100, address('c4'))

    expect(isPortfolioUnpriceable(portfolio)).toBe(false)
  })

  it('a held token priced from #3297 last-good prices is priceable', async () => {
    // Phase 1 prices USDC fresh (filling its last-good entry); phase 2 is a
    // partial 200 without USDC — the held USDC is valued from last-good, and
    // a last-good valuation is NOT unpriceable (#3296 "Decided here").
    mockFetchTokenPrices.mockResolvedValue(PRICES_84532)
    mockGetBalance.mockResolvedValue(0n)
    mockCall.mockResolvedValue(erc20(2_000_000n))

    const fresh = await fetchPortfolioForAccount(84532, address('c5'))
    expect(isPortfolioUnpriceable(fresh)).toBe(false)

    mockFetchTokenPrices.mockResolvedValue({ ETH: PRICES_84532.ETH })
    const fromLastGood = await fetchPortfolioForAccount(84532, address('c6'))
    expect(fromLastGood.totalUsd).toBe(2)
    expect(isPortfolioUnpriceable(fromLastGood)).toBe(false)
  })

  it('a cached clean read still reports priceable — same object from the TTL', async () => {
    mockFetchTokenPrices.mockResolvedValue(PRICES_84532)
    mockGetBalance.mockResolvedValue(ONE_ETH)
    mockCall.mockResolvedValue(erc20(2_000_000n))
    const holder = address('c7')

    const first = await fetchPortfolioForAccount(84532, holder)
    const second = await fetchPortfolioForAccount(84532, holder)

    // One set of reads: the second call was served from the cache.
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(isPortfolioUnpriceable(second)).toBe(false)
  })

  // The degraded shape of "served from the cache": #3292 evicts a degraded
  // result from the TTL immediately, so the only way a second caller receives
  // a degraded instance is getOrFetch's single-flight share — both concurrent
  // callers get the same loader result. The marker must ride THAT instance
  // (it was computed inside the loader), or a concurrent dashboard load would
  // snapshot a zero.
  it('the marker survives the result being shared from one in-flight load', async () => {
    mockFetchTokenPrices.mockResolvedValue(PRICES_84532)
    mockGetBalance.mockRejectedValue(new Error('native read failed'))
    mockCall.mockResolvedValue(erc20(2_000_000n))
    const holder = address('c8')

    const [first, concurrent] = await Promise.all([
      fetchPortfolioForAccount(84532, holder),
      fetchPortfolioForAccount(84532, holder),
    ])

    // Single-flight: one loader run served both callers.
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    expect(concurrent).toBe(first)
    expect(isPortfolioUnpriceable(first)).toBe(true)
    expect(isPortfolioUnpriceable(concurrent)).toBe(true)
  })

  // LAST: the throw arms portfolio.ts's 60s re-fetch backoff, and xDAI was
  // deliberately never priced earlier in this file, so the held xDAI has no
  // fresh quote and no last-good quote either.
  it('a rejected price fetch is unpriceable for a held token', async () => {
    mockFetchTokenPrices.mockRejectedValue(new Error('CoinGecko 429'))
    mockGetBalance.mockResolvedValue(ONE_XDAI)
    mockCall.mockResolvedValue(erc20(0n))

    const portfolio = await fetchPortfolioForAccount(100, address('c9'))

    expect(portfolio.totalUsd).toBe(0)
    expect(isPortfolioUnpriceable(portfolio)).toBe(true)
  })
})
