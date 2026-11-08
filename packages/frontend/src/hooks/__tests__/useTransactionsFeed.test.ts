import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { transactionFeedQuery, transactionFilterParams, useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import type { AggregatedTransaction, TransactionsFeedResponse } from '@/types/transactions'

function tx(
  hash: string,
  accountId: string,
  overrides: Partial<AggregatedTransaction> = {},
): AggregatedTransaction {
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
    accountId,
    accountAddress: '0x1111111111111111111111111111111111111111',
    accountName: 'Base wallet',
    ...overrides,
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
    failedAccountIds: [],
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
      ({ accountId }) => useTransactionsFeed({ accountId }),
      { initialProps: { accountId: 'safe-old' } },
    )

    rerender({ accountId: 'safe-new' })

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
      '/transactions?accountId=safe-old&offset=0&limit=25',
    )
    expect(mockApiGet).toHaveBeenCalledWith(
      '/transactions?accountId=safe-new&offset=0&limit=25',
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

describe('the own-transfer fold on the request (#4266)', () => {
  it('serializes foldOwnTransfers as the exact value the backend opts in on', () => {
    expect(transactionFilterParams({ foldOwnTransfers: true }).get('foldOwnTransfers')).toBe('1')
    expect(transactionFeedQuery({ foldOwnTransfers: true }, 0, 25)).toContain('foldOwnTransfers=1')
  })

  it('sends nothing when the caller does not ask — the per-account ledger', () => {
    expect(transactionFilterParams({ accountId: 'safe-1' }).has('foldOwnTransfers')).toBe(false)
    expect(transactionFeedQuery({ accountId: 'safe-1' }, 0, 25)).not.toContain('foldOwnTransfers')
  })
})

/**
 * #4708: Live rows on `/transactions`.
 *
 * The fixture is the ROW shape — a stable `accountId:hash:type` identity that
 * survives confirmation — which is why the snapshot maps identity → outcome.
 * The dashboard's group fixture lives in
 * `app/(authenticated)/dashboard/__tests__/ActivitySection.test.tsx`.
 */
describe('useTransactionsFeed Live rows (#4708)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A row that is still in flight — `confirming_merchant` is the backend's pending. */
  const pending = (hash: string) => tx(hash, 'safe-1', { paymentFlowStatus: 'confirming_merchant' })

  it('plays nothing on the first load', async () => {
    mockApiGet.mockResolvedValueOnce(response([tx('0xa', 'safe-1')]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.liveKeys.size).toBe(0)
  })

  it('plays a new confirmed row on a silent poll, once', async () => {
    mockApiGet.mockResolvedValueOnce(response([tx('0xa', 'safe-1')]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockResolvedValueOnce(response([tx('0xb', 'safe-1'), tx('0xa', 'safe-1')]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect([...result.current.liveKeys]).toEqual(['safe-1:0xb:native'])

    // The next tick sees the same rows and plays nothing.
    mockApiGet.mockResolvedValueOnce(response([tx('0xb', 'safe-1'), tx('0xa', 'safe-1')]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.liveKeys.size).toBe(0)
  })

  it('does not play a new pending or failed row', async () => {
    mockApiGet.mockResolvedValueOnce(response([tx('0xa', 'safe-1')]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockResolvedValueOnce(response([pending('0xp'), tx('0xa', 'safe-1')]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.liveKeys.size).toBe(0)

    mockApiGet.mockResolvedValueOnce(
      response([tx('0xf', 'safe-1', { isError: true }), pending('0xp'), tx('0xa', 'safe-1')]),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.liveKeys.size).toBe(0)
  })

  it('plays a pending row that confirms, once — its identity never changed', async () => {
    mockApiGet.mockResolvedValueOnce(response([pending('0xp')]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.liveKeys.size).toBe(0)

    mockApiGet.mockResolvedValueOnce(response([tx('0xp', 'safe-1')]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect([...result.current.liveKeys]).toEqual(['safe-1:0xp:native'])

    mockApiGet.mockResolvedValueOnce(response([tx('0xp', 'safe-1')]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.liveKeys.size).toBe(0)
  })

  it('plays nothing on "load more", and the snapshot restarts from what is on screen', async () => {
    mockApiGet.mockResolvedValueOnce({ ...response([tx('0xa', 'safe-1')]), hasMore: true })
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockResolvedValueOnce({ ...response([tx('0xb', 'safe-1')]), offset: 1 })
    await act(async () => {
      await result.current.loadMore()
    })
    expect(result.current.liveKeys.size).toBe(0)

    // The next silent poll still sees a genuinely new row.
    mockApiGet.mockResolvedValueOnce(
      response([tx('0xc', 'safe-1'), tx('0xb', 'safe-1'), tx('0xa', 'safe-1')]),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect([...result.current.liveKeys]).toEqual(['safe-1:0xc:native'])
  })

  it('plays nothing on a manual refresh', async () => {
    mockApiGet.mockResolvedValueOnce(response([tx('0xa', 'safe-1')]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockResolvedValueOnce(response([tx('0xb', 'safe-1'), tx('0xa', 'safe-1')]))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.liveKeys.size).toBe(0)
  })

  it('plays nothing when a filter changes', async () => {
    mockApiGet.mockResolvedValueOnce(response([tx('0xa', 'safe-1')]))
    const { result, rerender } = renderHook(
      ({ accountId }) => useTransactionsFeed({ accountId }),
      { initialProps: { accountId: 'safe-1' } },
    )
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockResolvedValueOnce(response([tx('0xb', 'safe-2')]))
    rerender({ accountId: 'safe-2' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.liveKeys.size).toBe(0)
  })

  it('caps one poll at the newest three rows', async () => {
    mockApiGet.mockResolvedValueOnce(response([]))
    const { result } = renderHook(() => useTransactionsFeed({}))
    await act(async () => {
      await Promise.resolve()
    })

    const arrivals = [0, 1, 2, 3, 4].map((n) =>
      tx(`0x${n}`, 'safe-1', { timestamp: 1_778_240_999 + n }),
    )
    mockApiGet.mockResolvedValueOnce(response(arrivals))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.liveKeys.size).toBe(3)
    expect([...result.current.liveKeys].sort()).toEqual(
      ['safe-1:0x2:native', 'safe-1:0x3:native', 'safe-1:0x4:native'].sort(),
    )
  })
})
