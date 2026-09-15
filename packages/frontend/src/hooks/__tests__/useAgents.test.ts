import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #3027: mocked through the typed builder rather than a hand-rolled literal.
// The mount tick reads the builder's `/agents` default (the e2e fixture's
// agent, schema-checked against `@haven_ai/core`); later ticks are queued on
// the same spy with `mockResolvedValueOnce`/`mockRejectedValueOnce`, which
// take one call each ahead of the routed implementation. `beforeEach` uses
// `mockClear`, not `mockReset` — a reset would drop the route table and every
// call would resolve `undefined` (the inert shape review caught on the first
// push of this PR).
vi.mock('@/lib/api', async () => (await import('../../../e2e/fixtures/api-mock')).apiMock())

import { api } from '@/lib/api'
import { testAgent } from '../../../e2e/fixtures/haven-api'
import { useAgents } from '@/hooks/useAgents'

const mockApiGet = api.get as unknown as ReturnType<typeof vi.fn>

describe('useAgents visible-only polling (#2732)', () => {
  beforeEach(() => {
    mockApiGet.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a successful silent tick refreshes the list without the loading flag', async () => {
    // Mount tick: served by the typed route table, no override queued.
    const { result } = renderHook(() => useAgents())
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockApiGet).toHaveBeenCalledWith('/agents')
    expect(result.current.loading).toBe(false)
    expect(result.current.agents).toHaveLength(1)
    // Pinned to the e2e constant, not to the builder's own table — a builder
    // default that drifts from the fixture must show up here.
    expect(result.current.agents[0]!.id).toBe(testAgent.id)

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
