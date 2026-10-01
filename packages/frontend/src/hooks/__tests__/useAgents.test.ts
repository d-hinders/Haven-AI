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

describe('useAgents half-revoked bookkeeping (#3542)', () => {
  const mockApiPost = api.post as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockApiGet.mockClear()
    mockApiPost.mockReset()
  })

  async function mountWith(agent: Record<string, unknown>) {
    mockApiGet.mockResolvedValueOnce({ agents: [agent] })
    const hook = renderHook(() => useAgents())
    await act(async () => {
      await Promise.resolve()
    })
    return hook
  }

  it('revoking or archiving does NOT clear the live-budget count — only ending the budget does', async () => {
    const { result } = await mountWith({
      id: 'a1',
      name: 'First',
      status: 'active',
      live_delegation_count: 2,
    })
    mockApiPost.mockResolvedValueOnce({})
    await act(async () => {
      await result.current.revokeAgent('a1')
    })
    mockApiPost.mockResolvedValueOnce({ archived_at: '2026-06-01T00:00:00Z' })
    await act(async () => {
      await result.current.archiveAgent('a1')
    })
    expect(result.current.agents[0]).toMatchObject({
      status: 'revoked',
      archived_at: '2026-06-01T00:00:00Z',
      live_delegation_count: 2,
    })

    act(() => {
      result.current.markBudgetEnded('a1')
    })
    expect(result.current.agents[0]!.live_delegation_count).toBe(0)
  })

  it('markBudgetEnded touches only the named agent', async () => {
    mockApiGet.mockResolvedValueOnce({
      agents: [
        { id: 'a1', name: 'First', live_delegation_count: 1 },
        { id: 'a2', name: 'Second', live_delegation_count: 1 },
      ],
    })
    const { result } = renderHook(() => useAgents())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      result.current.markBudgetEnded('a2')
    })
    expect(result.current.agents.map((a) => a.live_delegation_count)).toEqual([1, 0])
  })
})

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
    // `Once`: a persistent `mockResolvedValue` would replace the routed
    // implementation for every later case in this file (re-review nit).
    mockApiGet.mockResolvedValueOnce({ agents: [] })
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
