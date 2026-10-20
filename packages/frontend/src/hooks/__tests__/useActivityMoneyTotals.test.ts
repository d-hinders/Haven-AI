/**
 * #4098 — the account Activity tab's in/out totals over
 * `hooks/useActivityMoneyTotals.ts`: sums taken from the SERVER-filtered
 * feed (every FilterBar dimension rides the request), paged forward until
 * the filtered set ends, with the failed-row exclusion, the ≈ mark only
 * where a conversion changes the number (#4165), the separate unpriced
 * signal for unpriced/foreign rows, the #2882 partial flag, and the error
 * path keeping the last good totals.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useActivityMoneyTotals } from '@/hooks/useActivityMoneyTotals'
import type { AggregatedTransaction, TransactionFilterState, TransactionsFeedResponse } from '@/types/transactions'

/** One feed row, priced book-time in USD by default. */
function tx(overrides: Partial<AggregatedTransaction>): AggregatedTransaction {
  return {
    hash: '0xabc',
    type: 'erc20',
    from: '0x' + 'bb'.repeat(20),
    to: '0x' + 'cc'.repeat(20),
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    tokenSymbol: 'USDC',
    decimals: 6,
    direction: 'in',
    timestamp: 1_778_240_999,
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0x' + 'aa'.repeat(20),
    accountName: 'Main',
    convertedAmount: '10.00',
    convertedCurrency: 'USD',
    ...overrides,
  } as AggregatedTransaction
}

function page(
  transactions: AggregatedTransaction[],
  overrides: Partial<TransactionsFeedResponse> = {},
): TransactionsFeedResponse {
  return {
    transactions,
    total: transactions.length,
    offset: 0,
    limit: 100,
    hasMore: false,
    partialFailure: false,
    failedAccountIds: [],
    truncated: false,
    ...overrides,
  }
}

/** The filter state the account Activity tab passes: the fixed account plus a narrowing dimension. */
const FILTERS: TransactionFilterState = { accountId: 'safe-1', direction: 'in' }

describe('useActivityMoneyTotals (#4098)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends every filter dimension to the server and sums what comes back', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'in', convertedAmount: '10.00' }),
        tx({ direction: 'out', convertedAmount: '4.00' }),
      ]),
    )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // The walk reads the SAME filtered feed the list shows: the fixed
    // account and the active direction ride the first (and here only) page.
    expect(mockApiGet).toHaveBeenCalledTimes(1)
    expect(mockApiGet).toHaveBeenCalledWith(
      expect.stringContaining('accountId=safe-1'),
    )
    expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining('direction=in'))
    expect(result.current.moneyIn).toBe(10)
    expect(result.current.moneyOut).toBe(4)
    expect(result.current.approx).toBe(false)
    expect(result.current.partial).toBe(false)
  })

  it('pages forward until the filtered feed ends', async () => {
    mockApiGet
      .mockResolvedValueOnce(
        page([tx({ direction: 'in', convertedAmount: '10.00' })], {
          total: 3,
          offset: 0,
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        page(
          [
            tx({ direction: 'in', convertedAmount: '5.00', hash: '0xdef' }),
            tx({ direction: 'in', convertedAmount: '5.00', hash: '0x123' }),
          ],
          { total: 3, offset: 1, hasMore: false },
        ),
      )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(mockApiGet).toHaveBeenNthCalledWith(2, expect.stringContaining('offset=1'))
    expect(result.current.moneyIn).toBe(20)
    expect(result.current.moneyOut).toBe(0)
  })

  it('excludes failed rows: a failed payment moved no money', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'out', convertedAmount: '7.00', isError: true }),
        tx({ direction: 'out', convertedAmount: '3.00' }),
      ]),
    )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyOut).toBe(3)
  })

  it('a serve-time USDC row in USD carries no ≈ — USDC is dollars (#4165)', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'in', convertedAmount: null, approxAmount: '12.00', approxCurrency: 'USD' }),
      ]),
    )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBe(12)
    expect(result.current.approx).toBe(false)
  })

  it('marks the totals ≈ when a row is priced at serve time in another currency (SEK)', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'in', convertedAmount: null, approxAmount: '129.12', approxCurrency: 'SEK' }),
      ]),
    )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'SEK'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBeCloseTo(129.12)
    expect(result.current.approx).toBe(true)
  })

  it('does not sum a foreign-currency or unpriced row — and says so as unpriced, not ≈', async () => {
    mockApiGet.mockResolvedValue(
      page([
        // Foreign book-time triple: not summed into a USD figure.
        tx({ direction: 'in', convertedAmount: '90.00', convertedCurrency: 'SEK' }),
        // No usable price at all: contributes nothing.
        tx({ direction: 'in', convertedAmount: null, approxAmount: null }),
        tx({ direction: 'in', convertedAmount: '5.00', convertedCurrency: 'USD' }),
      ]),
    )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBe(5)
    expect(result.current.approx).toBe(false)
    expect(result.current.unpriced).toBe(true)
  })

  it('an all-unpriced direction totals null ("—"), never 0', async () => {
    mockApiGet.mockResolvedValue(page([tx({ direction: 'in', convertedAmount: null, approxAmount: null })]))
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBeNull()
    expect(result.current.moneyOut).toBe(0)
    expect(result.current.unpriced).toBe(true)
  })

  it('reports partial when the feed is capped or a source failed (#2882)', async () => {
    mockApiGet.mockResolvedValue(
      page([tx({ direction: 'in', convertedAmount: '10.00' })], {
        truncated: true,
        partialFailure: true,
      }),
    )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.partial).toBe(true)
  })

  it('keeps the last good totals when a re-read fails', async () => {
    mockApiGet.mockResolvedValue(
      page([tx({ direction: 'in', convertedAmount: '10.00' })]),
    )
    const { result } = renderHook(() => useActivityMoneyTotals(FILTERS, 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBe(10)

    mockApiGet.mockRejectedValue(new Error('network down'))
    await act(async () => {
      await result.current.refresh()
    })
    // The figures that were true a moment ago stay on screen; the error is
    // the story, never a silent zeroing.
    expect(result.current.moneyIn).toBe(10)
    expect(result.current.error).toBe('network down')
    expect(result.current.loading).toBe(false)
  })
})
