import { describe, expect, it } from 'vitest'
import type { Agent } from '@/hooks/useAgents'
import type { SmartAccount } from '@/context/AuthContext'
import {
  BUDGET_FACET,
  BUILT_IN_FACETS,
  DEFAULT_SORT,
  EMPTY_FILTER_STATE,
  STATUS_FACET,
  accountFacet,
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

describe('budget state, derived from the shared agent-budget helper (#3988)', () => {
  it('none / one_time / recurring', () => {
    expect(budgetStateOf(charlie)).toBe('none')
    expect(budgetStateOf(bravo)).toBe('one_time')
    expect(budgetStateOf(alpha)).toBe('recurring')
  })
  it('a mixed set is recurring if any allowance resets', () => {
    expect(budgetStateOf(agent({ allowances: [allowance('1', 0), allowance('2', 10080)] }))).toBe('recurring')
  })
  it('a ZERO-capped own budget is no authority: it reads none unless a grant is open', () => {
    // #3897's rule, now through the helper: `allowances.length` alone would
    // have classified the zero cap one_time.
    expect(budgetStateOf(agent({ allowances: [allowance('0')] }))).toBe('none')
  })
  it('a grant holder is classified received, never none (#3988)', () => {
    const holder = agent({
      allowances: [],
      receivedSubBudgets: [{ parent_agent_id: 'p', parent_agent_name: 'Agent naming', open: true }],
    } as Partial<Agent>)
    expect(budgetStateOf(holder)).toBe('received')
  })
  it('a NON-qualifying received grant (open: false) is not a budget', () => {
    const stale = agent({
      allowances: [],
      receivedSubBudgets: [{ parent_agent_id: 'p', parent_agent_name: 'Agent naming', open: false }],
    } as Partial<Agent>)
    expect(budgetStateOf(stale)).toBe('none')
  })
  it('own positive budgets win over the received classification', () => {
    const both = agent({
      allowances: [allowance('25')],
      receivedSubBudgets: [{ parent_agent_id: 'p', parent_agent_name: 'Agent naming', open: true }],
    } as Partial<Agent>)
    expect(budgetStateOf(both)).toBe('recurring')
  })
  it('the facet offers the four derivable states; none keeps its name', () => {
    expect(BUDGET_FACET.options.map((o) => o.value)).toEqual(['recurring', 'one_time', 'received', 'none'])
    // #3988: saved `?budget=none` links keep parsing — the value is unchanged.
    expect(
      readFilterState(new URLSearchParams('budget=none'), BUILT_IN_FACETS).facets.budget,
    ).toEqual(['none'])
  })
})

describe('sort', () => {
  it('name is locale-aware and case-insensitive', () => {
    expect([...ALL].sort(compareAgents('name')).map((a) => a.name)).toEqual(['Alpha', 'Bravo', 'charlie'])
  })
  it('seen: most recent first, never-seen last, ties by name', () => {
    expect([...ALL].sort(compareAgents('seen')).map((a) => a.name)).toEqual(['Bravo', 'Alpha', 'charlie'])
    // Two never-seen agents tie on time and fall back to the name (mutation:
    // drop the `localeCompare` tie-break → order becomes insertion order → red).
    const tie = [agent({ id: 'z', name: 'Zed' }), agent({ id: 'y', name: 'Yan' })]
    expect(tie.sort(compareAgents('seen')).map((a) => a.name)).toEqual(['Yan', 'Zed'])
  })
  it('created: newest first', () => {
    expect([...ALL].sort(compareAgents('created')).map((a) => a.name)).toEqual(['charlie', 'Alpha', 'Bravo'])
  })
  it('budget: largest single allowance first, no budget last', () => {
    expect(largestAllowance(bravo)).toBe(100)
    expect(largestAllowance(charlie)).toBe(0)
    expect([...ALL].sort(compareAgents('budget')).map((a) => a.name)).toEqual(['Bravo', 'Alpha', 'charlie'])
  })
  it('budget: a received-grant holder ranks above a zero-capped agent, not tied at 0 (#3988)', () => {
    const holder = agent({ id: 'h', name: 'Holder', allowances: [], receivedSubBudgets: [{ parent_agent_id: 'p', parent_agent_name: 'A', open: true }] } as Partial<Agent>)
    const zeroCap = agent({ id: 'z', name: 'Zerocap', allowances: [allowance('0')] })
    // Both "amount 0"; the holder has authority the zero cap does not.
    expect([...[zeroCap, holder]].sort(compareAgents('budget')).map((a) => a.name)).toEqual(['Holder', 'Zerocap'])
    // A known positive amount still outranks the unknown grant.
    expect([...[holder, alpha]].sort(compareAgents('budget')).map((a) => a.name)).toEqual(['Alpha', 'Holder'])
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
    expect(counts.budget).toEqual({ recurring: 0, one_time: 0, received: 0, none: 1 })
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

describe('accountFacet (#3719)', () => {
  const BASE_ACCOUNT = { id: 'acc-base', name: 'Operating', chain_id: 8453 } as SmartAccount
  const TEST_ACCOUNT = { id: 'acc-test', name: 'Sandbox', chain_id: 84532 } as SmartAccount

  it('offers one option per account, named with its chain as the secondary half', () => {
    const facet = accountFacet([BASE_ACCOUNT, TEST_ACCOUNT])
    expect(facet.id).toBe('account')
    expect(facet.options).toEqual([
      { value: 'acc-base', label: 'Operating · Base' },
      { value: 'acc-test', label: 'Sandbox · Base Sepolia' },
    ])
  })

  it("matches an agent on its own account_id, and nothing without one", () => {
    const facet = accountFacet([BASE_ACCOUNT, TEST_ACCOUNT])
    const onBase = agent({ id: 'a1', account_id: 'acc-base' })
    const onTest = agent({ id: 'a2', account_id: 'acc-test' })
    const unassigned = agent({ id: 'a3', account_id: null })
    expect(facet.predicate(onBase, 'acc-base')).toBe(true)
    expect(facet.predicate(onTest, 'acc-base')).toBe(false)
    expect(facet.predicate(unassigned, 'acc-base')).toBe(false)
  })
})
