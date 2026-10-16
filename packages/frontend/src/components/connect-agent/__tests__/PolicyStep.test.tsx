/**
 * Step 2's trimmed copy: the summary line under the fields is the step's only
 * explainer, and the Agent Passport opt-in is the bare choice — no helper line
 * under the budget inputs, no explainer clause or fee line on the checkbox.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { PolicyStep } from '../PolicyStep'

function flow(overrides: Record<string, unknown> = {}): AgentConnectionSetupFlow {
  return {
    hasMultipleAccounts: false,
    selectableAccounts: [],
    selectedAccountId: 'account-1',
    setSelectedAccountId: vi.fn(),
    budgetToken: { symbol: 'USDC' },
    addAmount: '3',
    handleAddAmountChange: vi.fn(),
    addAmountMessage: '',
    addReset: 1440,
    setAddReset: vi.fn(),
    resetPeriodOptions: [{ value: 1440, label: 'Daily' }],
    issuePassport: false,
    setIssuePassport: vi.fn(),
    allowances: [{ tokenSymbol: 'USDC', amount: '3', resetTimeMin: 1440 }],
    walletName: 'My account',
    walletNetworkName: 'Base Sepolia',
    createError: null,
    walletUnavailable: false,
    creating: false,
    setStep: vi.fn(),
    handleCreateSetup: vi.fn(),
    ...overrides,
  } as unknown as AgentConnectionSetupFlow
}

describe('PolicyStep copy', () => {
  it('labels the passport opt-in with the bare choice and no helper line', () => {
    render(<PolicyStep flow={flow()} />)

    expect(screen.getByRole('checkbox', { name: 'Issue an Agent Passport' })).toBeInTheDocument()
    expect(screen.queryByText(/revocable record/)).not.toBeInTheDocument()
    expect(screen.queryByText(/on-chain fee/)).not.toBeInTheDocument()
  })

  it('leaves the summary line as the only budget explainer', () => {
    render(<PolicyStep flow={flow()} />)

    expect(screen.getByText(/Nothing can spend until you approve this budget/)).toBeInTheDocument()
    expect(screen.queryByText(/Setup grants one/)).not.toBeInTheDocument()
    expect(screen.queryByText(/More tokens can be added/)).not.toBeInTheDocument()
  })
})
