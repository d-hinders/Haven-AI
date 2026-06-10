import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useDashboardOverview } from '@/hooks/useDashboardOverview'
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
    metrics: {
      connectedAgents: 0,
      monthlyAgentSpendUsd: 0,
      monthlyAgentSpendEur: 0,
      successfulTransactions: 0,
      activeAccounts: 0,
    },
    pendingApprovals: 0,
    agents: [],
    transactions: [{
      hash: id,
      type: 'native',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1',
      valueFormatted: '1',
      asset: 'ETH',
      decimals: 18,
      direction: 'out',
      timestamp: 1778240999,
      blockNumber: 45725826,
      isError: false,
      chainId: 8453,
      safeId: 'safe-1',
      safeAddress: '0x1111111111111111111111111111111111111111',
      safeName: 'Base wallet',
    }],
  }
}

describe('useDashboardOverview', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('uses canonical overview transactions and ignores stale overview data', async () => {
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
    expect(result.current.data?.transactions[0]?.hash).toBe('0xnew')

    await act(async () => {
      resolveFirst(firstOverview)
      await Promise.resolve()
    })
    expect(result.current.data?.transactions[0]?.hash).toBe('0xnew')
    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(mockApiGet).toHaveBeenCalledWith('/dashboard/overview')
  })
})
