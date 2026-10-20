/**
 * The denominator of the filtered count (#4111): read once each time the
 * filtered feed settles, never while it loads, never bypassing the cache,
 * and unknown — never short — when the read fails or reports a partial
 * failure.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => mockGet(...a) } }))

const { useUnfilteredTransactionTotal } = await import('../useUnfilteredTransactionTotal')

const READ = '/transactions?offset=0&limit=1'

beforeEach(() => mockGet.mockReset())

describe('useUnfilteredTransactionTotal', () => {
  it('answers the feed total unfiltered, and reads nothing', () => {
    const { result } = renderHook(() =>
      useUnfilteredTransactionTotal({ filtered: false, feedTotal: 12, feedLoading: false }),
    )
    expect(result.current).toBe(12)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('reads exactly once per filter change: nothing while the feed loads, one read when it settles', async () => {
    mockGet.mockResolvedValue({ total: 25 })
    const { result, rerender } = renderHook((props) => useUnfilteredTransactionTotal(props), {
      initialProps: { filtered: true, feedTotal: 0, feedLoading: true },
    })
    expect(mockGet).not.toHaveBeenCalled()
    rerender({ filtered: true, feedTotal: 3, feedLoading: false })
    await waitFor(() => expect(result.current).toBe(25))
    expect(mockGet).toHaveBeenCalledTimes(1)

    // The next filter change: the feed resets to 0 while loading (no read),
    // then settles on its new total (one read).
    rerender({ filtered: true, feedTotal: 0, feedLoading: true })
    rerender({ filtered: true, feedTotal: 5, feedLoading: false })
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    // Never a cache bypass: the feed's poll keeps the server cache fresh —
    // its `fresh=1` covers only the accounts in the request's scope, which is
    // enough, because a narrowed account was just refreshed by that poll.
    for (const call of mockGet.mock.calls) expect(call[0]).toBe(READ)
  })

  it('re-reads when a poll moves the filtered total, keeping the last figure meanwhile', async () => {
    mockGet.mockResolvedValueOnce({ total: 25 })
    const { result, rerender } = renderHook((props) => useUnfilteredTransactionTotal(props), {
      initialProps: { filtered: true, feedTotal: 3, feedLoading: false },
    })
    await waitFor(() => expect(result.current).toBe(25))

    mockGet.mockResolvedValueOnce({ total: 26 })
    rerender({ filtered: true, feedTotal: 4, feedLoading: false })
    expect(result.current).toBe(25)
    await waitFor(() => expect(result.current).toBe(26))
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('treats a partial-failure read as unknown, since its total is short', async () => {
    mockGet.mockResolvedValueOnce({ total: 7, partialFailure: true })
    const { result } = renderHook(() =>
      useUnfilteredTransactionTotal({ filtered: true, feedTotal: 3, feedLoading: false }),
    )
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(result.current).toBeNull()
  })

  it('is unknown after a failed read, and reads again when the feed next settles', async () => {
    mockGet.mockRejectedValueOnce(new Error('down'))
    const { result, rerender } = renderHook((props) => useUnfilteredTransactionTotal(props), {
      initialProps: { filtered: true, feedTotal: 3, feedLoading: false },
    })
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()

    mockGet.mockResolvedValueOnce({ total: 40 })
    rerender({ filtered: true, feedTotal: 0, feedLoading: true })
    rerender({ filtered: true, feedTotal: 2, feedLoading: false })
    await waitFor(() => expect(result.current).toBe(40))
  })
})
