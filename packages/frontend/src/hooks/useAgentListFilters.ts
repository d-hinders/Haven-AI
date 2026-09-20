'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import type { Agent } from '@/hooks/useAgents'
import {
  BUILT_IN_FACETS,
  EMPTY_FILTER_STATE,
  applyAgentListFilters,
  facetCounts,
  isFilterActive,
  readFilterState,
  writeFilterState,
  type AgentFacet,
  type AgentListFilterState,
} from '@/lib/agent-list-filters'

export interface UseAgentListFiltersReturn {
  state: AgentListFilterState
  setState: (next: AgentListFilterState) => void
  reset: () => void
  filtered: Agent[]
  counts: Record<string, Record<string, number>>
  active: boolean
  facets: AgentFacet[]
}

/**
 * Filter state for the `/agents` list (#3165), mirrored to the URL so a view
 * is shareable (`?q=…&status=active,paused&sort=seen`; precedent: the
 * `?setup=` hand-off on the same page and `TransactionsClient`'s
 * `useSearchParams` seeding).
 *
 * The URL is the source of truth on first render and the mirror afterwards.
 * Writes go through `window.history.replaceState` — the same call this page
 * already uses to tidy `?setup=` — not `router.replace`: the router's replace
 * is an async transition, and with one navigation per keystroke an EARLIER
 * write can commit after a later one, at which point a "the URL changed under
 * us" re-seed would hand the input a stale value (measured in review of
 * #3165: write `q=a`, write `q=ab`, commit `q=a` → the field reads `a`).
 * `replaceState` is synchronous and Next syncs `useSearchParams` from a native
 * call made with a `null` state (see the call site), so the URL never lags
 * the state. A back/forward navigation that changes the
 * query still re-seeds the state. Other query parameters on the page are
 * preserved by `writeFilterState`.
 *
 * `facets` is the extension point: pass a MEMOIZED `[...BUILT_IN_FACETS,
 * labelsFacet]` (a module constant, or `useMemo`) and the toolbar, the URL
 * codec and the counts all pick it up — an inline spread would re-run the
 * memos on every render. The hook does not know what a label is.
 */
export function useAgentListFilters(
  agents: Agent[],
  facets: AgentFacet[] = BUILT_IN_FACETS,
): UseAgentListFiltersReturn {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams?.toString() ?? ''

  const [state, setStateRaw] = useState<AgentListFilterState>(() =>
    readFilterState(new URLSearchParams(search), facets),
  )

  // Re-seed from the URL when it changes underneath us (back/forward, a
  // link click on the same page) — but not for the writes we made ourselves.
  const lastWritten = useRef(search)
  useEffect(() => {
    if (search === lastWritten.current) return
    lastWritten.current = search
    setStateRaw(readFilterState(new URLSearchParams(search), facets))
  }, [search, facets])

  const setState = useCallback(
    (next: AgentListFilterState) => {
      setStateRaw(next)
      const params = writeFilterState(new URLSearchParams(search), next, facets)
      const nextSearch = params.toString()
      if (nextSearch === search) return
      lastWritten.current = nextSearch
      try {
        // `null`, never `window.history.state`: Next's app router patches
        // `replaceState` and treats a state object carrying its own `__NA`
        // marker as an INTERNAL write that must not re-sync `useSearchParams`
        // (`next/dist/client/components/app-router.js`, the `data.__NA` branch).
        // `history.state` on this page IS that object, so passing it through
        // left the URL stale after every clear (measured in review of #3165).
        // With `null` Next re-attaches its internals and dispatches the sync.
        window.history.replaceState(null, '', nextSearch ? `${pathname}?${nextSearch}` : pathname)
      } catch {
        // A URL that stays in step is a convenience, never worth a thrown render.
      }
    },
    [search, facets, pathname],
  )

  const reset = useCallback(
    () => setState({ ...EMPTY_FILTER_STATE, sort: state.sort }),
    [setState, state.sort],
  )

  const filtered = useMemo(() => applyAgentListFilters(agents, state, facets), [agents, state, facets])
  const counts = useMemo(() => facetCounts(agents, state, facets), [agents, state, facets])

  return { state, setState, reset, filtered, counts, active: isFilterActive(state), facets }
}
