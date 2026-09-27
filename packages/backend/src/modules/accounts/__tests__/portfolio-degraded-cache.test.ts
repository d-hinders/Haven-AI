import { beforeEach, describe, expect, it, vi } from 'vitest'

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

// balanceOf returning 2 USDC (6 decimals), ABI-encoded.
const TWO_USDC = '0x' + (2_000_000).toString(16).padStart(64, '0')

describe('fetchPortfolioForAccount — a failed balance read is not cached', () => {
  beforeEach(() => {
    mockGetBalance.mockReset().mockResolvedValue(0n)
    mockCall.mockReset()
  })

  it('re-reads on the next request after a failed leg instead of serving the zero for the TTL', async () => {
    // The dRPC free-plan refusal that zeroed the dashboard (code 31).
    mockCall.mockRejectedValueOnce(new Error('Batch of more than 3 requests are not allowed on free plan'))
    mockCall.mockResolvedValue(TWO_USDC)
    const address = '0x00000000000000000000000000000000000000a1'

    const degraded = await fetchPortfolioForAccount(84532, address)
    expect(degraded.totalUsd).toBe(0)

    const recovered = await fetchPortfolioForAccount(84532, address)
    expect(recovered.totalUsd).toBe(2)
  })

  it('still caches a clean read', async () => {
    mockCall.mockResolvedValue(TWO_USDC)
    const address = '0x00000000000000000000000000000000000000a2'

    await fetchPortfolioForAccount(84532, address)
    await fetchPortfolioForAccount(84532, address)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
  })
})
