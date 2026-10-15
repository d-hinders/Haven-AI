import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useAgentActivity } from '@/hooks/useAgentActivity'
import { browserTimeZone } from '@/lib/analytics-range'

/**
 * #1075: a 200 whose body omits `activity` used to be written straight into
 * state, so `activity` became `undefined` and the agent detail page's
 * `activity.filter(...)` threw during render — the whole route went blank
 * (and took the #896 screenshot harness with it). The array this hook
 * exposes is typed non-nullable; it has to stay that way whatever the body is.
 */
describe('useAgentActivity', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('keeps activity an array when the response omits the key', async () => {
    mockApiGet
      .mockResolvedValueOnce({}) // /activity — no `activity` key
      .mockResolvedValueOnce(null) // /stats — no body at all

    const { result } = renderHook(() => useAgentActivity('agent-1'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.activity).toEqual([])
    expect(result.current.stats).toBeNull()
  })

  it('still passes a well-formed response through unchanged', async () => {
    const item = { type: 'payment', id: 'pay-1' }
    mockApiGet
      .mockResolvedValueOnce({ activity: [item] })
      .mockResolvedValueOnce({ all_time: [], today: [], pending_approvals: 2 })

    const { result } = renderHook(() => useAgentActivity('agent-1'))

    await waitFor(() => expect(result.current.activity).toHaveLength(1))
    expect(result.current.activity[0]).toMatchObject(item)
    expect(result.current.stats?.pending_approvals).toBe(2)
  })

  it('sends the browser time zone with the stats request (#3977)', async () => {
    mockApiGet
      .mockResolvedValueOnce({ activity: [] })
      .mockResolvedValueOnce({ all_time: [], today: [], pending_approvals: 0 })

    const { result } = renderHook(() => useAgentActivity('agent-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // #3977: "today" on the stats response is the user's local day, so the
    // request names the browser's IANA zone — omitted entirely when the
    // runtime cannot resolve one (the server's UTC default takes over), the
    // same rule the dashboard overview's request follows.
    const zone = browserTimeZone()
    expect(mockApiGet).toHaveBeenCalledWith(
      zone
        ? `/agent-activity/agent-1/stats?tz=${encodeURIComponent(zone)}`
        : '/agent-activity/agent-1/stats',
    )
  })
})

describe('useAgentActivity visible-only polling (#2732)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function wellFormedActivity() {
    return [
      { activity: [{ type: 'payment', id: 'pay-1' }] },
      { all_time: [], today: [], pending_approvals: 2 },
    ]
  }

  it('a successful silent tick swaps in fresh activity without the loading flag', async () => {
    mockApiGet
      .mockResolvedValueOnce(wellFormedActivity()[0])
      .mockResolvedValueOnce(wellFormedActivity()[1])
    const { result } = renderHook(() => useAgentActivity('agent-1'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.activity).toHaveLength(1)

    mockApiGet
      .mockResolvedValueOnce({ activity: [{ type: 'payment', id: 'pay-2' }] })
      .mockResolvedValueOnce({ all_time: [], today: [], pending_approvals: 3 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.activity[0]?.id).toBe('pay-2')
    expect(result.current.stats?.pending_approvals).toBe(3)
    expect(result.current.loading).toBe(false)
  })

  it('a failed silent tick keeps the last good activity and stats', async () => {
    mockApiGet
      .mockResolvedValueOnce(wellFormedActivity()[0])
      .mockResolvedValueOnce(wellFormedActivity()[1])
    const { result } = renderHook(() => useAgentActivity('agent-1'))
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({ all_time: [], today: [], pending_approvals: 99 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.activity).toHaveLength(1)
    expect(result.current.activity[0]?.id).toBe('pay-1')
    expect(result.current.stats?.pending_approvals).toBe(2)
    expect(result.current.loading).toBe(false)
  })
})
