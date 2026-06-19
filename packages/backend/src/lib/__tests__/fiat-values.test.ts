import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBookTimeSekValue, FX_SOURCE_SPOT } from '../fiat-values.js'
import { getTokenPrice } from '../prices.js'

vi.mock('../prices.js', () => ({ getTokenPrice: vi.fn() }))
const mockedGetTokenPrice = vi.mocked(getTokenPrice)

afterEach(() => vi.clearAllMocks())

describe('getBookTimeSekValue', () => {
  it('returns SEK value, rate, and source', async () => {
    mockedGetTokenPrice.mockResolvedValue({ usd: 1, eur: 0.9, sek: 10.6 })
    const v = await getBookTimeSekValue('USDC', '12.5')
    expect(v).toEqual({ amountSek: 132.5, fxRate: 10.6, fxSource: FX_SOURCE_SPOT })
  })

  it('returns null for a non-positive amount', async () => {
    expect(await getBookTimeSekValue('USDC', '0')).toBeNull()
    expect(await getBookTimeSekValue('USDC', 'not-a-number')).toBeNull()
  })

  it('returns null (not a bogus zero) when no SEK rate is available', async () => {
    mockedGetTokenPrice.mockResolvedValue({ usd: 1, eur: 0.9, sek: 0 })
    expect(await getBookTimeSekValue('USDC', '12.5')).toBeNull()
  })

  it('returns null when pricing throws, so settlement is never blocked', async () => {
    mockedGetTokenPrice.mockRejectedValue(new Error('coingecko down'))
    expect(await getBookTimeSekValue('USDC', '12.5')).toBeNull()
  })
})
