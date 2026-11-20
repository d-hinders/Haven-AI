/**
 * The Sales page's live re-read (#5012).
 *
 * What is pinned here: with `live`, the summary and the payments list re-read
 * every 10 s while the tab is visible, SILENTLY — what is on screen stays until
 * the new answer replaces it, nothing shows loading again, a failed re-read
 * keeps the rows, and pages loaded with "Show more" stay loaded. Without
 * `live`, nothing polls.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { mergeLivePage, useSalesPayments } from '@/hooks/useSalesPayments'
import { useSalesSummary } from '@/hooks/useSalesSummary'
import { VISIBLE_POLL_INTERVAL_MS } from '@/hooks/useVisiblePolling'
import type { SalesPayment, SalesSummary } from '@/lib/sales'

const RANGE = { from: '2026-11-01', to: '2026-11-30' }

function payment(n: number): SalesPayment {
  return { tx_hash: `0x${n.toString(16).padStart(64, '0')}` } as SalesPayment
}

function page(rows: SalesPayment[], next: string | null = null, total = rows.length) {
  return { payments: rows, next_cursor: next, total, usdc_rates: null }
}

async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mockApiGet.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mergeLivePage (#5012)', () => {
  it('replaces the list when only the first page is shown', () => {
    expect(mergeLivePage([payment(1), payment(2)], [payment(3), payment(1)], 50)).toEqual([payment(3), payment(1)])
  })

  it('puts new rows on top and keeps every loaded page below when more than the first page is shown', () => {
    const shown = [payment(5), payment(4), payment(3), payment(2), payment(1)]
    // Page size 2: the owner loaded more than one page. A new payment (6)
    // arrives; the fresh first page is [6, 5].
    expect(mergeLivePage(shown, [payment(6), payment(5)], 2)).toEqual([
      payment(6),
      payment(5),
      payment(4),
      payment(3),
      payment(2),
      payment(1),
    ])
  })
})

describe('useSalesSummary live (#5012)', () => {
  it('re-reads silently while visible: the figures stay until replaced, and loading never returns', async () => {
    const first = { payments: 1 } as unknown as SalesSummary
    const second = { payments: 2 } as unknown as SalesSummary
    mockApiGet.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    const { result } = renderHook(() => useSalesSummary(RANGE, undefined, { live: true }))
    await waitFor(() => expect(result.current.data).toBe(first))

    await tick()

    await waitFor(() => expect(result.current.data).toBe(second))
    expect(result.current.loading).toBe(false)
    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('keeps the figures on screen when a re-read fails', async () => {
    const first = { payments: 1 } as unknown as SalesSummary
    mockApiGet.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('offline'))

    const { result } = renderHook(() => useSalesSummary(RANGE, undefined, { live: true }))
    await waitFor(() => expect(result.current.data).toBe(first))

    await tick()

    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(result.current.data).toBe(first)
    expect(result.current.failed).toBe(false)
  })

  it('does not poll without live', async () => {
    mockApiGet.mockResolvedValue({ payments: 1 })
    const { result } = renderHook(() => useSalesSummary(RANGE))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await tick()
    await tick()

    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })
})

describe('useSalesPayments live (#5012)', () => {
  it('shows a new payment on top without clearing the list or showing loading', async () => {
    mockApiGet
      .mockResolvedValueOnce(page([payment(1)]))
      .mockResolvedValueOnce(page([payment(2), payment(1)]))

    const { result } = renderHook(() => useSalesPayments(RANGE, { live: true }))
    await waitFor(() => expect(result.current.payments).toEqual([payment(1)]))

    await tick()

    await waitFor(() => expect(result.current.payments).toEqual([payment(2), payment(1)]))
    expect(result.current.loading).toBe(false)
    expect(result.current.total).toBe(2)
  })

  it('keeps pages loaded with "Show more" when a re-read arrives', async () => {
    mockApiGet
      .mockResolvedValueOnce(page([payment(3), payment(2)], 'c1', 3))
      .mockResolvedValueOnce(page([payment(1)], null, 3))
      .mockResolvedValueOnce(page([payment(4), payment(3)], 'c2', 4))

    const { result } = renderHook(() => useSalesPayments(RANGE, { limit: 2, live: true }))
    await waitFor(() => expect(result.current.payments).toHaveLength(2))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.payments).toHaveLength(3))

    await tick()

    await waitFor(() =>
      expect(result.current.payments).toEqual([payment(4), payment(3), payment(2), payment(1)]),
    )
    expect(result.current.total).toBe(4)
    // The loaded pages are all there, so there is nothing more to show.
    expect(result.current.hasMore).toBe(false)
  })

  it('keeps the rows on screen when a re-read fails', async () => {
    mockApiGet.mockResolvedValueOnce(page([payment(1)])).mockRejectedValueOnce(new Error('offline'))

    const { result } = renderHook(() => useSalesPayments(RANGE, { live: true }))
    await waitFor(() => expect(result.current.payments).toEqual([payment(1)]))

    await tick()

    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(result.current.payments).toEqual([payment(1)])
    expect(result.current.failed).toBe(false)
  })
})
