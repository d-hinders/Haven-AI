/**
 * The denominator of the filtered count (#4111): read while filtered, read
 * again when the polled feed's total moves, and unknown — never short — when
 * the read fails or reports a partial failure.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => mockGet(...a) } }))

const { useUnfilteredTransactionTotal } = await import('../useUnfilteredTransactionTotal')

beforeEach(() => mockGet.mockReset())

describe('useUnfilteredTransactionTotal', () => {
  it('answers the feed total unfiltered, and reads nothing', () => {
    const { result } = renderHook(() =>
      useUnfilteredTransactionTotal({ filtered: false, feedTotal: 12, retryKey: '{}' }),
    )
    expect(result.current).toBe(12)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('re-reads, bypassing the cache, when the filtered feed total moves', async () => {
    mockGet.mockResolvedValueOnce({ total: 25 })
    const { result, rerender } = renderHook((props) => useUnfilteredTransactionTotal(props), {
      initialProps: { filtered: true, feedTotal: 3, retryKey: 'a' },
    })
    await waitFor(() => expect(result.current).toBe(25))
    expect(mockGet).toHaveBeenLastCalledWith('/transactions?offset=0&limit=1')

    // A poll found a new matching payment: the denominator moves with it.
    mockGet.mockResolvedValueOnce({ total: 26 })
    rerender({ filtered: true, feedTotal: 4, retryKey: 'a' })
    // The last known figure stays up while the re-read is in flight.
    expect(result.current).toBe(25)
    await waitFor(() => expect(result.current).toBe(26))
    expect(mockGet).toHaveBeenLastCalledWith('/transactions?offset=0&limit=1&fresh=1')
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('treats a partial-failure read as unknown, since its total is short', async () => {
    mockGet.mockResolvedValueOnce({ total: 7, partialFailure: true })
    const { result } = renderHook(() =>
      useUnfilteredTransactionTotal({ filtered: true, feedTotal: 3, retryKey: 'a' }),
    )
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(result.current).toBeNull()
  })

  it('is unknown after a failed read, and reads again on the next filter change', async () => {
    mockGet.mockRejectedValueOnce(new Error('down'))
    const { result, rerender } = renderHook((props) => useUnfilteredTransactionTotal(props), {
      initialProps: { filtered: true, feedTotal: 3, retryKey: 'a' },
    })
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()

    mockGet.mockResolvedValueOnce({ total: 40 })
    rerender({ filtered: true, feedTotal: 3, retryKey: 'b' })
    await waitFor(() => expect(result.current).toBe(40))
  })
})
