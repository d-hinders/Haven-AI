import type { Agent } from '@/hooks/useAgents'

/**
 * Search, facets and sort for the `/agents` list (#3165).
 *
 * Everything here is pure: a facet is DATA — an id, its options, a predicate
 * over the agent row, a match mode — so a later surface registers a facet
 * (labels from #3167, organizations from #3164) without editing the hook or
 * the toolbar. The built-in facets are the two the row already carries at
 * this head: status and budget state.
 *
 * Budget state is derived from `allowances` alone, which is all `GET /agents`
 * returns. "Exhausted", "near limit" and "pending signature" (the issue names
 * them) need a per-agent remaining figure or a setup state the row does not
 * carry, so they are NOT offered as options: a facet that silently matched
 * nothing would read as "no agent is near its limit", which is the false
 * zero this codebase keeps meeting. They arrive with a server field; see the
 * PR body for the note the issue asks for.
 */

export type AgentFacetMatch = 'any' | 'all'

export interface AgentFacetOption {
  value: string
  label: string
}

export interface AgentFacet<TAgent = Agent> {
  /** URL key and React key. `q` and `sort` are reserved. */
  id: string
  label: string
  options: AgentFacetOption[]
  /**
   * `any`: the agent passes if it matches ANY selected value (status is one
   * value per agent, so `any` is the only sensible mode). `all`: every
   * selected value must match — the mode a multi-valued facet such as
   * labels may prefer; the registering surface decides, not the toolbar.
   */
  match: AgentFacetMatch
  /** Does this agent satisfy ONE selected value? */
  predicate: (agent: TAgent, value: string) => boolean
}

export type AgentSortKey = 'name' | 'seen' | 'created' | 'budget'

export interface AgentListFilterState {
  q: string
  facets: Record<string, string[]>
  sort: AgentSortKey
}

export const DEFAULT_SORT: AgentSortKey = 'name'

export const SORT_OPTIONS: { value: AgentSortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'seen', label: 'Recently seen' },
  { value: 'created', label: 'Newest' },
  { value: 'budget', label: 'Largest budget' },
]

export const EMPTY_FILTER_STATE: AgentListFilterState = { q: '', facets: {}, sort: DEFAULT_SORT }

// ── Built-in facets ────────────────────────────────────────────────────────

export const STATUS_FACET: AgentFacet = {
  id: 'status',
  label: 'Status',
  match: 'any',
  options: [
    { value: 'active', label: 'Active' },
    { value: 'paused', label: 'Paused' },
    { value: 'pending_approval', label: 'Pending approval' },
    { value: 'revoked', label: 'Revoked' },
  ],
  predicate: (agent, value) => agent.status === value,
}

export type BudgetState = 'recurring' | 'one_time' | 'none'

/** What the row can say about its budget from `allowances` alone. */
export function budgetStateOf(agent: Pick<Agent, 'allowances'>): BudgetState {
  const allowances = agent.allowances ?? []
  if (allowances.length === 0) return 'none'
  return allowances.some((a) => Number(a.reset_period_min) > 0) ? 'recurring' : 'one_time'
}

export const BUDGET_FACET: AgentFacet = {
  id: 'budget',
  label: 'Budget',
  match: 'any',
  options: [
    { value: 'recurring', label: 'Recurring budget' },
    { value: 'one_time', label: 'One-time budget' },
    { value: 'none', label: 'No budget' },
  ],
  predicate: (agent, value) => budgetStateOf(agent) === value,
}

export const BUILT_IN_FACETS: AgentFacet[] = [STATUS_FACET, BUDGET_FACET]

// ── Search ─────────────────────────────────────────────────────────────────

/** Case-insensitive substring over name, description and delegate address. */
export function matchesSearch(agent: Agent, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const haystack = [agent.name, agent.description ?? '', agent.delegate_address ?? '']
  return haystack.some((field) => field.toLowerCase().includes(needle))
}

// ── Sort ───────────────────────────────────────────────────────────────────

function time(value: string | null | undefined): number {
  const t = value ? Date.parse(value) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * The largest single allowance, in the token's HUMAN units. Amounts across
 * tokens are not comparable in fiat here (the row carries no price), so the
 * sort is by the largest number the user typed — good enough to bring the
 * big budgets to the top, and honest about being unit-blind.
 */
export function largestAllowance(agent: Pick<Agent, 'allowances'>): number {
  return (agent.allowances ?? []).reduce((max, a) => {
    const n = Number(a.allowance_amount)
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
}

export function compareAgents(sort: AgentSortKey): (a: Agent, b: Agent) => number {
  switch (sort) {
    case 'seen':
      return (a, b) => time(b.mcp_last_seen_at) - time(a.mcp_last_seen_at) || a.name.localeCompare(b.name)
    case 'created':
      return (a, b) => time(b.created_at) - time(a.created_at) || a.name.localeCompare(b.name)
    case 'budget':
      return (a, b) => largestAllowance(b) - largestAllowance(a) || a.name.localeCompare(b.name)
    case 'name':
    default:
      return (a, b) => a.name.localeCompare(b.name)
  }
}

// ── Apply ──────────────────────────────────────────────────────────────────

export function facetMatches(facet: AgentFacet, agent: Agent, selected: string[]): boolean {
  if (selected.length === 0) return true
  return facet.match === 'all'
    ? selected.every((value) => facet.predicate(agent, value))
    : selected.some((value) => facet.predicate(agent, value))
}

export function applyAgentListFilters(
  agents: Agent[],
  state: AgentListFilterState,
  facets: AgentFacet[],
): Agent[] {
  const out = agents.filter(
    (agent) =>
      matchesSearch(agent, state.q) &&
      facets.every((facet) => facetMatches(facet, agent, state.facets[facet.id] ?? [])),
  )
  return out.sort(compareAgents(state.sort))
}

/**
 * Per-option counts over the list with THIS facet's own selection removed
 * (the usual faceted-search convention: the count answers "how many would I
 * see if I picked this", not "how many match everything including this
 * facet"). Search and the other facets still apply.
 */
export function facetCounts(
  agents: Agent[],
  state: AgentListFilterState,
  facets: AgentFacet[],
): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {}
  for (const facet of facets) {
    const others = facets.filter((f) => f.id !== facet.id)
    const base = agents.filter(
      (agent) =>
        matchesSearch(agent, state.q) &&
        others.every((f) => facetMatches(f, agent, state.facets[f.id] ?? [])),
    )
    counts[facet.id] = {}
    for (const option of facet.options) {
      counts[facet.id][option.value] = base.filter((agent) => facet.predicate(agent, option.value)).length
    }
  }
  return counts
}

export function isFilterActive(state: AgentListFilterState): boolean {
  return state.q.trim() !== '' || Object.values(state.facets).some((v) => v.length > 0)
}

// ── URL codec ──────────────────────────────────────────────────────────────

const RESERVED = new Set(['q', 'sort'])

/**
 * `?q=research&status=active,paused&budget=none&sort=seen`. Unknown facet
 * keys and unknown option values are dropped on read, so a stale link never
 * silently filters on a facet that no longer exists. Other query parameters
 * on the page (`setup`, #352/#2522) are left alone by `writeFilterState`.
 */
export function readFilterState(search: URLSearchParams, facets: AgentFacet[]): AgentListFilterState {
  const q = search.get('q') ?? ''
  const sortRaw = search.get('sort')
  const sort = SORT_OPTIONS.some((o) => o.value === sortRaw) ? (sortRaw as AgentSortKey) : DEFAULT_SORT
  const out: Record<string, string[]> = {}
  for (const facet of facets) {
    if (RESERVED.has(facet.id)) continue
    const raw = search.get(facet.id)
    if (!raw) continue
    const allowed = new Set(facet.options.map((o) => o.value))
    const values = raw.split(',').filter((v) => allowed.has(v))
    if (values.length > 0) out[facet.id] = values
  }
  return { q, facets: out, sort }
}

export function writeFilterState(
  search: URLSearchParams,
  state: AgentListFilterState,
  facets: AgentFacet[],
): URLSearchParams {
  const next = new URLSearchParams(search)
  if (state.q.trim()) next.set('q', state.q.trim())
  else next.delete('q')
  if (state.sort !== DEFAULT_SORT) next.set('sort', state.sort)
  else next.delete('sort')
  for (const facet of facets) {
    if (RESERVED.has(facet.id)) continue
    const values = state.facets[facet.id] ?? []
    if (values.length > 0) next.set(facet.id, values.join(','))
    else next.delete(facet.id)
  }
  return next
}
