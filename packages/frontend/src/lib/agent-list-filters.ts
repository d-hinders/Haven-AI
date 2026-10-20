import type { Agent } from '@/hooks/useAgents'
import type { SmartAccount } from '@/context/AuthContext'
import { accountWithChainLabel } from '@/lib/account-label'
import { hasConfiguredAllowances, receivedBudgetLine } from '@/lib/agent-budget'
import type { ListFacet } from '@/components/ui/FacetMenu'
import { sameValues, type ListState, type ListUrlSchema } from '@/components/ui/list-url-codec'

/**
 * Search, facets and sort for the `/agents` list (#3165).
 *
 * Everything here is pure: a facet is DATA — an id, its options, a predicate
 * over the agent row, a match mode — so a later surface registers a facet
 * (labels from #3167, organizations from #3164) without editing the hook or
 * the toolbar. The built-in facets are the two the row already carries at
 * this head: status and budget state.
 *
 * Budget state (#3988) comes from the shared `lib/agent-budget.ts` helper —
 * the agent's own `allowances` (zero-capped = none) PLUS its
 * `receivedSubBudgets` (the server's qualifying-chain verdict). "Exhausted",
 * "near limit" and "pending signature" (the issue names them) need a
 * per-agent remaining figure or a setup state the row does not carry, so
 * they are NOT offered as options: a facet that silently matched nothing
 * would read as "no agent is near its limit", which is the false zero this
 * codebase keeps meeting. They arrive with a server field; see the PR body
 * for the note the issue asks for.
 *
 * The #3988 builder decision for a grant holder: its OWN facet value
 * `received` ("Received budget") — `recurring`/`one_time` describe the
 * agent's own cap, which a holder may not have, and the row carries no
 * grant amount to classify it by. The existing `none` value keeps its name,
 * so saved `?budget=none` links still parse.
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
  /**
   * How `ListToolbar` offers it (#4113). Omitted: `multi` — every facet the
   * list shipped with under #3165 is multi-select.
   */
  selection?: 'single' | 'multi'
  /** The value when the URL says nothing. Omitted: `[]`, every agent. */
  defaultValue?: readonly string[]
  /** The pattern's `allLabel`: `null` for a facet with no "All" row. */
  allLabel?: string | null
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

export type BudgetState = 'recurring' | 'one_time' | 'received' | 'none'

/**
 * What the row can say about its budget (#3988): the agent's own allowance
 * caps through the shared helper's zero-cap rule, then the server's
 * qualifying-chain verdict on its received grants. A grant holder is never
 * classified `'none'` — "No budget" was the bug this file fed.
 */
export function budgetStateOf(
  agent: Pick<Agent, 'allowances' | 'receivedSubBudgets'>,
): BudgetState {
  if (hasConfiguredAllowances(agent)) {
    return (agent.allowances ?? []).some((a) => Number(a.reset_period_min) > 0)
      ? 'recurring'
      : 'one_time'
  }
  return receivedBudgetLine(agent.receivedSubBudgets) !== null ? 'received' : 'none'
}

export const BUDGET_FACET: AgentFacet = {
  id: 'budget',
  label: 'Budget',
  match: 'any',
  options: [
    { value: 'recurring', label: 'Recurring budget' },
    { value: 'one_time', label: 'One-time budget' },
    { value: 'received', label: 'Received budget' },
    { value: 'none', label: 'No budget' },
  ],
  predicate: (agent, value) => budgetStateOf(agent) === value,
}

export const BUILT_IN_FACETS: AgentFacet[] = [STATUS_FACET, BUDGET_FACET]

/**
 * Archived (#4113, owner decision 2026-10-20): archived agents —
 * `archived_at` set, #1402's "Removed" — are hidden by default and shown on
 * request, in the toolbar instead of a disclosure below the list. A separate
 * axis from Status: a revoked agent that is NOT archived is listed under
 * Hidden and matched by "Status: Revoked"; an archived one needs "Shown".
 * Single-select with no "All" row, because "Shown" already means all.
 */
export const ARCHIVED_FACET: AgentFacet = {
  id: 'archived',
  label: 'Archived',
  match: 'any',
  selection: 'single',
  defaultValue: ['hidden'],
  allLabel: null,
  options: [
    { value: 'hidden', label: 'Hidden' },
    { value: 'shown', label: 'Shown' },
  ],
  predicate: (agent, value) => value === 'shown' || !agent.archived_at,
}

/** True when the archived facet hides archived agents, its default. */
export function archivedHidden(state: Pick<AgentListFilterState, 'facets'>): boolean {
  return (state.facets[ARCHIVED_FACET.id] ?? ARCHIVED_FACET.defaultValue ?? []).includes('hidden')
}

/**
 * Account facet (#3719). The list shows every agent on every account — there
 * is no global active account narrowing it — so a user with several accounts
 * filters here instead. Registered by the surface only when there is more than
 * one account; with one, the facet would be a single always-true option.
 * Each option names the account with its chain as the secondary half.
 */
export function accountFacet(accounts: readonly SmartAccount[]): AgentFacet {
  return {
    id: 'account',
    label: 'Account',
    match: 'any',
    options: accounts.map((account) => ({ value: account.id, label: accountWithChainLabel(account) })),
    predicate: (agent, value) => agent.account_id === value,
  }
}

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
 *
 * #3988: a received-grant holder ranks by `hasBudgetTieBreak` in the sort
 * below, not here — the row carries no grant amount, so its number stays 0
 * rather than an invented positive.
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
      // #3988: equal amounts fall to the shared helper's "has a budget"
      // answer — a received-grant holder (whose amount the row does not
      // carry) ranks above a zero-capped or budgetless agent instead of
      // tying at 0.
      return (a, b) =>
        largestAllowance(b) - largestAllowance(a) ||
        Number(hasConfiguredAllowances(b) || receivedBudgetLine(b.receivedSubBudgets) !== null) -
          Number(hasConfiguredAllowances(a) || receivedBudgetLine(a.receivedSubBudgets) !== null) ||
        a.name.localeCompare(b.name)
    case 'name':
    default:
      return (a, b) => a.name.localeCompare(b.name)
  }
}

// ── Apply ──────────────────────────────────────────────────────────────────

/** A facet's selection; a facet the state does not name is at its default. */
function selectionOf(facet: AgentFacet, state: AgentListFilterState): string[] {
  return state.facets[facet.id] ?? [...(facet.defaultValue ?? [])]
}

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
      facets.every((facet) => facetMatches(facet, agent, selectionOf(facet, state))),
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
        others.every((f) => facetMatches(f, agent, selectionOf(f, state))),
    )
    counts[facet.id] = {}
    for (const option of facet.options) {
      counts[facet.id][option.value] = base.filter((agent) => facet.predicate(agent, option.value)).length
    }
  }
  return counts
}

/** Search or any facet away from its default. Sort is a view choice, never a filter. */
export function isFilterActive(state: AgentListFilterState, facets: AgentFacet[]): boolean {
  return (
    state.q.trim() !== '' ||
    facets.some((facet) => !sameValues(selectionOf(facet, state), facet.defaultValue ?? []))
  )
}

// ── The list-controls pattern (#4113) ──────────────────────────────────────

const RESERVED = new Set(['q', 'sort'])

/**
 * The facet ids the Agents URL always knows, whether or not their facet is
 * registered yet. Account and Organization register only once their options
 * load, so a shared `?organization=<id>` link must parse before that.
 */
export const AGENT_LIST_FACET_IDS = ['status', 'budget', 'account', 'organization', 'archived'] as const

/**
 * The `/agents` URL through the list-controls codec (`list-url-codec.ts`).
 * The keys #3165 shipped keep their names and formats — `q`, `sort`, one
 * key per facet id, multi-values comma-joined — and keys the codec does not
 * own (`setup`, #352/#2522) are left alone. A facet with fixed options lists
 * its `values`, so a stale link drops what no longer exists; one whose
 * options load late (Account, Organization, a registered extension) does not.
 * A facet id may not shadow `q` or `sort`.
 */
export function agentListUrlSchema(facets: readonly AgentFacet[]): ListUrlSchema {
  const byId = new Map(facets.map((facet) => [facet.id, facet]))
  const fixed = new Map<string, AgentFacet>([
    [STATUS_FACET.id, STATUS_FACET],
    [BUDGET_FACET.id, BUDGET_FACET],
    [ARCHIVED_FACET.id, ARCHIVED_FACET],
  ])
  const ids = [...new Set<string>([...AGENT_LIST_FACET_IDS, ...byId.keys()])].filter((id) => !RESERVED.has(id))
  return {
    facets: ids.map((id) => {
      const facet = fixed.get(id) ?? byId.get(id)
      return {
        id,
        selection: facet?.selection ?? 'multi',
        defaultValue: facet?.defaultValue,
        allLabel: facet?.allLabel,
        values: fixed.has(id) ? facet?.options.map((o) => o.value) : undefined,
      }
    }),
    sort: { values: SORT_OPTIONS.map((o) => o.value), defaultValue: DEFAULT_SORT },
  }
}

/** The codec's state as the filter functions above read it. */
export function toAgentFilterState(state: ListState): AgentListFilterState {
  const sort = SORT_OPTIONS.some((o) => o.value === state.sort) ? (state.sort as AgentSortKey) : DEFAULT_SORT
  return { q: state.q, facets: state.facets, sort }
}

/**
 * A registered facet as `ListToolbar` draws it. Multi-select rows carry the
 * faceted counts; a single-select facet's rows do not (the pattern draws
 * counts on multi-select rows only).
 */
export function toListFacet(facet: AgentFacet, counts: Record<string, number> | undefined): ListFacet {
  const selection = facet.selection ?? 'multi'
  return {
    id: facet.id,
    label: facet.label,
    selection,
    defaultValue: facet.defaultValue,
    allLabel: facet.allLabel,
    options: facet.options.map((option) => ({
      value: option.value,
      label: option.label,
      count: selection === 'multi' ? counts?.[option.value] ?? 0 : undefined,
    })),
  }
}
