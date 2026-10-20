/**
 * #4097 — the "Last 30 days" Money in / Money out totals over
 * `hooks/useAccountMoneyFlow.ts`: the rolling-window filter, per-direction
 * sums from the feed's own conversions, the failed-row exclusion, the ≈ mark
 * on serve-time or unpriceable rows, the stop-at-window paging rule, the
 * #2882 partial flag, and the error path keeping the last good totals.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useAccountMoneyFlow, MONEY_FLOW_WINDOW_DAYS } from '@/hooks/useAccountMoneyFlow'
import type { AggregatedTransaction, TransactionsFeedResponse } from '@/types/transactions'

const NOW_SEC = Math.floor(Date.now() / 1000)
const DAY = 86_400

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
    timestamp: NOW_SEC - DAY,
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0x' + 'aa'.repeat(20),
    accountName: 'Main',
    convertedAmount: '10.00',
    convertedCurrency: 'USD',
    convertedFxRate: '10',
    ...overrides,
  } as AggregatedTransaction
}

function page(transactions: AggregatedTransaction[], overrides: Partial<TransactionsFeedResponse> = {}): TransactionsFeedResponse {
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

describe('useAccountMoneyFlow (#4097)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sums Money in and Money out from the feed rows inside the rolling window', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'in', convertedAmount: '10.00', timestamp: NOW_SEC - DAY }),
        tx({ direction: 'out', convertedAmount: '4.00', timestamp: NOW_SEC - 2 * DAY }),
        // Outside the 30-day window: excluded from both totals.
        tx({ direction: 'in', convertedAmount: '99.00', timestamp: NOW_SEC - (MONEY_FLOW_WINDOW_DAYS + 1) * DAY }),
      ]),
    )
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBe(10)
    expect(result.current.moneyOut).toBe(4)
    expect(result.current.approx).toBe(false)
    expect(result.current.partial).toBe(false)
    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })

  it('excludes failed rows: a failed payment moved no money', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'out', convertedAmount: '7.00', isError: true, timestamp: NOW_SEC - DAY }),
        tx({ direction: 'out', convertedAmount: '3.00', timestamp: NOW_SEC - DAY }),
      ]),
    )
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyOut).toBe(3)
  })

  it('marks the totals approx when a row was priced at serve time', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'in', convertedAmount: '10.00', timestamp: NOW_SEC - DAY }),
        // No book-time triple; serve-time approxAmount instead.
        tx({ direction: 'in', convertedAmount: null, approxAmount: '5.00', approxCurrency: 'USD', timestamp: NOW_SEC - DAY }),
      ]),
    )
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBe(15)
    expect(result.current.approx).toBe(true)
  })

  it('a row with no usable price contributes nothing and marks the totals approx', async () => {
    mockApiGet.mockResolvedValue(
      page([
        tx({ direction: 'in', convertedAmount: '10.00', timestamp: NOW_SEC - DAY }),
        tx({ direction: 'in', convertedAmount: null, approxAmount: null, timestamp: NOW_SEC - DAY }),
      ]),
    )
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBe(10)
    expect(result.current.approx).toBe(true)
  })

  it('pages forward and stops once a page crosses the window start', async () => {
    // Page 1: rows inside the window, hasMore true. Page 2's oldest row is
    // older than the window start — no later page can hold an in-window row.
    const page1 = page(
      [tx({ direction: 'in', convertedAmount: '10.00', timestamp: NOW_SEC - DAY })],
      { hasMore: true, total: 300 },
    )
    const page2 = page(
      [
        tx({ direction: 'in', convertedAmount: '5.00', timestamp: NOW_SEC - DAY }),
        tx({ direction: 'in', convertedAmount: '50.00', timestamp: NOW_SEC - 45 * DAY }),
      ],
      { hasMore: true, offset: 2, total: 300 },
    )
    mockApiGet.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // 5.00 from page 2 is INSIDE the window and counted; the 45-day-old row
    // is not. Page 3 is never requested.
    expect(result.current.moneyIn).toBe(15)
    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('a truncated feed flags the totals partial instead of claiming completeness (#2882)', async () => {
    mockApiGet.mockResolvedValue(
      page([tx({ direction: 'in', convertedAmount: '10.00', timestamp: NOW_SEC - DAY })], {
        truncated: true,
        hasMore: true,
        total: 500,
      }),
    )
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.partial).toBe(true)
  })

  it('a partial source failure flags the totals partial too', async () => {
    mockApiGet.mockResolvedValue(
      page([], { partialFailure: true, failedAccountIds: ['safe-1'] }),
    )
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.partial).toBe(true)
  })

  it('an error keeps the last good totals and reports the failure', async () => {
    mockApiGet.mockResolvedValueOnce(
      page([tx({ direction: 'in', convertedAmount: '10.00', timestamp: NOW_SEC - DAY })]),
    )
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()

    mockApiGet.mockRejectedValue(new Error('exploder down'))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBe('exploder down')
    // The last good figures stand — never a silent zeroing.
    expect(result.current.moneyIn).toBe(10)
    expect(result.current.loading).toBe(false)
  })

  it('no account id yet: zero totals, no request, not loading', async () => {
    const { result } = renderHook(() => useAccountMoneyFlow(undefined, 'USD'))
    expect(result.current.loading).toBe(false)
    expect(result.current.moneyIn).toBe(0)
    expect(result.current.moneyOut).toBe(0)
    expect(mockApiGet).not.toHaveBeenCalled()
  })

  it('an empty feed renders honest zeros', async () => {
    mockApiGet.mockResolvedValue(page([]))
    const { result } = renderHook(() => useAccountMoneyFlow('safe-1', 'USD'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.moneyIn).toBe(0)
    expect(result.current.moneyOut).toBe(0)
    expect(result.current.partial).toBe(false)
  })
})
