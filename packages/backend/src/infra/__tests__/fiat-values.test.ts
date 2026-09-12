import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBookTimeCapture, FX_SOURCE_SPOT } from '../fiat-values.js'
import { getTokenPrice } from '../prices.js'

vi.mock('../prices.js', () => ({ getTokenPrice: vi.fn() }))
const mockedGetTokenPrice = vi.mocked(getTokenPrice)

afterEach(() => vi.clearAllMocks())

const FULL = { usd: 1, eur: 0.9, sek: 10.6, dkk: 6.87, nok: 10.9, gbp: 0.79 }

/**
 * The settlement-time capture. Every case below was a case of
 * `getBookTimeSekValue`, which #2877 folded into this function so that one
 * price read serves the SEK columns and the ledger rate map — two reads could
 * straddle the 60 s price cache and put a timestamp from one fetch beside
 * rates from another. The SEK half's contract is unchanged and is asserted
 * here in the same four shapes it always was.
 */
describe('getBookTimeCapture', () => {
  it('returns the SEK value, rate and source — the SEK half, unchanged', async () => {
    mockedGetTokenPrice.mockResolvedValue(FULL)
    const v = await getBookTimeCapture('USDC', '12.5')
    expect(v?.sek).toEqual({ amountSek: 132.5, fxRate: 10.6, fxSource: FX_SOURCE_SPOT })
  })

  it('returns a rate for every supported currency that had a usable quote, from the one read', async () => {
    mockedGetTokenPrice.mockResolvedValue(FULL)
    const v = await getBookTimeCapture('USDC', '12.5')
    expect(v?.rates).toEqual({ SEK: 10.6, EUR: 0.9, USD: 1, DKK: 6.87, NOK: 10.9, GBP: 0.79 })
    expect(v?.fxSource).toBe(FX_SOURCE_SPOT)
    // MUTATION TARGET: read the price twice (one call per half) and this stops
    // being provable — the halves could come from different fetches.
    expect(mockedGetTokenPrice).toHaveBeenCalledTimes(1)
  })

  it('drops a currency with no usable quote, and keeps the rest', async () => {
    mockedGetTokenPrice.mockResolvedValue({ ...FULL, dkk: 0, gbp: Number.NaN })
    const v = await getBookTimeCapture('USDC', '12.5')
    expect(v?.rates).toEqual({ SEK: 10.6, EUR: 0.9, USD: 1, NOK: 10.9 })
  })

  it('a non-positive or unparseable amount kills the SEK half only — the rates still stand', async () => {
    mockedGetTokenPrice.mockResolvedValue(FULL)
    expect((await getBookTimeCapture('USDC', '0'))?.sek).toBeNull()
    const v = await getBookTimeCapture('USDC', 'not-a-number')
    expect(v?.sek).toBeNull()
    expect(v?.rates.SEK).toBe(10.6)
  })

  it('no SEK rate is null for the SEK half, never a bogus zero', async () => {
    mockedGetTokenPrice.mockResolvedValue({ ...FULL, sek: 0 })
    const v = await getBookTimeCapture('USDC', '12.5')
    expect(v?.sek).toBeNull()
    expect(v?.rates.SEK).toBeUndefined()
    expect(v?.rates.EUR).toBe(0.9)
  })

  it('returns null when nothing at all was usable', async () => {
    mockedGetTokenPrice.mockResolvedValue({ usd: 0, eur: 0, sek: 0, dkk: 0, nok: 0, gbp: 0 })
    expect(await getBookTimeCapture('USDC', '12.5')).toBeNull()
  })

  it('returns null when pricing throws, so settlement is never blocked', async () => {
    mockedGetTokenPrice.mockRejectedValue(new Error('coingecko down'))
    expect(await getBookTimeCapture('USDC', '12.5')).toBeNull()
  })
})
