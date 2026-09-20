'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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
 * The URL is the source of truth on first render and the mirror afterwards:
 * state changes call `router.replace` (no history entry per keystroke), and
 * a back/forward navigation that changes the query re-seeds the state. Other
 * query parameters on the page are preserved by `writeFilterState`.
 *
 * `facets` is the extension point: pass `[...BUILT_IN_FACETS, labelsFacet]`
 * and the toolbar, the URL codec and the counts all pick it up. The hook does
 * not know what a label is.
 */
export function useAgentListFilters(
  agents: Agent[],
  facets: AgentFacet[] = BUILT_IN_FACETS,
): UseAgentListFiltersReturn {
  const router = useRouter()
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
      router.replace(nextSearch ? `${pathname}?${nextSearch}` : pathname, { scroll: false })
    },
    [search, facets, pathname, router],
  )

  const reset = useCallback(
    () => setState({ ...EMPTY_FILTER_STATE, sort: state.sort }),
    [setState, state.sort],
  )

  const filtered = useMemo(() => applyAgentListFilters(agents, state, facets), [agents, state, facets])
  const counts = useMemo(() => facetCounts(agents, state, facets), [agents, state, facets])

  return { state, setState, reset, filtered, counts, active: isFilterActive(state), facets }
}
