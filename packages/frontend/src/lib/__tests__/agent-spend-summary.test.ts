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
    const line = agentSpendSummaryLine(agents, 'SEK', { USDC: 9.5, ETH: 18_000 })
    expect(line).toBe(
      `2 agents can spend up to ${formatFiat(227.5, 'SEK')} per day from this account.`,
    )
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
