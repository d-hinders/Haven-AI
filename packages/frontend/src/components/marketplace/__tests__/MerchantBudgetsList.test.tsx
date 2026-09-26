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

  it('renders the remaining/total figure in the token the row is denominated in, with the agent name linking to its page', () => {
    render(<MerchantBudgetsList budgets={[row()]} />)
    const agentLink = screen.getByRole('link', { name: 'Research Agent' })
    expect(agentLink.getAttribute('href')).toBe('/agents/agent-1')
    expect(screen.getByText('9 USDC left of 10 USDC this period')).toBeDefined()
    expect(screen.getByText('Current')).toBeDefined()
  })

  // #3331 review finding F8: an unknown token must not silently read as
  // 18-decimal "tokens" — that is a WRONG figure, not just an unlabelled one.
  it('shows the raw atomic amounts and says "unknown token" instead of guessing 18 decimals', () => {
    render(<MerchantBudgetsList budgets={[row({ token_address: '0x' + 'ee'.repeat(20) })]} />)
    expect(screen.getByText('9000000 left of 10000000 this period (unknown token)')).toBeDefined()
    expect(screen.queryByText(/tokens this period/)).toBeNull()
  })

  it('shows the #1319 provenance note only when remaining_is_from_chain is false', () => {
    const { rerender } = render(<MerchantBudgetsList budgets={[row({ remaining_is_from_chain: true })]} />)
    expect(screen.queryByText(/could not confirm the live figure/)).toBeNull()
    rerender(<MerchantBudgetsList budgets={[row({ remaining_is_from_chain: false })]} />)
    expect(screen.getByText(/could not confirm the live figure/)).toBeDefined()
  })

  it.each([
    ['stale', 'Old address', /uses a new address/],
    ['unverified', 'Address unconfirmed', /cannot confirm it is still the merchant's/],
    // Design review round 3, finding D (doc F3): the payTo still matches —
    // this is not "can't pay" — only some offers stopped accepting this kind
    // of budget; its other offers still use it, no re-funding needed.
    ['not_erc7710', 'Not every offer', /Not every offer from this merchant accepts this kind of budget now.*any offer that still accepts it keeps using this budget/],
  ] as const)('pin_status %s renders its own plain label and one outcome sentence', (status, label, helperText) => {
    render(<MerchantBudgetsList budgets={[row({ pin_status: status })]} />)
    expect(screen.getByText(label)).toBeDefined()
    expect(screen.getByText(helperText)).toBeDefined()
  })

  // Design review round 3, finding D: a stale row's helper names WHERE to
  // stop it (the agent's own page) and where to fund the merchant again (the
  // action just above this list) — funding again is actually possible here,
  // unlike `unverified`.
  it('pin_status stale names the agent by name in the "stop it, fund again" step', () => {
    render(<MerchantBudgetsList budgets={[row({ pin_status: 'stale', agent_name: 'Research Agent' })]} />)
    expect(
      screen.getByText(/Stop this budget on Research Agent's page, then use “Fund this merchant” above\./),
    ).toBeDefined()
  })

  it('pin_status unverified does NOT claim funding again is available yet', () => {
    render(<MerchantBudgetsList budgets={[row({ pin_status: 'unverified' })]} />)
    expect(screen.queryByText(/Fund this merchant above/)).toBeNull()
  })

  it('current carries no helper explanation', () => {
    render(<MerchantBudgetsList budgets={[row({ pin_status: 'current' })]} />)
    expect(screen.getByText('Current')).toBeDefined()
    expect(screen.queryByText(/uses a new address|cannot confirm|cannot pay this merchant/)).toBeNull()
  })

  it('one row per BUDGET (delegation hash), not one row per agent', () => {
    render(
      <MerchantBudgetsList
        budgets={[row(), row({ agent_id: 'agent-2', agent_name: 'Second Agent', delegation_hash: '0x' + 'cc'.repeat(32) })]}
      />,
    )
    expect(screen.getByText('Research Agent')).toBeDefined()
    expect(screen.getByText('Second Agent')).toBeDefined()
  })

  // Doc review round 2, finding 7: ONE agent can hold TWO merchant-locked
  // budgets for this merchant at once (different tokens, or a `stale` row
  // beside its newer replacement) — each gets its own row, keyed by
  // delegation hash, never collapsed into one row per agent.
  it('renders TWO rows for one agent holding two budgets for this merchant', () => {
    render(
      <MerchantBudgetsList
        budgets={[
          row({ delegation_hash: '0x' + 'aa'.repeat(32), token_address: USDC_SEPOLIA }),
          row({
            delegation_hash: '0x' + 'dd'.repeat(32),
            token_address: '0x' + 'ee'.repeat(20),
            pin_status: 'stale',
          }),
        ]}
      />,
    )
    expect(screen.getAllByText('Research Agent')).toHaveLength(2)
    expect(screen.getByText('Current')).toBeDefined()
    expect(screen.getByText('Old address')).toBeDefined()
  })
})
