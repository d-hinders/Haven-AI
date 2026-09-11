import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import type { AggregatedTransaction, TransactionsFeedResponse } from '@/types/transactions'

function tx(hash: string, safeId: string): AggregatedTransaction {
  return {
    hash,
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
    safeId,
    safeAddress: '0x1111111111111111111111111111111111111111',
    safeName: 'Base wallet',
  }
}

function response(transactions: AggregatedTransaction[]): TransactionsFeedResponse {
  return {
    transactions,
    total: transactions.length,
    offset: 0,
    limit: 25,
    hasMore: false,
    partialFailure: false,
    failedSafeIds: [],
    truncated: false,
  }
}

describe('useTransactionsFeed', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('does not run extra x402 bridge requests for transaction feed data', async () => {
    let resolveFirst!: (value: TransactionsFeedResponse) => void
    let resolveSecond!: (value: TransactionsFeedResponse) => void

    mockApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

    const { result, rerender } = renderHook(
      ({ safeId }) => useTransactionsFeed({ safeId }),
      { initialProps: { safeId: 'safe-old' } },
    )

    rerender({ safeId: 'safe-new' })

    await act(async () => {
      resolveFirst(response([tx('0xold', 'safe-old')]))
      await Promise.resolve()
    })

    await act(async () => {
      resolveSecond(response([tx('0xnew', 'safe-new')]))
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.loadingInitial).toBe(false))
    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(mockApiGet).toHaveBeenCalledWith(
      '/transactions?safeId=safe-old&offset=0&limit=25',
    )
    expect(mockApiGet).toHaveBeenCalledWith(
      '/transactions?safeId=safe-new&offset=0&limit=25',
    )
    expect(result.current.transactions[0]?.hash).toBe('0xnew')
  })

  it('dedupes overlapping paginated rows without the x402 bridge', async () => {
    mockApiGet
      .mockResolvedValueOnce({
        ...response([tx('0xfirst', 'safe-1')]),
        total: 2,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        ...response([
          tx('0xfirst', 'safe-1'),
          tx('0xsecond', 'safe-1'),
        ]),
        offset: 1,
        total: 2,
      })

    const { result } = renderHook(() => useTransactionsFeed({}))

    await waitFor(() => expect(result.current.loadingInitial).toBe(false))

    await act(async () => {
      await result.current.loadMore()
    })

    expect(result.current.transactions.map((item) => item.hash)).toEqual([
      '0xfirst',
      '0xsecond',
    ])
    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(mockApiGet).toHaveBeenLastCalledWith('/transactions?offset=1&limit=25')
  })
})

describe('useTransactionsFeed visible-only polling (#2732)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a successful silent tick refetches fresh and keeps the loaded window: no pagination reset, no spinner flag', async () => {
    const pageOne = {
      ...response([tx('0xa', 'safe-1'), tx('0xb', 'safe-1')]),
      hasMore: true,
    }
    mockApiGet.mockResolvedValueOnce(pageOne)
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.loadingInitial).toBe(false)

    // User loaded a second page (4 rows in view).
    mockApiGet.mockResolvedValueOnce({
      ...response([tx('0xc', 'safe-1'), tx('0xd', 'safe-1')]),
      offset: 2,
    })
    await act(async () => {
      await result.current.loadMore()
    })
    expect(result.current.transactions).toHaveLength(4)

    mockApiGet.mockResolvedValueOnce(
      response([tx('0xa', 'safe-1'), tx('0xb', 'safe-1'), tx('0xc', 'safe-1'), tx('0xd', 'safe-1')]),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    // The tick asked for the loaded window (limit = 4 loaded rows), fresh,
    // at offset 0 — not a page reset to limit=25.
    expect(mockApiGet).toHaveBeenLastCalledWith(
      '/transactions?offset=0&limit=4&fresh=1',
    )
    expect(result.current.refreshing).toBe(false)
    expect(result.current.loadingInitial).toBe(false)
  })

  it('a failed silent tick keeps the rows the presenter is pointing at: list, total and flags unchanged, no error flip', async () => {
    mockApiGet.mockResolvedValueOnce(response([tx('0xa', 'safe-1')]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.transactions).toHaveLength(1)

    mockApiGet.mockRejectedValueOnce(new Error('500 mid-demo'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(result.current.transactions).toHaveLength(1)
    expect(result.current.transactions[0]?.hash).toBe('0xa')
    expect(result.current.total).toBe(1)
    expect(result.current.error).toBeNull()
    expect(result.current.loadingInitial).toBe(false)
    expect(result.current.refreshing).toBe(false)
  })

  it('does not double-fire when a manual refresh races a poll tick (one in-flight request)', async () => {
    let resolveTick!: (value: TransactionsFeedResponse) => void
    mockApiGet.mockResolvedValueOnce(response([tx('0xa', 'safe-1')]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockReturnValueOnce(
      new Promise<TransactionsFeedResponse>((resolve) => { resolveTick = resolve }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mockApiGet).toHaveBeenCalledTimes(2)

    // A manual refresh issued while the tick is in flight starts its own
    // request (the hook's requestIdRef supersedes the tick), but the poll
    // cadence itself issued no second request for the same moment.
    mockApiGet.mockResolvedValueOnce(response([tx('0xb', 'safe-1')]))
    const manual = result.current.refresh()
    expect(mockApiGet).toHaveBeenCalledTimes(3)
    resolveTick(response([tx('0xc', 'safe-1')]))
    await act(async () => {
      await manual
    })
    expect(mockApiGet).toHaveBeenCalledTimes(3)
  })
})
