import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
