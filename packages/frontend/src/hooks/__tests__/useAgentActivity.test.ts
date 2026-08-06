import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useActivityFeed, useAgentActivity } from '@/hooks/useAgentActivity'

/**
 * #1075: a 200 whose body omits `activity` used to be written straight into
 * state, so `activity` became `undefined` and the agent detail page's
 * `activity.filter(...)` threw during render — the whole route went blank
 * (and took the #896 screenshot harness with it). The array these hooks
 * expose is typed non-nullable; it has to stay that way whatever the body is.
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
      .mockResolvedValueOnce({ all_time: [], today: [], this_week: [], pending_approvals: 2 })

    const { result } = renderHook(() => useAgentActivity('agent-1'))

    await waitFor(() => expect(result.current.activity).toHaveLength(1))
    expect(result.current.activity[0]).toMatchObject(item)
    expect(result.current.stats?.pending_approvals).toBe(2)
  })
})

describe('useActivityFeed', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('keeps activity an array when the response omits the key', async () => {
    // Same failure class as above — the dashboard feed reads the same route
    // family, so it gets the same floor.
    mockApiGet.mockResolvedValueOnce({})

    const { result } = renderHook(() => useActivityFeed())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.activity).toEqual([])
    expect(result.current.pendingApprovals).toBe(0)
  })
})
