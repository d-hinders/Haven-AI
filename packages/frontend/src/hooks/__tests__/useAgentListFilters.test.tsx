import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSearch = vi.hoisted(() => ({ value: '' }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(mockSearch.value),
}))

const mockReplace = vi.fn()

import type { Agent } from '@/hooks/useAgents'
import { useAgentListFilters } from '../useAgentListFilters'

const agent = (id: string, status: Agent['status']): Agent =>
  ({ id, name: id, status, allowances: [], created_at: '2026-09-01T00:00:00Z', description: null, delegate_address: null } as unknown as Agent)
const AGENTS = [agent('b', 'paused'), agent('a', 'active')]

describe('useAgentListFilters', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    mockSearch.value = ''
    // `history.replaceState`, not the router: synchronous, so an earlier
    // write can never commit after a later one (see the hook's docstring).
    vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => mockReplace(...args))
  })

  it('seeds from the URL on first render and preserves other params on write', () => {
    mockSearch.value = 'setup=first&status=paused'
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.state.facets).toEqual({ status: ['paused'] })
    expect(result.current.filtered.map((a) => a.id)).toEqual(['b'])
    act(() => result.current.setState({ ...result.current.state, q: 'a' }))
    // Existing keys keep their position (URLSearchParams.set), new keys append.
    expect(mockReplace.mock.calls.map((c) => c[2])).toEqual(['/agents?setup=first&status=paused&q=a'])
  })

  it('a write that changes nothing in the URL does not navigate', () => {
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    act(() => result.current.setState({ ...result.current.state, q: '   ' }))
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('reset clears search and facets but keeps the sort', () => {
    mockSearch.value = 'q=x&status=active&sort=seen'
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.active).toBe(true)
    act(() => result.current.reset())
    expect(result.current.state).toEqual({ q: '', facets: {}, sort: 'seen' })
    expect(mockReplace.mock.calls.map((c) => c[2])).toEqual(['/agents?sort=seen'])
  })

  it('writes are synchronous: a later write is never overtaken by an earlier one (#3165 review)', () => {
    // With `router.replace` the two commits below could land in either order;
    // with `replaceState` the URL is already `q=ab` when the first call returns.
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    act(() => result.current.setState({ ...result.current.state, q: 'a' }))
    act(() => result.current.setState({ ...result.current.state, q: 'ab' }))
    expect(mockReplace.mock.calls.map((c) => c[2])).toEqual(['/agents?q=a', '/agents?q=ab'])
    expect(result.current.state.q).toBe('ab')
  })

  it('writes pass a null state so Next treats them as external and re-syncs useSearchParams', () => {
    // On an app-router page `history.state` is `{ __NA: true, … }`; Next's
    // patched `replaceState` skips the sync for any state carrying `__NA`.
    // Mutation: pass `window.history.state` through → red.
    vi.spyOn(window.history, 'state', 'get').mockReturnValue({ __NA: true })
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    act(() => result.current.setState({ ...result.current.state, q: 'a' }))
    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace.mock.calls[0][0]).toBeNull()
  })

  it('a URL change from outside (back/forward) re-seeds the state', () => {
    const { result, rerender } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.active).toBe(false)
    mockSearch.value = 'status=active'
    rerender()
    expect(result.current.state.facets).toEqual({ status: ['active'] })
    expect(result.current.filtered.map((a) => a.id)).toEqual(['a'])
  })
})
