import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSearch = { value: '' }
vi.mock('next/navigation', () => ({
  usePathname: () => '/transactions',
  useSearchParams: () => new URLSearchParams(mockSearch.value),
}))

import { useListUrlState } from '../useListUrlState'
import type { ListUrlSchema } from '../list-url-codec'

const SCHEMA: ListUrlSchema = {
  search: { aliases: ['search'] },
  facets: [{ id: 'direction', values: ['in', 'out'] }],
}

let replace: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  mockSearch.value = 'tab=activity&search=coffee'
  window.history.replaceState(null, '', '/transactions?tab=activity&search=coffee')
  replace = vi.spyOn(window.history, 'replaceState')
})

afterEach(() => {
  replace.mockRestore()
  vi.useRealTimers()
})

describe('useListUrlState', () => {
  it('seeds from the URL, legacy alias included', () => {
    const { result } = renderHook(() => useListUrlState(SCHEMA, { filtering: 'server' }))
    expect(result.current[0]).toEqual({ q: 'coffee', facets: { direction: [] } })
  })

  it('server: writes the URL at once with replaceState, keeping foreign params', () => {
    const { result } = renderHook(() => useListUrlState(SCHEMA, { filtering: 'server' }))
    act(() => result.current[1]({ q: 'tea', facets: { direction: ['out'] } }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenLastCalledWith(null, '', '/transactions?tab=activity&q=tea&direction=out')
  })

  it('browser: the state updates per keystroke, the URL once per 300 ms pause', () => {
    const { result } = renderHook(() => useListUrlState(SCHEMA, { filtering: 'browser' }))
    for (const q of ['t', 'te', 'tea']) act(() => result.current[1]({ ...result.current[0], q }))
    expect(result.current[0].q).toBe('tea')
    expect(replace).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(300))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenLastCalledWith(null, '', '/transactions?tab=activity&q=tea')
  })

  it('re-seeds from the URL on back/forward, but not from its own writes', () => {
    const { result, rerender } = renderHook(() => useListUrlState(SCHEMA, { filtering: 'server' }))
    act(() => result.current[1]({ q: 'tea', facets: { direction: [] } }))
    mockSearch.value = 'tab=activity&q=tea'
    rerender()
    expect(result.current[0].q).toBe('tea')
    mockSearch.value = 'tab=activity&direction=in'
    rerender()
    expect(result.current[0]).toEqual({ q: '', facets: { direction: ['in'] } })
  })

  it('keeps the URL hash', () => {
    window.history.replaceState(null, '', '/transactions?tab=activity&search=coffee#rows')
    const { result } = renderHook(() => useListUrlState(SCHEMA, { filtering: 'server' }))
    act(() => result.current[1]({ q: 'tea', facets: { direction: [] } }))
    expect(replace).toHaveBeenLastCalledWith(null, '', '/transactions?tab=activity&q=tea#rows')
  })

  it('browser: a facet change writes at once, carrying any pending search', () => {
    const { result } = renderHook(() => useListUrlState(SCHEMA, { filtering: 'browser' }))
    act(() => result.current[1]({ ...result.current[0], q: 'tea' }))
    act(() => result.current[1]({ ...result.current[0], facets: { direction: ['in'] } }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenLastCalledWith(null, '', '/transactions?tab=activity&q=tea&direction=in')
    act(() => vi.advanceTimersByTime(1000))
    expect(replace).toHaveBeenCalledTimes(1)
  })
})
