import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { usePortfolio } from '@/hooks/usePortfolio'
import type { PortfolioResponse } from '@/types/transactions'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const PORTFOLIO: PortfolioResponse = {
  totalUsd: 12.34,
  totalEur: 11.22,
  breakdown: [
    {
      symbol: 'USDC',
      balance: '1000000',
      formatted: '1.00',
      usdValue: 1,
      eurValue: 0.92,
    },
  ],
}

describe('usePortfolio', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue(PORTFOLIO)
  })

  it('requests portfolio totals for the provided chain when chainId is known', async () => {
    const { result } = renderHook(() => usePortfolio(SAFE_ADDRESS, { chainId: 8453 }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(`/portfolio/${SAFE_ADDRESS}?chain_id=8453`)
    expect(result.current.totalUsd).toBe(12.34)
    expect(result.current.totalEur).toBe(11.22)
    expect(result.current.breakdown).toEqual(PORTFOLIO.breakdown)
  })

  it('keeps the legacy address-only request when chainId is omitted', async () => {
    renderHook(() => usePortfolio(SAFE_ADDRESS))

    await waitFor(() => expect(mockApiGet).toHaveBeenCalled())

    expect(mockApiGet).toHaveBeenCalledWith(`/portfolio/${SAFE_ADDRESS}`)
  })

  it('ignores stale totals when an older chain request resolves late', async () => {
    let resolveGnosis!: (value: PortfolioResponse) => void
    let resolveBase!: (value: PortfolioResponse) => void
    const gnosisPortfolio: PortfolioResponse = {
      ...PORTFOLIO,
      totalUsd: 1,
      totalEur: 0.9,
    }
    const basePortfolio: PortfolioResponse = {
      ...PORTFOLIO,
      totalUsd: 25,
      totalEur: 23,
    }

    mockApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveGnosis = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveBase = resolve }))

    const { result, rerender } = renderHook(
      ({ chainId }) => usePortfolio(SAFE_ADDRESS, { chainId }),
      { initialProps: { chainId: 100 } },
    )

    rerender({ chainId: 8453 })

    await act(async () => {
      resolveBase(basePortfolio)
      await Promise.resolve()
    })
    expect(result.current.totalUsd).toBe(25)
    expect(result.current.totalEur).toBe(23)

    await act(async () => {
      resolveGnosis(gnosisPortfolio)
      await Promise.resolve()
    })
    expect(result.current.totalUsd).toBe(25)
    expect(result.current.totalEur).toBe(23)
  })
})

describe('usePortfolio visible-only polling (#2732)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue(PORTFOLIO)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a successful silent tick refreshes totals without the loading flag', async () => {
    const { result } = renderHook(() => usePortfolio(SAFE_ADDRESS))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.totalUsd).toBe(12.34)

    mockApiGet.mockResolvedValueOnce({ ...PORTFOLIO, totalUsd: 99, totalEur: 90 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.totalUsd).toBe(99)
    expect(result.current.totalEur).toBe(90)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('a failed silent tick keeps the last good totals and any visible error', async () => {
    const { result } = renderHook(() => usePortfolio(SAFE_ADDRESS))
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockRejectedValueOnce(new Error('500'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.totalUsd).toBe(12.34)
    expect(result.current.totalEur).toBe(11.22)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)

    // A visible error survives further failed ticks.
    mockApiGet.mockRejectedValue('500')
    await act(async () => {
      result.current.refetch()
      await Promise.resolve()
    })
    expect(result.current.error).toBe('Failed to load portfolio')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.error).toBe('Failed to load portfolio')
    expect(result.current.totalUsd).toBe(12.34)
  })
})
