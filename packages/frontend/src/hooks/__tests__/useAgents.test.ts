import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #3027: mocked through the typed builder rather than a hand-rolled literal.
// This suite overrides every call's resolution directly on the spy
// (`mockApiGet.mockResolvedValueOnce(...)` below) rather than reading the
// builder's route-table defaults, so `apiMock()` is called with no overrides
// — `api.get` IS `apiMock()`'s `get` spy (a plain `vi.fn`), which is what
// makes every existing assertion and `mockResolvedValueOnce` call keep
// working unchanged.
vi.mock('@/lib/api', async () => (await import('../../../e2e/fixtures/api-mock')).apiMock())

import { api } from '@/lib/api'
import { useAgents } from '@/hooks/useAgents'

const mockApiGet = api.get as unknown as ReturnType<typeof vi.fn>

describe('useAgents visible-only polling (#2732)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a successful silent tick refreshes the list without the loading flag', async () => {
    mockApiGet.mockResolvedValueOnce({ agents: [{ id: 'a1', name: 'First' }] })
    const { result } = renderHook(() => useAgents())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.agents).toHaveLength(1)

    mockApiGet.mockResolvedValueOnce({
      agents: [{ id: 'a1', name: 'First' }, { id: 'a2', name: 'Second' }],
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.agents).toHaveLength(2)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('a failed silent tick keeps the last good list and never flips the error banner', async () => {
    mockApiGet.mockResolvedValueOnce({ agents: [{ id: 'a1', name: 'First' }] })
    const { result } = renderHook(() => useAgents())
    await act(async () => {
      await Promise.resolve()
    })

    mockApiGet.mockRejectedValueOnce(new Error('500'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.agents).toHaveLength(1)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('does not queue the skipped tick: one fetch after the rejected one resolves', async () => {
    mockApiGet.mockResolvedValue({ agents: [] })
    const { result } = renderHook(() => useAgents())
    await act(async () => {
      await Promise.resolve()
    })
    const afterMount = mockApiGet.mock.calls.length

    mockApiGet.mockRejectedValueOnce(new Error('slow 500'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mockApiGet.mock.calls.length).toBe(afterMount + 1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mockApiGet.mock.calls.length).toBe(afterMount + 2)
    expect(result.current.loading).toBe(false)
  })
})
