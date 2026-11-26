/**
 * The Sales page's live re-read (#5012, #5038).
 *
 * What is pinned here: with `live`, the summary and the payments list re-read
 * every 10 s while the tab is visible, SILENTLY — what is on screen stays until
 * the new answer replaces it, nothing shows loading again, a failed re-read
 * keeps the rows, and pages loaded with "Show more" stay loaded. When more than
 * one page is loaded the re-read walks the loaded window from the top, page by
 * page, so no payment is left in a hole and a late-indexed one still appears
 * (#5038). Without `live`, nothing polls.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useSalesPayments } from '@/hooks/useSalesPayments'
import { useSalesSummary } from '@/hooks/useSalesSummary'
import { VISIBLE_POLL_INTERVAL_MS } from '@/hooks/useVisiblePolling'
import type { SalesPayment, SalesSummary } from '@/lib/sales'

const RANGE = { from: '2026-11-01', to: '2026-11-30' }

/** Payment `n`: a later `n` is newer, so the list is newest first. */
function payment(n: number): SalesPayment {
  return {
    tx_hash: `0x${n.toString(16).padStart(64, '0')}`,
    block_time: new Date(Date.UTC(2026, 10, 20, 0, 0, n)).toISOString(),
  } as SalesPayment
}

function page(rows: SalesPayment[], next: string | null = null, total = rows.length) {
  return { payments: rows, next_cursor: next, total, usdc_rates: null }
}

/**
 * The payments route over `rows`, newest first. The cursor is the offset into
 * `rows`, so a page is a real slice and `next_cursor` is null at the end.
 */
function serveRows(rows: SalesPayment[], total = rows.length) {
  mockApiGet.mockImplementation(async (path: string) => {
    const url = new URL(path, 'http://haven.test')
    const limit = Number(url.searchParams.get('limit'))
    const cursor = url.searchParams.get('cursor')
    const start = cursor === null ? 0 : Number(cursor)
    const slice = rows.slice(start, start + limit)
    const next = start + limit < rows.length ? String(start + limit) : null
    return page(slice, next, total)
  })
}

/** The `limit` of every request the hook has made. */
function requestedLimits(): number[] {
  return mockApiGet.mock.calls.map(([path]) =>
    Number(new URL(String(path), 'http://haven.test').searchParams.get('limit')),
  )
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

  it('drops a re-read that started for a period the page has left', async () => {
    const november = { payments: 1 } as unknown as SalesSummary
    const december = { payments: 9 } as unknown as SalesSummary
    let resolveStale: (value: unknown) => void = () => {}
    mockApiGet
      .mockResolvedValueOnce(november)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)))
      .mockResolvedValueOnce(december)

    const { result, rerender } = renderHook(
      ({ range }) => useSalesSummary(range, undefined, { live: true }),
      { initialProps: { range: RANGE } },
    )
    await waitFor(() => expect(result.current.data).toBe(november))

    await tick() // the November re-read starts and hangs
    rerender({ range: { from: '2026-12-01', to: '2026-12-31' } })
    await waitFor(() => expect(result.current.data).toBe(december))

    // The November answer lands late: it must not overwrite December.
    await act(async () => resolveStale({ payments: 1 }))
    expect(result.current.data).toBe(december)
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

  it('drops a re-read that started for a period the list has left', async () => {
    let resolveStale: (value: unknown) => void = () => {}
    mockApiGet
      .mockResolvedValueOnce(page([payment(1)]))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)))
      .mockResolvedValueOnce(page([payment(7)]))

    const { result, rerender } = renderHook(({ range }) => useSalesPayments(range, { live: true }), {
      initialProps: { range: RANGE },
    })
    await waitFor(() => expect(result.current.payments).toEqual([payment(1)]))

    await tick() // the November re-read starts and hangs
    rerender({ range: { from: '2026-12-01', to: '2026-12-31' } })
    await waitFor(() => expect(result.current.payments).toEqual([payment(7)]))

    // The November page lands late: it must not merge into December's list.
    await act(async () => resolveStale(page([payment(2), payment(1)])))
    expect(result.current.payments).toEqual([payment(7)])
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

describe('the live re-read walks the loaded window (#5038)', () => {
  /** Load `count` rows of `rows` with page size `limit`, through "Show more". */
  async function loadWindow(rows: SalesPayment[], limit: number, count: number) {
    serveRows(rows)
    const hook = renderHook(() => useSalesPayments(RANGE, { limit, live: true }))
    await waitFor(() => expect(hook.result.current.payments).toHaveLength(Math.min(limit, count)))
    while (hook.result.current.payments.length < count) {
      const before = hook.result.current.payments.length
      act(() => hook.result.current.loadMore())
      await waitFor(() => expect(hook.result.current.payments.length).toBeGreaterThan(before))
    }
    return hook
  }

  it('leaves no payment missing when more than a page arrived since the last re-read', async () => {
    // The scan's reproduction: page size 2, rows [5..1] loaded, four new.
    const { result } = await loadWindow([5, 4, 3, 2, 1].map(payment), 2, 5)
    expect(result.current.payments).toEqual([5, 4, 3, 2, 1].map(payment))

    serveRows([9, 8, 7, 6, 5, 4, 3, 2, 1].map(payment))
    await tick()

    await waitFor(() => expect(result.current.payments).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1].map(payment)))
    expect(result.current.total).toBe(9)
    // Every payment is on screen, so there is nothing more to show.
    expect(result.current.hasMore).toBe(false)
  })

  it('keeps "Show more" available while rows remain beyond the window', async () => {
    // The top five of a sixteen-row list, then four new payments.
    const { result } = await loadWindow([12, 11, 10, 9, 8].map(payment), 2, 5)

    serveRows(Array.from({ length: 16 }, (_, i) => payment(16 - i)))
    await tick()

    await waitFor(() => expect(result.current.payments).toHaveLength(10))
    expect(result.current.payments).toEqual([16, 15, 14, 13, 12, 11, 10, 9, 8, 7].map(payment))
    expect(result.current.total).toBe(16)
    expect(result.current.hasMore).toBe(true)
  })

  it('shows a payment the index added late, with a block_time among the loaded rows', async () => {
    const { result } = await loadWindow([5, 4, 3, 2, 1].map(payment), 2, 5)

    // A transfer the merchant index adds late, older than 3 and newer than 2.
    const late = {
      tx_hash: `0x${'ff'.repeat(32)}`,
      block_time: new Date(Date.UTC(2026, 10, 20, 0, 0, 2.5)).toISOString(),
    } as SalesPayment
    serveRows([payment(5), payment(4), payment(3), late, payment(2), payment(1)])
    await tick()

    await waitFor(() =>
      expect(result.current.payments).toEqual([payment(5), payment(4), payment(3), late, payment(2), payment(1)]),
    )
  })

  it('shows every loaded row plus one new payment when two pages are loaded', async () => {
    const { result } = await loadWindow([3, 2, 1].map(payment), 2, 3)
    expect(result.current.payments).toEqual([3, 2, 1].map(payment))

    serveRows([4, 3, 2, 1].map(payment))
    await tick()

    await waitFor(() => expect(result.current.payments).toEqual([4, 3, 2, 1].map(payment)))
    expect(result.current.total).toBe(4)
    expect(result.current.hasMore).toBe(false)
  })

  it('never asks for more than the backend cap, and still updates, with more than 200 rows loaded', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => payment(250 - i))
    const { result } = await loadWindow(rows, 200, 250)
    expect(result.current.payments).toHaveLength(250)

    mockApiGet.mockClear()
    serveRows([payment(251), ...rows])
    await tick()

    await waitFor(() => expect(result.current.payments).toHaveLength(251))
    expect(result.current.payments[0]).toEqual(payment(251))
    const limits = requestedLimits()
    expect(limits.length).toBeGreaterThan(0)
    expect(limits.every((limit) => limit <= 200)).toBe(true)
  })
})
