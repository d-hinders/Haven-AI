import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MerchantBudgetsList } from '../MerchantBudgetsList'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'

const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function row(overrides: Partial<MerchantBudget> = {}): MerchantBudget {
  return {
    agent_id: 'agent-1',
    agent_name: 'Research Agent',
    chain_id: 84532,
    token_address: USDC_SEPOLIA,
    recipient_address: '0x' + 'f0'.repeat(20),
    delegation_hash: '0x' + 'bb'.repeat(32),
    budget_atomic: '10000000',
    period_seconds: 2_592_000,
    expires_at: '4102444800',
    remaining_atomic: '9000000',
    remaining_is_from_chain: true,
    pin_status: 'current',
    ...overrides,
  }
}

describe('MerchantBudgetsList (#3331)', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<MerchantBudgetsList budgets={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the remaining/total figure in the token the row is denominated in', () => {
    render(<MerchantBudgetsList budgets={[row()]} />)
    expect(screen.getByText('Research Agent')).toBeDefined()
    expect(screen.getByText('9 USDC left of 10 USDC this period')).toBeDefined()
    expect(screen.getByText('Current')).toBeDefined()
  })

  it('shows the #1319 provenance note only when remaining_is_from_chain is false', () => {
    const { rerender } = render(<MerchantBudgetsList budgets={[row({ remaining_is_from_chain: true })]} />)
    expect(screen.queryByText(/could not confirm the live figure/)).toBeNull()
    rerender(<MerchantBudgetsList budgets={[row({ remaining_is_from_chain: false })]} />)
    expect(screen.getByText(/could not confirm the live figure/)).toBeDefined()
  })

  it.each([
    ['stale', 'Stale', /pays only the old one/],
    ['unverified', 'Unverified', /no longer confirm one payment address/],
    ['not_erc7710', 'Unsupported now', /no longer accepts this budget/],
  ] as const)('pin_status %s renders its own label and explanation', (status, label, helperText) => {
    render(<MerchantBudgetsList budgets={[row({ pin_status: status })]} />)
    expect(screen.getByText(label)).toBeDefined()
    expect(screen.getByText(helperText)).toBeDefined()
  })

  it('current carries no helper explanation', () => {
    render(<MerchantBudgetsList budgets={[row({ pin_status: 'current' })]} />)
    expect(screen.getByText('Current')).toBeDefined()
    expect(screen.queryByText(/pays only the old one|no longer confirm|no longer accepts/)).toBeNull()
  })

  it('one row per agent, keyed by delegation hash', () => {
    render(
      <MerchantBudgetsList
        budgets={[row(), row({ agent_id: 'agent-2', agent_name: 'Second Agent', delegation_hash: '0x' + 'cc'.repeat(32) })]}
      />,
    )
    expect(screen.getByText('Research Agent')).toBeDefined()
    expect(screen.getByText('Second Agent')).toBeDefined()
  })
})
