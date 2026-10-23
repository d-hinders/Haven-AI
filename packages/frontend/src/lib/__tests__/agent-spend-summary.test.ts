/**
 * #4097 — the Agents tab's budget snapshot line, over
 * `lib/agent-spend-summary.ts`: the shared-period total in token units, the
 * mixed-period fallback ("5 agents with budgets"), the no-budget framing,
 * mixed tokens summed through the #3803 spot rates, and a missing rate never
 * producing a guessed figure.
 */
import { describe, expect, it } from 'vitest'
import { agentSpendSummaryLine } from '../agent-spend-summary'
import { formatFiat } from '@/lib/format'
import type { DashboardAgent } from '@/components/haven'

function budgetAgent(
  overrides: Partial<DashboardAgent> & { budgets?: DashboardAgent['budgets'] },
): DashboardAgent {
  return {
    id: 'agent-1',
    name: 'Research agent',
    status: 'active',
    accountId: 'safe-1',
    budgets: [
      {
        id: 'budget-1',
        delegationHash: '0xabc',
        chainId: 8453,
        tokenAddress: '0x' + 'aa'.repeat(20),
        tokenSymbol: 'USDC',
        decimals: 6,
        budgetAtomic: '5000000', // 5 USDC per day
        periodSeconds: 86_400,
        startDate: '2026-10-01T00:00:00Z',
        expiresAt: '2026-11-01T00:00:00Z',
        periodEnd: '2026-10-20T00:00:00Z',
      },
    ],
    ...overrides,
  } as DashboardAgent
}

describe('agentSpendSummaryLine (#4097)', () => {
  it('a shared daily period sums the caps in token units', () => {
    // Two agents, 5 + 22.01 USDC per day each.
    const agents = [
      budgetAgent({}),
      budgetAgent({
        id: 'agent-2',
        budgets: [
          {
            id: 'budget-2',
            delegationHash: '0xdef',
            chainId: 8453,
            tokenAddress: '0x' + 'aa'.repeat(20),
            tokenSymbol: 'USDC',
            decimals: 6,
            budgetAtomic: '22010000',
            periodSeconds: 86_400,
            startDate: '2026-10-01T00:00:00Z',
            expiresAt: '2026-11-01T00:00:00Z',
            periodEnd: '2026-10-20T00:00:00Z',
          },
        ],
      }),
    ]
    expect(agentSpendSummaryLine(agents, 'USD', undefined)).toBe(
      '2 agents can spend up to 27.01 USDC per day from this account.',
    )
  })

  it('mixed periods fall back to the count ("5 agents with budgets")', () => {
    const agents = [
      budgetAgent({}),
      budgetAgent({
        id: 'agent-2',
        budgets: [
          {
            id: 'budget-2',
            delegationHash: '0xdef',
            chainId: 8453,
            tokenAddress: '0x' + 'aa'.repeat(20),
            tokenSymbol: 'USDC',
            decimals: 6,
            budgetAtomic: '10000000',
            periodSeconds: 604_800, // a week, not a day
            startDate: '2026-10-01T00:00:00Z',
            expiresAt: '2026-11-01T00:00:00Z',
            periodEnd: '2026-10-20T00:00:00Z',
          },
        ],
      }),
    ]
    expect(agentSpendSummaryLine(agents, 'USD', undefined)).toBe('2 agents with budgets.')
  })

  it('agents with no budgets keep the request-payment framing', () => {
    const agents = [
      budgetAgent({ id: 'agent-1', budgets: [] }),
      budgetAgent({ id: 'agent-2', budgets: [] }),
    ]
    expect(agentSpendSummaryLine(agents, 'USD', undefined)).toBe(
      '2 agents can request payments from this account.',
    )
  })

  it('mixed tokens sum through the #3803 spot rates in the display currency', () => {
    const agents = [
      budgetAgent({}), // 5 USDC/day
      budgetAgent({
        id: 'agent-2',
        budgets: [
          {
            id: 'budget-2',
            delegationHash: '0xdef',
            chainId: 8453,
            tokenAddress: '0x' + 'bb'.repeat(20),
            tokenSymbol: 'ETH',
            decimals: 18,
            budgetAtomic: '10000000000000000', // 0.01 ETH per day
            periodSeconds: 86_400,
            startDate: '2026-10-01T00:00:00Z',
            expiresAt: '2026-11-01T00:00:00Z',
            periodEnd: '2026-10-20T00:00:00Z',
          },
        ],
      }),
    ]
    // 5 USDC at 9.5 kr + 0.01 ETH at 18 000 kr = 47.50 + 180 = 227.50 kr.
    // #4288: a mixed-token line always includes a floating token, and this
    // is a converted total — the line carries the "≈" mark.
    const line = agentSpendSummaryLine(agents, 'SEK', { USDC: 9.5, ETH: 18_000 })
    expect(line).toBe(
      `2 agents can spend up to ≈${formatFiat(227.5, 'SEK')} per day from this account.`,
    )
  })

  it('mixed tokens in USD mark ≈ and price the pegged token at exactly 1.0 — no spot rate needed (#4288)', () => {
    const agents = [
      budgetAgent({}), // 5 USDC/day
      budgetAgent({
        id: 'agent-2',
        budgets: [
          {
            id: 'budget-2',
            delegationHash: '0xdef',
            chainId: 8453,
            tokenAddress: '0x' + 'bb'.repeat(20),
            tokenSymbol: 'ETH',
            decimals: 18,
            budgetAtomic: '10000000000000000', // 0.01 ETH per day
            periodSeconds: 86_400,
            startDate: '2026-10-01T00:00:00Z',
            expiresAt: '2026-11-01T00:00:00Z',
            periodEnd: '2026-10-20T00:00:00Z',
          },
        ],
      }),
    ]
    // USDC in USD is dollars (the peg is a registry fact) — priced at 1.0
    // with NO USDC rate in the map, not at the ≈0.9998 market rate and not
    // a fallback. 0.01 ETH at $3 000 = 30. The ETH budget is the float, so
    // the line carries the mark.
    const line = agentSpendSummaryLine(agents, 'USD', { ETH: 3_000 })
    expect(line).toBe('2 agents can spend up to ≈$35.00 per day from this account.')
  })

  it('the same-token line stays unmarked and in token units (#4288 regression guard)', () => {
    const agents = [budgetAgent({}), budgetAgent({ id: 'agent-2', budgets: undefined })]
    const line = agentSpendSummaryLine(agents, 'USD', { USDC: 0.9998 })
    expect(line).toBe('2 agents can spend up to 5.00 USDC per day from this account.')
  })

  it('a missing spot rate never produces a guessed figure', () => {
    const agents = [
      budgetAgent({}), // USDC
      budgetAgent({
        id: 'agent-2',
        budgets: [
          {
            id: 'budget-2',
            delegationHash: '0xdef',
            chainId: 8453,
            tokenAddress: '0x' + 'bb'.repeat(20),
            tokenSymbol: 'ETH',
            decimals: 18,
            budgetAtomic: '10000000000000000',
            periodSeconds: 86_400,
            startDate: '2026-10-01T00:00:00Z',
            expiresAt: '2026-11-01T00:00:00Z',
            periodEnd: '2026-10-20T00:00:00Z',
          },
        ],
      }),
    ]
    // ETH has no rate in the map (a failed #3803 read serves null).
    expect(agentSpendSummaryLine(agents, 'SEK', { USDC: 9.5, ETH: null })).toBe(
      '2 agents with budgets.',
    )
  })

  it('a zero cap is no authority and joins no total (#3802)', () => {
    const agents = [
      budgetAgent({}),
      budgetAgent({
        id: 'agent-2',
        budgets: [
          {
            id: 'budget-2',
            delegationHash: '0xdef',
            chainId: 8453,
            tokenAddress: '0x' + 'aa'.repeat(20),
            tokenSymbol: 'USDC',
            decimals: 6,
            budgetAtomic: '0',
            periodSeconds: 86_400,
            startDate: '2026-10-01T00:00:00Z',
            expiresAt: '2026-11-01T00:00:00Z',
            periodEnd: '2026-10-20T00:00:00Z',
          },
        ],
      }),
    ]
    expect(agentSpendSummaryLine(agents, 'USD', undefined)).toBe(
      '2 agents can spend up to 5.00 USDC per day from this account.',
    )
  })

  it('one agent reads naturally', () => {
    expect(agentSpendSummaryLine([budgetAgent({})], 'USD', undefined)).toBe(
      '1 agent can spend up to 5.00 USDC per day from this account.',
    )
  })
})
