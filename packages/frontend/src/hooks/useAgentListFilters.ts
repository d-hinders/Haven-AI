'use client'

import { useCallback, useMemo } from 'react'
import type { Agent } from '@/hooks/useAgents'
import { clearedListState, type ListState } from '@/components/ui/list-url-codec'
import { useListUrlState } from '@/components/ui/useListUrlState'
import {
  ARCHIVED_FACET,
  BUILT_IN_FACETS,
  agentListUrlSchema,
  applyAgentListFilters,
  facetCounts,
  facetMatches,
  isFilterActive,
  toAgentFilterState,
  type AgentFacet,
} from '@/lib/agent-list-filters'

export interface UseAgentListFiltersReturn {
  /** The list-controls state, handed to `ListToolbar` as is. */
  state: ListState
  setState: (next: ListState) => void
  /** Clear filters: search empty, every facet at its default, sort kept. */
  reset: () => void
  filtered: Agent[]
  /**
   * The agents the list shows with nothing but its defaults applied — the
   * count's "of N". Archived agents are in it only while "Archived: Shown"
   * is chosen (#4113), so an untouched list reads "20 agents" over 20 rows.
   */
  total: number
  counts: Record<string, Record<string, number>>
  active: boolean
  /** The registered facets, Archived last. */
  facets: AgentFacet[]
}

/**
 * Filter state for the `/agents` list (#3165), on the list-controls pattern
 * since #4113: `useListUrlState` mirrors it to the URL through the shared
 * codec, with `agentListUrlSchema` keeping the keys #3165 shipped
 * (`?q=…&status=active,paused&sort=seen`) and leaving `setup` alone. The
 * list filters in the browser, so rows follow every keystroke and only the
 * URL write of a search waits for a pause.
 *
 * `agents` is EVERY agent, archived ones included: the Archived facet
 * (#4113) is what hides them, by default.
 *
 * `facets` is the extension point: pass a MEMOIZED `[...BUILT_IN_FACETS,
 * labelsFacet]` (a module constant, or `useMemo`) and the toolbar, the URL
 * codec and the counts all pick it up — an inline spread would re-run the
 * memos on every render. The hook appends `ARCHIVED_FACET` itself, so no
 * surface can forget it, and does not know what a label is.
 */
export function useAgentListFilters(
  agents: Agent[],
  facets: AgentFacet[] = BUILT_IN_FACETS,
): UseAgentListFiltersReturn {
  const allFacets = useMemo(
    () => [...facets.filter((facet) => facet.id !== ARCHIVED_FACET.id), ARCHIVED_FACET],
    [facets],
  )
  // The schema is keyed on the facet IDS only: options and counts change on
  // every poll, and a new schema object would re-key the URL hook for nothing.
  const idsKey = allFacets.map((facet) => facet.id).join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const schema = useMemo(() => agentListUrlSchema(allFacets), [idsKey])
  const [state, setState] = useListUrlState(schema, { filtering: 'browser' })

  const reset = useCallback(() => setState(clearedListState(state, schema)), [setState, state, schema])

  const filterState = useMemo(() => toAgentFilterState(state), [state])
  const filtered = useMemo(
    () => applyAgentListFilters(agents, filterState, allFacets),
    [agents, filterState, allFacets],
  )
  // Archived is the one facet whose choice changes the total: "Shown" brings
  // archived agents into the list AND into its "of N".
  const archivedKey = (state.facets[ARCHIVED_FACET.id] ?? ARCHIVED_FACET.defaultValue ?? []).join(',')
  const total = useMemo(() => {
    const archived = archivedKey ? archivedKey.split(',') : []
    return agents.filter((agent) => facetMatches(ARCHIVED_FACET, agent, archived)).length
  }, [agents, archivedKey])
  const counts = useMemo(() => facetCounts(agents, filterState, allFacets), [agents, filterState, allFacets])

  return {
    state,
    setState,
    reset,
    filtered,
    total,
    counts,
    active: isFilterActive(filterState, allFacets),
    facets: allFacets,
  }
}
