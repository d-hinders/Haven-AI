'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { parseListState, serializeListState, type ListState, type ListUrlSchema } from './list-url-codec'

/** The one search debounce the list-controls standard allows (#4110). */
export const listSearchDebounceMs = 300

export interface UseListUrlStateOptions {
  /**
   * Where this list filters (#4110). `server`: `ListToolbar` already debounces
   * the search commit, so the URL is written as soon as a change arrives.
   * `browser`: rows re-render on every keystroke and only the URL write of a
   * search change waits for a pause — one `replaceState` per pause, not per
   * key.
   */
  filtering: 'server' | 'browser'
}

/**
 * A list's control state, mirrored to the URL through the list-controls codec
 * (`list-url-codec.ts`). The page owns it and hands `state` / `setState` to
 * `ListToolbar`.
 *
 * The URL is the source of truth on first render and the mirror afterwards,
 * the posture `useAgentListFilters` set in #3165 and for its reasons: writes
 * use `window.history.replaceState(null, …)` — synchronous, no history entry
 * per change, and with a `null` state so Next re-syncs `useSearchParams`
 * (its app router treats a state object carrying its own marker as an
 * internal write). A back/forward navigation that changes the query
 * re-seeds the state; our own writes do not.
 */
export function useListUrlState(
  schema: ListUrlSchema,
  { filtering }: UseListUrlStateOptions,
): [ListState, (next: ListState) => void] {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams?.toString() ?? ''

  const [state, setStateRaw] = useState<ListState>(() => parseListState(new URLSearchParams(search), schema))

  // The latest state, readable from the debounced URL write.
  const stateRef = useRef(state)
  const lastWritten = useRef(search)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (search === lastWritten.current) return
    lastWritten.current = search
    if (pending.current) {
      clearTimeout(pending.current)
      pending.current = null
    }
    const parsed = parseListState(new URLSearchParams(search), schema)
    stateRef.current = parsed
    setStateRaw(parsed)
  }, [search, schema])

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  const write = useCallback(
    (next: ListState) => {
      const base = typeof window === 'undefined' ? search : window.location.search.replace(/^\?/, '')
      const nextSearch = serializeListState(next, schema, new URLSearchParams(base)).toString()
      if (nextSearch === base) return
      lastWritten.current = nextSearch
      try {
        const hash = window.location.hash
        window.history.replaceState(null, '', `${nextSearch ? `${pathname}?${nextSearch}` : pathname}${hash}`)
      } catch {
        // A URL that stays in step is a convenience, never worth a thrown render.
      }
    },
    [schema, search, pathname],
  )

  const setState = useCallback(
    (next: ListState) => {
      const searchOnly = filtering === 'browser' && next.q !== stateRef.current.q
      stateRef.current = next
      setStateRaw(next)
      if (pending.current) {
        clearTimeout(pending.current)
        pending.current = null
      }
      if (searchOnly) {
        pending.current = setTimeout(() => {
          pending.current = null
          write(stateRef.current)
        }, listSearchDebounceMs)
        return
      }
      write(next)
    },
    [filtering, write],
  )

  return [state, setState]
}
