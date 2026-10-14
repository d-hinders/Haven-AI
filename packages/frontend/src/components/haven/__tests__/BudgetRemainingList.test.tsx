import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BudgetRemainingList } from '@/components/haven/BudgetRemainingList'
import type { DashboardBudgetRemainingEntry } from '@/components/haven/BudgetRemainingList'

/**
 * The unknown-state contract (#3804): an entry whose read did not come from
 * the chain must not read as a fact. The pre-#3804 wire shapes would render
 * either "0 … left" (analytics' `used_atomic: "0"`) or "<budget> … left"
 * (`?include=remaining`'s full-budget fallback) — both state a number the
 * chain never gave us, and a meter needs a measurement, which unknown isn't.
 */

const KNOWN: DashboardBudgetRemainingEntry = {
  agent_id: '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34',
  chain_id: 84532,
  delegation_hash: `0x${'a'.repeat(64)}`,
  token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  token_symbol: 'USDC',
  token_decimals: 6,
  budget_atomic: '3000000',
  read_at: '2026-10-09T13:00:00.000Z',
  period_end: '2026-10-10T00:00:00.000Z',
  remaining_atomic: '1500000',
  remaining_from_chain: true,
  used_atomic: '1500000',
  sub_budget_spend: [],
}

const UNKNOWN: DashboardBudgetRemainingEntry = {
  ...KNOWN,
  delegation_hash: `0x${'b'.repeat(64)}`,
  read_at: null,
  remaining_from_chain: false,
  remaining_atomic: null,
  used_atomic: null,
}

describe('BudgetRemainingList', () => {
  it('renders a known read with the remaining amount and a meter', () => {
    render(<BudgetRemainingList budgets={[KNOWN]} />)
    expect(screen.getByText('1.5 USDC left')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'USDC budget used' })).toBeInTheDocument()
  })

  it('UNKNOWN: neither "0 … left", nor "<budget> … left", nor a meter renders', () => {
    render(<BudgetRemainingList budgets={[UNKNOWN]} />)

    // Not "0 … left" (the analytics fallback)…
    expect(screen.queryByText('0 USDC left')).not.toBeInTheDocument()
    // …and not the full budget either (the ?include=remaining fallback).
    expect(screen.queryByText('3 USDC left')).not.toBeInTheDocument()
    // No meter — unknown is not a measurement.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    // The unavailability is stated instead.
    expect(screen.getByText('Remaining unavailable')).toBeInTheDocument()
  })

  it('mixed rows keep the known amounts beside the unknown one', () => {
    render(<BudgetRemainingList budgets={[KNOWN, UNKNOWN]} />)
    expect(screen.getByText('1.5 USDC left')).toBeInTheDocument()
    expect(screen.getByText('Remaining unavailable')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('sub-budget spend renders as a floor caption, not as the main figure', () => {
    render(
      <BudgetRemainingList
        budgets={[
          {
            ...KNOWN,
            sub_budget_spend: [{ agent_id: '33333333-3333-4333-8333-333333333333', spent_atomic: '250000' }],
          },
        ]}
      />,
    )
    expect(screen.getByText('At least 0.25 USDC spent through sub-budgets this period')).toBeInTheDocument()
    // The main figure is unchanged by the attribution.
    expect(screen.getByText('1.5 USDC left')).toBeInTheDocument()
  })

  it('an empty budget set renders the empty state', () => {
    render(<BudgetRemainingList budgets={[]} />)
    expect(screen.getByText('No budgets yet.')).toBeInTheDocument()
  })
})
