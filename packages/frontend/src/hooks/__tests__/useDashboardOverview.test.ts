import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { browserTimeZone } from '@/lib/analytics-range'
import type { DashboardOverviewResponse } from '@/types/dashboard'

function overview(id: string): DashboardOverviewResponse {
  return {
    totals: { usd: 0, eur: 0 },
    change: {
      available: false,
      usdAmount: 0,
      eurAmount: 0,
      usdPercent: 0,
      eurPercent: 0,
    },
    // #3807: the metrics block is gone with the KPI tiles.
    actionableApprovals: 0,
    pendingApprovals: 0,
    onboardingProgress: { hasFirstAgentPayment: false },
    agents: [],
    agentCount: { active: 0, paused: 0, pending_approval: 0 },
    accounts: [],
    spend: {
      scope: 'mainnet',
      d7: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: 0, eur: 0, sek: 0 },
        approx: false,
        payments: 0,
        distinctMerchants: 0,
        budgetStops: 0,
      },
      d30: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: 0, eur: 0, sek: 0 },
        approx: false,
        payments: 0,
        distinctMerchants: 0,
        budgetStops: 0,
      },
      topMerchant7d: null,
      failedIntents7d: 0,
      balance_by_day: [],
    },
    // #3858: the 5-row transactions preview is off the wire; `spotRates` keyed
    // by `id` is the per-overview marker the stale-swap assertions read.
    spotRates: { [id]: 1 },
  }
}

describe('useDashboardOverview', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('uses canonical overview data and ignores stale overview data', async () => {
    let resolveFirst!: (value: DashboardOverviewResponse) => void
    let resolveSecond!: (value: DashboardOverviewResponse) => void
    const firstOverview = overview('0xold')
    const secondOverview = overview('0xnew')

    mockApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

    const { result } = renderHook(() => useDashboardOverview())

    act(() => {
      void result.current.refetch()
    })

    await act(async () => {
      resolveSecond(secondOverview)
      await Promise.resolve()
    })
    expect(result.current.data?.spotRates['0xnew']).toBe(1)

    await act(async () => {
      resolveFirst(firstOverview)
      await Promise.resolve()
    })
    expect(result.current.data?.spotRates['0xnew']).toBe(1)
    expect(mockApiGet).toHaveBeenCalledTimes(2)
    // #3810: the request names the browser's IANA zone so the activity groups
    // bucket on the user's local days — omitted entirely when the runtime
    // cannot resolve one (the server's UTC default takes over).
    const zone = browserTimeZone()
    expect(mockApiGet).toHaveBeenCalledWith(
      zone ? `/dashboard/overview?tz=${encodeURIComponent(zone)}` : '/dashboard/overview',
    )
  })
})

describe('useDashboardOverview visible-only polling (#2732)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a successful silent tick swaps in fresh data with no loading flag and no user action', async () => {
    mockApiGet.mockResolvedValueOnce(overview('0xgood'))
    const { result } = renderHook(() => useDashboardOverview())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.data?.spotRates['0xgood']).toBe(1)

    mockApiGet.mockResolvedValueOnce(overview('0xnew'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.data?.spotRates['0xnew']).toBe(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('a failed silent tick keeps the last good overview: no error, no skeleton, no data wipe', async () => {
    mockApiGet.mockResolvedValueOnce(overview('0xgood'))
    const { result } = renderHook(() => useDashboardOverview())
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockRejectedValueOnce(new Error('500'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.data?.spotRates['0xgood']).toBe(1)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })
})
