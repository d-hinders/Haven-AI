import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()
const mockFetchX402ActivityTransactions = vi.fn()
const mockMergeTransactionsWithX402Activity = vi.fn(
  (transactions: unknown[], _x402Transactions: unknown[]) => transactions,
)

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

vi.mock('@/lib/x402-activity-transactions', () => ({
  fetchX402ActivityTransactions: (...args: unknown[]) =>
    mockFetchX402ActivityTransactions(...args),
  mergeTransactionsWithX402Activity: (
    transactions: unknown[],
    x402Transactions: unknown[],
  ) => mockMergeTransactionsWithX402Activity(transactions, x402Transactions),
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
    mockFetchX402ActivityTransactions.mockReset()
    mockMergeTransactionsWithX402Activity.mockClear()
    mockFetchX402ActivityTransactions.mockResolvedValue([])
  })

  it('does not run the x402 bridge for stale transaction feed requests', async () => {
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
    expect(mockFetchX402ActivityTransactions).not.toHaveBeenCalled()

    await act(async () => {
      resolveSecond(response([tx('0xnew', 'safe-new')]))
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.loadingInitial).toBe(false))
    expect(mockFetchX402ActivityTransactions).toHaveBeenCalledTimes(1)
    expect(mockFetchX402ActivityTransactions).toHaveBeenCalledWith({
      safeId: 'safe-new',
    })
    expect(result.current.transactions[0]?.hash).toBe('0xnew')
  })
})
