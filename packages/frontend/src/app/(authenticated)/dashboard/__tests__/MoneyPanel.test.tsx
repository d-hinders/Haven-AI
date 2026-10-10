/**
 * MoneyPanel unit tests (#3807). The panel is a pure render of the overview
 * wire, so these pin the money-clarity rules at the component boundary —
 * the headless equivalent of the rendered captures (repo closeout rule:
 * a logic-only change gets a vitest pin, not a screenshot).
 *
 * Round-2 design review (2026-10-09): the spending breakdown must RECONCILE
 * with its own headline. Revoked agents' 30-day spend sits inside
 * `spend.d30.net` but has no agent row on the wire — an unattributed
 * remainder renders as an "Agents since removed" row so the total the card
 * states is never contradicted by its own rows.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import MoneyPanel from '../MoneyPanel'
import type { DashboardAgentPreview, DashboardOverviewResponse } from '@/types/dashboard'

const baseProps = {
  loading: false,
  unavailable: false,
  currency: 'USD' as const,
  totalFiat: 0,
  changeAvailable: false,
  sekChangeUnavailable: false,
  changeUnavailable: false,
  changeAmount: null,
  changePercent: 0,
  hasAccounts: true,
  hasFunds: true,
  fundingStateKnown: true,
  watchingForDeposit: false,
  requiresOtherDevice: false,
  showSpending: true,
  onDepositAddress: vi.fn(),
  onAddFunds: vi.fn(),
}

function agent(id: string, name: string, d30NetUsd: number): DashboardAgentPreview {
  return {
    id,
    name,
    status: 'active',
    accountId: null,
    accountName: null,
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
        net: { usd: d30NetUsd, eur: 0, sek: 0 },
        approx: false,
        payments: 0,
        refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
      },
      lastPaymentAt: null,
      lastCounterparty: null,
    },
  }
}

function overview(overrides: {
  d30NetUsd: number
  d30Approx?: boolean
  agents: DashboardAgentPreview[]
}): DashboardOverviewResponse {
  return {
    totals: { usd: 0, eur: 0 },
    change: {
      available: false,
      usdAmount: 0,
      eurAmount: 0,
      usdPercent: 0,
      eurPercent: 0,
    },
    actionableApprovals: 0,
    pendingApprovals: 0,
    onboardingProgress: { hasFirstAgentPayment: false },
    agents: overrides.agents,
    agentCount: { active: overrides.agents.length, paused: 0, pending_approval: 0 },
    accounts: [],
    spotRates: {},
    spend: {
      scope: 'mainnet',
      d7: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: 0, eur: 0, sek: 0 },
        approx: false,
        payments: 0,
        distinctMerchants: 0,
        budgetStops: 0,
      },
      d30: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: overrides.d30NetUsd, eur: 0, sek: 0 },
        approx: overrides.d30Approx ?? false,
        payments: 0,
        distinctMerchants: 0,
        budgetStops: 0,
      },
      topMerchant7d: null,
      failedIntents7d: 0,
      balance_by_day: [],
    },
  }
}

describe('MoneyPanel — spending breakdown reconciles with the headline (#3807 round-2 review)', () => {
  it('names the unattributed remainder when the total carries spend no row accounts for', () => {
    // Two active agents at 17.485 each (34.97 attributed) against a 51.76
    // total — the 16.79 difference is removed agents' spend.
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 51.76,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    const row = screen.getByText('Agents since removed').closest('div')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('$16.79')
  })

  it('marks the remainder ≈ when the window it is derived from is re-priced', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 51.76,
          d30Approx: true,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    const row = screen.getByText('Agents since removed').closest('div')
    expect(row).toHaveTextContent('\u2248')
  })

  it('renders no remainder row when the agent rows already account for the total', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 34.97,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    expect(screen.queryByText('Agents since removed')).not.toBeInTheDocument()
  })

  it('holds a cent-level remainder back — rounding is not a hidden agent', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 34.971,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    expect(screen.queryByText('Agents since removed')).not.toBeInTheDocument()
  })
})
