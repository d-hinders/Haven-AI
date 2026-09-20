import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReplace = vi.hoisted(() => vi.fn())
const mockSearch = vi.hoisted(() => ({ value: '' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(mockSearch.value),
}))

import type { Agent } from '@/hooks/useAgents'
import { useAgentListFilters } from '../useAgentListFilters'

const agent = (id: string, status: Agent['status']): Agent =>
  ({ id, name: id, status, allowances: [], created_at: '2026-09-01T00:00:00Z', description: null, delegate_address: null } as unknown as Agent)
const AGENTS = [agent('b', 'paused'), agent('a', 'active')]

describe('useAgentListFilters', () => {
  beforeEach(() => {
    mockReplace.mockClear()
    mockSearch.value = ''
  })

  it('seeds from the URL on first render and preserves other params on write', () => {
    mockSearch.value = 'setup=first&status=paused'
    const { result } = renderHook(() => useAgentListFilters(AGENTS))
    expect(result.current.state.facets).toEqual({ status: ['paused'] })
    expect(result.current.filtered.map((a) => a.id)).toEqual(['b'])
    act(() => result.current.setState({ ...result.current.state, q: 'a' }))
    // Existing keys keep their position (URLSearchParams.set), new keys append.
    expect(mockReplace).toHaveBeenCalledWith('/agents?setup=first&status=paused&q=a', { scroll: false })
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
    expect(mockReplace).toHaveBeenCalledWith('/agents?sort=seen', { scroll: false })
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
