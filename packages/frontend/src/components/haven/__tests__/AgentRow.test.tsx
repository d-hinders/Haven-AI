import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentRow, type DashboardAgent } from '../AgentRow'

const AGENT: DashboardAgent = {
  id: 'agent-1',
  name: 'Research agent',
  status: 'active',
  accountId: 'account-1',
  accountName: 'Main account',
  accountChainId: 8453,
  allowances: [],
  budgets: [],
  receivedSubBudgets: [],
  stats: {
    d7: {
      gross: { usd: 0, eur: 0, sek: 0 },
      net: { usd: 0, eur: 0, sek: 0 },
      approx: false,
      payments: 0,
      refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
    },
    d30: {
      gross: { usd: 0, eur: 0, sek: 0 },
      net: { usd: 0, eur: 0, sek: 0 },
      approx: false,
      payments: 0,
      refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
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
