import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useAgentActivity, useAgentPaymentLedger } from '@/hooks/useAgentActivity'
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

/**
 * #4249 (#4246 review B3): the Activity tab's paged reader. The page tests
 * mock this hook, so the request it BUILDS was pinned nowhere — removing the
 * `token` parameter left every test green. These tests read the URL.
 */
describe('useAgentPaymentLedger', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  function paymentRow(id: string) {
    return { type: 'payment', id }
  }

  function lastUrl(): URL {
    const path = String(mockApiGet.mock.calls.at(-1)?.[0])
    return new URL(path, 'https://haven.test')
  }

  it('sends every filter on the kinded payments read', async () => {
    mockApiGet.mockResolvedValue({ activity: [paymentRow('p1')], total: 1, hasMore: false })
    const filters = {
      status: 'failed',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      q: 'merchant',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
    }
    const { result } = renderHook(() => useAgentPaymentLedger('agent-1', filters, 25))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const url = lastUrl()
    expect(url.pathname).toBe('/agent-activity/agent-1/activity')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'payments',
      limit: '25',
      offset: '0',
      status: 'failed',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      q: 'merchant',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
    })
  })

  it('omits filters that are not set', async () => {
    mockApiGet.mockResolvedValue({ activity: [], total: 0, hasMore: false })
    const { result } = renderHook(() => useAgentPaymentLedger('agent-1', {}, 25))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect([...lastUrl().searchParams.keys()].sort()).toEqual(['kind', 'limit', 'offset'])
  })

  it('pages by offset and appends', async () => {
    mockApiGet
      .mockResolvedValueOnce({ activity: [paymentRow('p1'), paymentRow('p2')], total: 3, hasMore: true })
      .mockResolvedValueOnce({ activity: [paymentRow('p3')], total: 3, hasMore: false })
    const { result } = renderHook(() => useAgentPaymentLedger('agent-1', { token: '0xabc' }, 2))
    await waitFor(() => expect(result.current.payments).toHaveLength(2))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.payments).toHaveLength(3))
    expect(lastUrl().searchParams.get('offset')).toBe('2')
    expect(lastUrl().searchParams.get('token')).toBe('0xabc')
    expect(result.current.hasMore).toBe(false)
  })

  it('does not read at all without an agent (the tab holds a pending token this way)', async () => {
    const { result } = renderHook(() => useAgentPaymentLedger(null, { token: '0xabc' }, 25))
    await Promise.resolve()
    expect(mockApiGet).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(true)
  })

  it('holding the read retires a request already in flight (#4249 review N2)', async () => {
    let resolveInFlight: (value: unknown) => void = () => {}
    mockApiGet.mockImplementationOnce(() => new Promise((resolve) => { resolveInFlight = resolve }))

    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string | null }) => useAgentPaymentLedger(agentId, {}, 25),
      { initialProps: { agentId: 'agent-1' as string | null } },
    )
    // The tab holds the read (a selected token not yet resolved) while the
    // unfiltered request is still out.
    rerender({ agentId: null })
    await act(async () => {
      resolveInFlight({ activity: [paymentRow('unfiltered')], total: 1, hasMore: false })
    })
    expect(result.current.payments).toEqual([])
    expect(result.current.loading).toBe(true)
    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })

  it('a late answer for superseded filters never overwrites the current list', async () => {
    let resolveStale: (value: unknown) => void = () => {}
    mockApiGet
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve }))
      .mockResolvedValueOnce({ activity: [paymentRow('fresh')], total: 1, hasMore: false })

    const { result, rerender } = renderHook(
      ({ token }: { token: string }) => useAgentPaymentLedger('agent-1', { token }, 25),
      { initialProps: { token: '0xold' } },
    )
    rerender({ token: '0xnew' })
    await waitFor(() => expect(result.current.payments.map((p) => p.id)).toEqual(['fresh']))

    await act(async () => {
      resolveStale({ activity: [paymentRow('stale')], total: 1, hasMore: false })
    })
    expect(result.current.payments.map((p) => p.id)).toEqual(['fresh'])
  })
})
