import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The request half of the Analytics page (#2947, slice C).
 *
 * Three promises this hook makes, and each is one the page cannot verify on
 * its own:
 *
 *  1. **One request per window.** The endpoint exists so the page has one
 *     loading state and one basis, and a hook that fanned out per tile would
 *     put five answers on the screen where there is one. The assertion is a
 *     call COUNT, because "one" is the property and a shape cannot show it.
 *  2. **A superseded answer does not paint.** The reader can move the range
 *     while a request is in flight; the two responses then arrive in any order,
 *     and the older one writing last would put two windows on one page.
 *  3. **`tz` is the browser's zone, or it is absent.** The spec rejects
 *     offsets and abbreviations, and a hand-set 'UTC' would claim a calendar
 *     the reader may not live in.
 *
 * `api.get` is mocked at the module seam, the idiom of
 * `hooks/__tests__/useBalances.test.ts`, so the flight can be held open and
 * resolved out of order deliberately rather than raced.
 */

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
  // The real class, so the 404-shape test throws the SAME error the client
  // throws — a plain Error with a status property would test a shape the
  // hook does not branch on.
  ApiRequestError: class ApiRequestError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

import { ApiRequestError } from '@/lib/api'
import { useAnalyticsOverview } from '@/hooks/useAnalyticsOverview'
import { browserTimeZone } from '@/lib/analytics-range'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../scripts/screenshot.mjs'
import type { AnalyticsOverviewResponse, AnalyticsRangeValue } from '@/types/analytics'

const OVERVIEW = FIXTURE_ANALYTICS_OVERVIEW as AnalyticsOverviewResponse
/** A second, distinguishable window, derived so the two cannot be confused by
 *  a reader of the assertion: the totals move, the shape stays. */
const OTHER: AnalyticsOverviewResponse = {
  ...OVERVIEW,
  totals: { ...OVERVIEW.totals, spent: '99.00' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function query(path: string): URLSearchParams {
  return new URLSearchParams(path.slice(path.indexOf('?') + 1))
}

beforeEach(() => {
  mockApiGet.mockReset()
})

describe('useAnalyticsOverview', () => {
  it('asks the one question the page has, once, per window', async () => {
    mockApiGet.mockResolvedValue(OVERVIEW)
    const { result } = renderHook(() => useAnalyticsOverview('30d', 'usd'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // The count is the whole point of the endpoint: not one request per tile,
    // not one per figure, one per page.
    expect(mockApiGet).toHaveBeenCalledTimes(1)
    expect(result.current.data).toEqual(OVERVIEW)
    expect(result.current.failed).toBe(false)
  })

  it('sends the window, the booking currency, and the browser zone — nothing else', async () => {
    mockApiGet.mockResolvedValue(OVERVIEW)
    const { result } = renderHook(() => useAnalyticsOverview('7d', 'eur'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const path = mockApiGet.mock.calls[0][0] as string
    expect(path.startsWith('/analytics/overview?')).toBe(true)
    const params = query(path)
    expect(params.get('range')).toBe('7d')
    expect(params.get('currency')).toBe('eur')
    // The zone the server buckets `by_day` on is the one the reader's calendar
    // is in. Read from the same function the hook reads, so the pair cannot
    // drift apart and the assertion cannot rot into a lie about a machine in
    // another zone.
    expect(params.get('tz')).toBe(browserTimeZone() ?? null)
    // No page number, no ordering key, no `undefined` stringified onto the
    // wire: the endpoint takes exactly these three, and a fourth parameter is
    // how a hook quietly starts sending something the route will not read.
    expect(Array.from(params.keys()).sort()).toStrictEqual(
      ['currency', 'range', ...(browserTimeZone() === undefined ? [] : ['tz'])].sort(),
    )
  })

  it('re-asks nothing when a re-render changes no answer', async () => {
    mockApiGet.mockResolvedValue(OVERVIEW)
    const { result, rerender } = renderHook(
      ({ range }: { range: AnalyticsRangeValue }) => useAnalyticsOverview(range, 'usd'),
      { initialProps: { range: '30d' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ range: '30d' })
    rerender({ range: '30d' })
    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })

  it('does not let an older window paint over the one the reader is looking at', async () => {
    const first = deferred<AnalyticsOverviewResponse>()
    const second = deferred<AnalyticsOverviewResponse>()
    mockApiGet
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { result, rerender } = renderHook(
      ({ range }: { range: AnalyticsRangeValue }) => useAnalyticsOverview(range, 'usd'),
      { initialProps: { range: '30d' } },
    )

    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1))
    rerender({ range: '7d' })
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(2))

    // The 30d answer, asked second, arrives FIRST. The reader moved on to
    // 7d, so it is the late answer that must win.
    act(() => first.resolve(OVERVIEW))
    act(() => second.resolve(OTHER))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual(OTHER)
    expect(result.current.data?.totals.spent).toBe('99.00')
  })

  it('settles into the failure state without a data and without a lie about cause', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('HTTP 500 from /analytics/overview'))
    const { result } = renderHook(() => useAnalyticsOverview('30d', 'usd'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.failed).toBe(true)
    expect(result.current.data).toBeNull()
  })

  it('asks again on the reader’s own initiative and clears the failure when it lands', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useAnalyticsOverview('30d', 'usd'))
    await waitFor(() => expect(result.current.failed).toBe(true))

    mockApiGet.mockResolvedValueOnce(OVERVIEW)
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(mockApiGet.mock.calls[1][0]).toBe(mockApiGet.mock.calls[0][0]) // the same window
    expect(result.current.failed).toBe(false)
    expect(result.current.data).toEqual(OVERVIEW)
  })

  it('asks for no second request when the reader leaves before the answer lands', async () => {
    const flight = deferred<AnalyticsOverviewResponse>()
    mockApiGet.mockReturnValue(flight.promise)
    const { unmount } = renderHook(() => useAnalyticsOverview('30d', 'usd'))
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1))

    unmount()
    expect(() => flight.resolve(OVERVIEW)).not.toThrow()
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1))
  })

  describe('the agent filter (#4333)', () => {
    it('rides the SAME request when set, and stays off the wire when absent', async () => {
      mockApiGet.mockResolvedValue(OVERVIEW)
      const { result } = renderHook(() => useAnalyticsOverview('30d', 'usd', 'agent-research'))
      await waitFor(() => expect(result.current.loading).toBe(false))

      const params = query(mockApiGet.mock.calls[0][0] as string)
      expect(params.get('agentId')).toBe('agent-research')

      mockApiGet.mockResolvedValue(OVERVIEW)
      renderHook(() => useAnalyticsOverview('30d', 'usd', null))
      await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(2))
      expect(query(mockApiGet.mock.calls[1][0] as string).get('agentId')).toBeNull()
    })

    it('re-asks when the agent changes: the path memo includes agentId', async () => {
      mockApiGet.mockResolvedValue(OVERVIEW)
      const { result, rerender } = renderHook(
        ({ agentId }: { agentId: string | null }) => useAnalyticsOverview('30d', 'usd', agentId),
        { initialProps: { agentId: null as string | null } },
      )
      await waitFor(() => expect(result.current.loading).toBe(false))
      rerender({ agentId: 'agent-research' })
      await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(2))
      expect(query(mockApiGet.mock.calls[1][0] as string).get('agentId')).toBe('agent-research')
    })

    it('surfaces a 404 as agentNotFound, not as a failed page (#4333)', async () => {
      // The endpoint answers 404 for a foreign agentId (#4332). That is not an
      // outage: the page clears the filter with a notice, so the hook reports
      // it as its own flag and leaves `failed` — the page error state — alone.
      mockApiGet.mockRejectedValueOnce(new ApiRequestError('Not Found', 404))
      const { result } = renderHook(() => useAnalyticsOverview('30d', 'usd', 'agent-ghost'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.agentNotFound).toBe(true)
      expect(result.current.failed).toBe(false)
    })

    it('reports every other failure as failed, not agentNotFound', async () => {
      mockApiGet.mockRejectedValueOnce(new ApiRequestError('Service Unavailable', 503))
      const { result } = renderHook(() => useAnalyticsOverview('30d', 'usd', 'agent-research'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.failed).toBe(true)
      expect(result.current.agentNotFound).toBe(false)
    })
  })
})
