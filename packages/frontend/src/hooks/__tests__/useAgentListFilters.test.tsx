import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSearch = vi.hoisted(() => ({ value: '' }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(mockSearch.value),
}))

const mockReplace = vi.fn()

import type { Agent } from '@/hooks/useAgents'
import { useAgentListFilters } from '../useAgentListFilters'

const agent = (id: string, status: Agent['status'], archived_at: string | null = null): Agent =>
  ({ id, name: id, status, archived_at, allowances: [], created_at: '2026-09-01T00:00:00Z', description: null, delegate_address: null } as unknown as Agent)
const AGENTS = [agent('b', 'paused'), agent('a', 'active'), agent('z', 'revoked', '2026-10-01T00:00:00Z')]

const written = () => mockReplace.mock.calls.map((c) => c[2])

// The list-controls hook writes from `window.location`, so the jsdom URL and
// the mocked `useSearchParams` move together, as they do in a browser.
const realReplaceState = window.history.replaceState.bind(window.history)
function setSearch(value: string) {
  mockSearch.value = value
  realReplaceState(null, '', value ? `/agents?${value}` : '/agents')
}

describe('useAgentListFilters', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    setSearch('')
    // `history.replaceState`, not the router: synchronous, so an earlier
    // write can never commit after a later one (see `useListUrlState`).
    vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => mockReplace(...args))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds from the URL on first render and preserves other params on write', () => {
    setSearch('setup=first&status=paused')
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.state.facets.status).toEqual(['paused'])
    expect(result.current.filtered.map((a) => a.id)).toEqual(['b'])
    act(() => result.current.setState({ ...result.current.state, sort: 'seen' }))
    // Existing keys keep their position (URLSearchParams.set), new keys append.
    expect(written()).toEqual(['/agents?setup=first&status=paused&sort=seen'])
  })

  it('search filters on every keystroke; only its URL write waits for a 300 ms pause (#4113)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    act(() => result.current.setState({ ...result.current.state, q: 'a' }))
    // The rows follow at once…
    expect(result.current.filtered.map((a) => a.id)).toEqual(['a'])
    // …the address bar does not, until typing pauses.
    expect(mockReplace).not.toHaveBeenCalled()
    act(() => result.current.setState({ ...result.current.state, q: 'ab' }))
    act(() => vi.advanceTimersByTime(299))
    expect(mockReplace).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(written()).toEqual(['/agents?q=ab'])
  })

  it('a write that changes nothing in the URL does not navigate', () => {
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    act(() => result.current.setState({ ...result.current.state, sort: 'name' }))
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('reset clears search and facets but keeps the sort', () => {
    vi.useFakeTimers()
    setSearch('q=x&status=active&archived=shown&sort=seen')
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.active).toBe(true)
    act(() => result.current.reset())
    // The search changed too, so the browser-list rule holds the URL write
    // for the search pause (`useListUrlState`).
    act(() => vi.advanceTimersByTime(300))
    expect(result.current.state.q).toBe('')
    expect(result.current.state.facets.status).toEqual([])
    expect(result.current.state.facets.archived).toEqual(['hidden'])
    expect(result.current.state.sort).toBe('seen')
    expect(written()).toEqual(['/agents?sort=seen'])
  })

  it('writes pass a null state so Next treats them as external and re-syncs useSearchParams', () => {
    // On an app-router page `history.state` is `{ __NA: true, … }`; Next's
    // patched `replaceState` skips the sync for any state carrying `__NA`.
    const stateSpy = vi.spyOn(window.history, 'state', 'get').mockReturnValue({ __NA: true })
    try {
      const { result } = renderHook(() => useAgentListFilters(AGENTS))
      act(() => result.current.setState({ ...result.current.state, sort: 'seen' }))
      expect(mockReplace).toHaveBeenCalledTimes(1)
      expect(mockReplace.mock.calls[0][0]).toBeNull()
    } finally {
      stateSpy.mockRestore()
    }
  })

  it('a URL change from outside (back/forward) re-seeds the state', () => {
    const { result, rerender } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.active).toBe(false)
    setSearch('status=active')
    rerender()
    expect(result.current.state.facets.status).toEqual(['active'])
    expect(result.current.filtered.map((a) => a.id)).toEqual(['a'])
  })

  it('existing links keep working: q, sort and comma-joined facet ids (#3165 keys)', () => {
    setSearch('q=b&status=paused,active&budget=none&sort=created')
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.state.q).toBe('b')
    expect(result.current.state.sort).toBe('created')
    expect(result.current.state.facets.status).toEqual(['paused', 'active'])
    expect(result.current.state.facets.budget).toEqual(['none'])
    expect(result.current.filtered.map((a) => a.id)).toEqual(['b'])
  })

  describe('Archived (#4113)', () => {
    it('hides archived agents by default, and the total is the default view', () => {
      const { result } = renderHook(() => useAgentListFilters(AGENTS))
      expect(result.current.state.facets.archived).toEqual(['hidden'])
      expect(result.current.filtered.map((a) => a.id)).toEqual(['a', 'b'])
      expect(result.current.total).toBe(2)
      expect(result.current.active).toBe(false)
      expect(result.current.facets.map((f) => f.id)).toEqual(['status', 'budget', 'archived'])
    })

    it('Shown lists them alongside the others, and the count includes them', () => {
      const { result } = renderHook(() => useAgentListFilters(AGENTS))
      act(() => result.current.setState({ ...result.current.state, facets: { ...result.current.state.facets, archived: ['shown'] } }))
      expect(result.current.filtered.map((a) => a.id)).toEqual(['a', 'b', 'z'])
      expect(result.current.total).toBe(3)
      expect(result.current.active).toBe(true)
      expect(written()).toEqual(['/agents?archived=shown'])
    })

    it('its URL key round-trips, and its absence means Hidden', () => {
      setSearch('archived=shown')
      const { result, rerender } = renderHook(() => useAgentListFilters(AGENTS))
      expect(result.current.filtered.map((a) => a.id)).toEqual(['a', 'b', 'z'])
      setSearch('')
      rerender()
      expect(result.current.state.facets.archived).toEqual(['hidden'])
      expect(result.current.filtered.map((a) => a.id)).toEqual(['a', 'b'])
    })

    it('Status: Revoked still matches a revoked agent that is not archived', () => {
      const revoked = [...AGENTS, agent('r', 'revoked')]
      setSearch('status=revoked')
      const { result } = renderHook(() => useAgentListFilters(revoked))
      expect(result.current.filtered.map((a) => a.id)).toEqual(['r'])
      expect(result.current.counts.status.revoked).toBe(1)
    })
  })
})
