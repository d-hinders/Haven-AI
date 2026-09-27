/**
 * #3297 criterion 5 — the display portfolio's last-good prices never reach
 * book-time fiat valuation.
 *
 * `getTokenPrice` / `getBookTimeCapture` value payments at book time; a stale
 * rate there would be stamped as spot and frozen into the accounting feed, so a
 * pricing outage must stay "reject / null, backfillable". These tests use the
 * REAL `infra/prices.ts` and `infra/fiat-values.ts` with only `global.fetch`
 * mocked (`fiat-values.test.ts` mocks `../prices.js` wholesale and cannot prove
 * this), and they first make the portfolio module — in the SAME module graph —
 * hold a last-good price, so the isolation is tested with something to leak.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../chain/relayer-reads.js', () => ({
  getProvider: () => ({
    getBalance: async () => 10n ** 18n,
    call: async () => '0x' + (2_000_000).toString(16).padStart(64, '0'),
    provider: null,
  }),
}))

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}
function errorResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response
}

const GOOD = {
  ethereum: { usd: 1000, eur: 900, sek: 10_000 },
  'usd-coin': { usd: 1, eur: 0.9, sek: 10 },
}
const T0 = new Date('2026-09-25T10:00:00Z').getTime()

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function loadAll() {
  const prices = await import('../prices.js')
  const fiat = await import('../fiat-values.js')
  const { fetchPortfolioForAccount } = await import('../../modules/accounts/portfolio.js')
  return { ...prices, ...fiat, fetchPortfolioForAccount }
}

describe('book-time valuation ignores the display last-good prices (#3297)', () => {
  it('after a good fetch and a failed one, the portfolio shows last-good while getTokenPrice still REJECTS and getBookTimeCapture is still NULL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(GOOD))
    const { getTokenPrice, getBookTimeCapture, fetchPortfolioForAccount } = await loadAll()

    // A good fetch populates BOTH the price cache and the portfolio's last-good.
    const good = await fetchPortfolioForAccount(84532, '0x' + '0'.repeat(39) + '1')
    expect(good.totalUsd).toBe(1002)
    expect((await getTokenPrice('USDC')).usd).toBe(1)

    // Past the TTLs; CoinGecko now answers 429.
    vi.setSystemTime(T0 + 61_000)
    fetchSpy.mockResolvedValue(errorResponse(429))

    // The display path uses its last-good prices…
    const display = await fetchPortfolioForAccount(84532, '0x' + '0'.repeat(39) + '2')
    expect(display.totalUsd).toBe(1002)

    // …and the book-time path does not: reject, and null (backfillable).
    await expect(getTokenPrice('USDC')).rejects.toThrow(/CoinGecko API error: 429/)
    expect(await getBookTimeCapture('USDC', '1.5')).toBeNull()
  })
})
