import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentRow, agentBadge, type DashboardAgent } from '../AgentRow'
import { computeAttentionItems, type DashboardOverview } from '@/lib/dashboard-attention'

const AGENT: DashboardAgent = {
  id: 'agent-1',
  name: 'Research agent',
  status: 'active',
  accountId: 'account-1',
  accountName: 'Main account',
  accountChainId: 8453, budgetEndedAt: null,
  allowances: [],
  budgets: [],
  receivedSubBudgets: [],
  stats: {
    d7: {
      gross: { usd: 0, eur: 0, sek: 0 },
      net: { usd: 0, eur: 0, sek: 0 },
      approx: false,
      payments: 0,
      refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 },
    },
    d30: {
      gross: { usd: 0, eur: 0, sek: 0 },
      net: { usd: 0, eur: 0, sek: 0 },
      approx: false,
      payments: 0,
      refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 },
    },
    lastPaymentAt: null,
    lastCounterparty: null,
  },
}

describe('AgentRow', () => {
  it('uses the agent monogram as its direct, decorative 32px leading mark', () => {
    render(
      <AgentRow
        agent={AGENT}
        budgetRemaining={null}
        attentionItems={[]}
        accountNames={{}}
        accountCount={1}
        nowMs={Date.parse('2026-10-21T12:00:00Z')}
      />,
    )

    const row = screen.getByRole('link', {
      name: 'Research agent No budget No payments yet',
    })
    const mark = row.firstElementChild

    expect(mark).not.toBeNull()
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).toHaveClass('h-8', 'w-8')
    expect(mark).toHaveTextContent('RA')
  })
})

// ── #4324: acknowledging a budget item leaves the "N% used" badge alone ──────
// The dashboard row (`AgentsSection`), the account tab and `/agents`
// (`AgentCard`) all read `agentBadge`, and the badge reads the budget read,
// not the items — so an acknowledgement, which only filters items, is a
// status change for the CARD and none for the badge.
describe('agentBadge — budget ended (#4353)', () => {
  const agent = { id: 'a1', name: 'Scout', status: 'active', budgets: [] } as unknown as Parameters<typeof agentBadge>[0]
  it('says "Budget ended" while the ended item shows, and nothing once it is acknowledged', () => {
    const item = { id: 'budget-reached:a1', kind: 'budget-ended', tone: 'neutral', title: 't', agentId: 'a1' } as const
    expect(agentBadge(agent, [item], null)).toEqual({ label: 'Budget ended', tone: 'neutral' })
    expect(agentBadge(agent, [], null)).toBeNull()
  })
})

describe('agentBadge after an acknowledgement (#4324)', () => {
  const stopped: DashboardAgent = {
    ...AGENT,
    budgets: [{ budgetAtomic: '1000000' }] as never,
    stats: {
      ...AGENT.stats,
      d7: { ...AGENT.stats.d7, refusals: { budget: 1, expired: 0, scope: 0, failed: 0, haven: 0, lastBudgetAt: '2026-10-20T10:00:00.000Z' } },
    },
  }
  const reads = {
    budgets: [
      {
        agent_id: 'agent-1',
        chain_id: 8453,
        delegation_hash: '0xhash',
        token_address: '0xtoken',
        token_symbol: 'USDC',
        token_decimals: 6,
        budget_atomic: '1000000',
        read_at: '2026-10-20T00:00:00Z',
        period_end: '2026-10-21T00:00:00Z',
        remaining_atomic: '50000',
        remaining_from_chain: true,
        used_atomic: '950000',
        sub_budget_spend: [],
      },
    ],
  } as unknown as Parameters<typeof agentBadge>[2]
  const overview = { agents: [stopped], accounts: [], spend: { failedIntents7d: 0 } } as unknown as DashboardOverview

  it('reads "95% used" with and without both budget items acknowledged', () => {
    const unacknowledged = computeAttentionItems({ overview, budgetRemaining: reads })
    const acknowledged = computeAttentionItems({
      overview,
      budgetRemaining: reads,
      acknowledgements: new Map([
        ['budget-reached:agent-1', { acknowledgedAt: '2026-10-20T11:00:00.000Z', acknowledgedPeriodEnd: null }],
        ['budget-usage:agent-1', { acknowledgedAt: '2026-10-20T11:00:00.000Z', acknowledgedPeriodEnd: '2026-10-21T00:00:00Z' }],
      ]),
    })
    // The card changed: both budget items are hidden.
    expect(unacknowledged.map((item) => item.kind)).toContain('budget-reached')
    expect(acknowledged.filter((item) => item.agentId === 'agent-1')).toEqual([])
    // The badge did not.
    expect(agentBadge(stopped, unacknowledged, reads)).toEqual({ label: '95% used', tone: 'neutral' })
    expect(agentBadge(stopped, acknowledged, reads)).toEqual({ label: '95% used', tone: 'neutral' })
  })
})
