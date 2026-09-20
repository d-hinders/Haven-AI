import { describe, expect, it } from 'vitest'
import type { Agent } from '@/hooks/useAgents'
import {
  BUDGET_FACET,
  BUILT_IN_FACETS,
  DEFAULT_SORT,
  EMPTY_FILTER_STATE,
  STATUS_FACET,
  applyAgentListFilters,
  budgetStateOf,
  compareAgents,
  facetCounts,
  isFilterActive,
  largestAllowance,
  matchesSearch,
  readFilterState,
  writeFilterState,
  type AgentFacet,
} from '@/lib/agent-list-filters'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? overrides.name ?? 'a',
    name: 'Research agent',
    description: null,
    delegate_address: '0xabc0000000000000000000000000000000000001',
    account_id: null,
    account_address: null,
    account_name: null,
    account_chain_id: 84532,
    api_key_prefix: null,
    status: 'active',
    created_at: '2026-09-01T00:00:00Z',
    allowances: [],
    ...overrides,
  } as Agent
}

const allowance = (amount: string, reset = 1440) => ({
  id: `al-${amount}`,
  agent_id: 'a',
  token_address: '0x0',
  token_symbol: 'USDC',
  allowance_amount: amount,
  reset_period_min: reset,
})

const alpha = agent({ id: '1', name: 'Alpha', status: 'active', allowances: [allowance('25')], mcp_last_seen_at: '2026-09-19T10:00:00Z', created_at: '2026-09-02T00:00:00Z' })
const bravo = agent({ id: '2', name: 'Bravo', status: 'paused', description: 'Handles invoices', allowances: [allowance('100', 0)], mcp_last_seen_at: '2026-09-20T10:00:00Z', created_at: '2026-09-01T00:00:00Z' })
const charlie = agent({ id: '3', name: 'charlie', status: 'revoked', delegate_address: '0xDEADbeef00000000000000000000000000000002', created_at: '2026-09-03T00:00:00Z' })
const ALL = [charlie, bravo, alpha]

describe('search', () => {
  it('matches name, description and delegate address, case-insensitively', () => {
    expect(matchesSearch(alpha, 'ALPHA')).toBe(true)
    expect(matchesSearch(bravo, 'invoice')).toBe(true)
    expect(matchesSearch(charlie, 'deadbeef')).toBe(true)
    expect(matchesSearch(alpha, 'invoice')).toBe(false)
  })
  it('blank search matches everything', () => {
    expect(matchesSearch(alpha, '   ')).toBe(true)
  })
})

describe('budget state, derived from allowances alone', () => {
  it('none / one_time / recurring', () => {
    expect(budgetStateOf(charlie)).toBe('none')
    expect(budgetStateOf(bravo)).toBe('one_time')
    expect(budgetStateOf(alpha)).toBe('recurring')
  })
  it('a mixed set is recurring if any allowance resets', () => {
    expect(budgetStateOf(agent({ allowances: [allowance('1', 0), allowance('2', 10080)] }))).toBe('recurring')
  })
  it('does not offer states the row cannot prove (exhausted, near limit, pending signature)', () => {
    // A facet option that could never match would read as "no agent is near
    // its limit" — a false zero. The options are exactly the three derivable ones.
    expect(BUDGET_FACET.options.map((o) => o.value)).toEqual(['recurring', 'one_time', 'none'])
  })
})

describe('sort', () => {
  it('name is locale-aware and case-insensitive', () => {
    expect([...ALL].sort(compareAgents('name')).map((a) => a.name)).toEqual(['Alpha', 'Bravo', 'charlie'])
  })
  it('seen: most recent first, never-seen last, ties by name', () => {
    expect([...ALL].sort(compareAgents('seen')).map((a) => a.name)).toEqual(['Bravo', 'Alpha', 'charlie'])
  })
  it('created: newest first', () => {
    expect([...ALL].sort(compareAgents('created')).map((a) => a.name)).toEqual(['charlie', 'Alpha', 'Bravo'])
  })
  it('budget: largest single allowance first, no budget last', () => {
    expect(largestAllowance(bravo)).toBe(100)
    expect(largestAllowance(charlie)).toBe(0)
    expect([...ALL].sort(compareAgents('budget')).map((a) => a.name)).toEqual(['Bravo', 'Alpha', 'charlie'])
  })
  it('a non-numeric allowance amount does not poison the sort', () => {
    expect(largestAllowance(agent({ allowances: [allowance('abc'), allowance('3')] }))).toBe(3)
  })
})

describe('apply', () => {
  it('no filter: every agent, sorted by the default key', () => {
    expect(applyAgentListFilters(ALL, EMPTY_FILTER_STATE, BUILT_IN_FACETS).map((a) => a.name)).toEqual(['Alpha', 'Bravo', 'charlie'])
  })
  it('status facet is OR within the facet', () => {
    const state = { ...EMPTY_FILTER_STATE, facets: { status: ['active', 'paused'] } }
    expect(applyAgentListFilters(ALL, state, BUILT_IN_FACETS).map((a) => a.name)).toEqual(['Alpha', 'Bravo'])
  })
  it('facets are AND across facets, and search applies too', () => {
    const state = { ...EMPTY_FILTER_STATE, q: 'a', facets: { status: ['active', 'paused'], budget: ['one_time'] } }
    expect(applyAgentListFilters(ALL, state, BUILT_IN_FACETS).map((a) => a.name)).toEqual(['Bravo'])
  })
  it('does not mutate the input array', () => {
    const input = [...ALL]
    applyAgentListFilters(input, EMPTY_FILTER_STATE, BUILT_IN_FACETS)
    expect(input.map((a) => a.name)).toEqual(['charlie', 'Bravo', 'Alpha'])
  })
})

describe('the facet extension point', () => {
  const labelsFacet: AgentFacet = {
    id: 'label',
    label: 'Label',
    match: 'all',
    options: [
      { value: 'prod', label: 'prod' },
      { value: 'eu', label: 'eu' },
    ],
    predicate: (a, value) => ((a as unknown as { labels?: string[] }).labels ?? []).includes(value),
  }
  const tagged = agent({ id: '9', name: 'Tagged', ...({ labels: ['prod', 'eu'] } as object) })
  const half = agent({ id: '8', name: 'Half', ...({ labels: ['prod'] } as object) })

  it('a registered facet with match=all requires every selected value', () => {
    const facets = [...BUILT_IN_FACETS, labelsFacet]
    const state = { ...EMPTY_FILTER_STATE, facets: { label: ['prod', 'eu'] } }
    expect(applyAgentListFilters([tagged, half, alpha], state, facets).map((a) => a.name)).toEqual(['Tagged'])
  })
  it('the same facet with match=any takes either value', () => {
    const facets = [...BUILT_IN_FACETS, { ...labelsFacet, match: 'any' as const }]
    const state = { ...EMPTY_FILTER_STATE, facets: { label: ['prod', 'eu'] } }
    expect(applyAgentListFilters([tagged, half, alpha], state, facets).map((a) => a.name)).toEqual(['Half', 'Tagged'])
  })
  it('the URL codec and the counts pick the facet up by id', () => {
    const facets = [...BUILT_IN_FACETS, labelsFacet]
    const params = writeFilterState(new URLSearchParams(), { ...EMPTY_FILTER_STATE, facets: { label: ['eu'] } }, facets)
    expect(params.get('label')).toBe('eu')
    const counts = facetCounts([tagged, half, alpha], EMPTY_FILTER_STATE, facets)
    expect(counts.label).toEqual({ prod: 2, eu: 1 })
  })
})

describe('counts', () => {
  it("a facet's own selection is excluded from its counts; search and other facets apply", () => {
    const state = { ...EMPTY_FILTER_STATE, facets: { status: ['revoked'] } }
    const counts = facetCounts(ALL, state, BUILT_IN_FACETS)
    // status counts ignore the status selection…
    expect(counts.status).toEqual({ active: 1, paused: 1, pending_approval: 0, revoked: 1 })
    // …budget counts honour it (only charlie is revoked, and charlie has no budget)
    expect(counts.budget).toEqual({ recurring: 0, one_time: 0, none: 1 })
  })
})

describe('URL codec', () => {
  it('round-trips q, facets and a non-default sort; drops defaults', () => {
    const state = { q: 'inv', facets: { status: ['paused', 'active'], budget: [] }, sort: 'seen' as const }
    const params = writeFilterState(new URLSearchParams('setup=first'), state, BUILT_IN_FACETS)
    expect(params.toString()).toBe('setup=first&q=inv&sort=seen&status=paused%2Cactive')
    expect(readFilterState(params, BUILT_IN_FACETS)).toEqual({ q: 'inv', facets: { status: ['paused', 'active'] }, sort: 'seen' })
  })
  it('preserves unrelated parameters and removes cleared keys', () => {
    const params = writeFilterState(new URLSearchParams('setup=first&status=active&q=x'), EMPTY_FILTER_STATE, BUILT_IN_FACETS)
    expect(params.toString()).toBe('setup=first')
  })
  it('drops unknown facet values, unknown sort keys and unknown facet keys on read', () => {
    const state = readFilterState(new URLSearchParams('status=active,bogus&sort=bogus&colour=red'), BUILT_IN_FACETS)
    expect(state).toEqual({ q: '', facets: { status: ['active'] }, sort: DEFAULT_SORT })
  })
  it('a facet whose every value is unknown is absent, not an empty array', () => {
    expect(readFilterState(new URLSearchParams('status=bogus'), BUILT_IN_FACETS).facets).toEqual({})
  })
  it('a facet id may not shadow q or sort', () => {
    const rogue: AgentFacet = { id: 'q', label: 'Rogue', match: 'any', options: [{ value: 'x', label: 'x' }], predicate: () => true }
    const params = writeFilterState(new URLSearchParams(), { ...EMPTY_FILTER_STATE, q: 'real', facets: { q: ['x'] } }, [rogue])
    expect(params.get('q')).toBe('real')
  })
})

describe('isFilterActive', () => {
  it('sort alone is not a filter', () => {
    expect(isFilterActive({ ...EMPTY_FILTER_STATE, sort: 'seen' })).toBe(false)
    expect(isFilterActive({ ...EMPTY_FILTER_STATE, q: ' ' })).toBe(false)
    expect(isFilterActive({ ...EMPTY_FILTER_STATE, facets: { status: ['active'] } })).toBe(true)
  })
  it('STATUS_FACET covers every status the wire type declares', () => {
    expect(STATUS_FACET.options.map((o) => o.value).sort()).toEqual(['active', 'paused', 'pending_approval', 'revoked'])
  })
})
