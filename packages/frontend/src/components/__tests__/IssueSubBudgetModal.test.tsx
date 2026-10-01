import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DelegationBudget } from '@/hooks/useDelegationBudget'

const { mockIssue } = vi.hoisted(() => ({ mockIssue: vi.fn() }))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => ({
    loading: false,
    agents: [
      { id: 'agent-a', name: 'Atlas', status: 'active', delegate_address: '0x' + '11'.repeat(20), account_id: 'acc-1' },
      { id: 'agent-b', name: 'Scout', status: 'active', delegate_address: '0x' + '22'.repeat(20), account_id: 'acc-1' },
      { id: 'agent-c', name: 'Elsewhere', status: 'active', delegate_address: '0x' + '33'.repeat(20), account_id: 'acc-2' },
      { id: 'agent-d', name: 'Retired', status: 'revoked', delegate_address: '0x' + '44'.repeat(20), account_id: 'acc-1' },
    ],
  }),
}))
vi.mock('@/hooks/useSubBudgets', () => ({ issueSubBudget: mockIssue }))

const IssueSubBudgetModal = (await import('../IssueSubBudgetModal')).default

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const TOKENS = [{ address: USDC, symbol: 'USDC', decimals: 6 }]
const FAR = Math.floor(Date.now() / 1000) + 90 * 86_400

function budget(overrides: Record<string, unknown> = {}): DelegationBudget {
  return {
    id: 'b1', token_address: USDC, recipient_address: null, delegation_hash: '0x' + 'ab'.repeat(32),
    version: 1, status: 'active', budget_atomic: '50000000', period_seconds: 604_800, expires_at: FAR,
    ...overrides,
  } as DelegationBudget
}

function renderModal(onIssued = vi.fn()) {
  render(
    <IssueSubBudgetModal open onClose={vi.fn()} agentId="agent-a" budget={budget()} tokens={TOKENS} onIssued={onIssued} />,
  )
  return onIssued
}

function fill() {
  fireEvent.change(screen.getByLabelText('Agent to share with'), { target: { value: 'agent-b' } })
  fireEvent.change(screen.getByLabelText('Sub-budget amount'), { target: { value: '1.5' } })
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
  fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: soon } })
}

beforeEach(() => mockIssue.mockReset())

describe('IssueSubBudgetModal (#3506)', () => {
  it('shows the parent budget as the ceiling and lists only eligible agents', () => {
    renderModal()
    expect(screen.getByTestId('sub-budget-ceiling').textContent).toMatch(/Atlas.s budget is 50 USDC per week/)
    const options = Array.from(screen.getByLabelText('Agent to share with').querySelectorAll('option')).map((o) => o.textContent)
    expect(options).toEqual(['Choose an agent', 'Scout'])
  })

  it('validates before calling the API', async () => {
    renderModal()
    fireEvent.click(screen.getByText('Issue sub-budget', { selector: 'button' }))
    expect(mockIssue).not.toHaveBeenCalled()
    expect(screen.getByText('Choose which agent to share with.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Sub-budget amount'), { target: { value: '1.0000001' } })
    expect(screen.getByText('Use at most 6 decimal places.')).toBeTruthy()
  })

  it('sends atomic amount + unix expiry and then shows the pending state', async () => {
    mockIssue.mockResolvedValue({ sub_budget: {}, parent_child_sub_budget: {}, next_action: 'x', sign_targets: [] })
    const onIssued = renderModal()
    fill()
    fireEvent.click(screen.getByText('Issue sub-budget', { selector: 'button' }))
    await waitFor(() => expect(screen.getByTestId('sub-budget-pending')).toBeTruthy())
    const [agentId, body] = mockIssue.mock.calls[0]
    expect(agentId).toBe('agent-a')
    expect(body).toMatchObject({ sub_agent_id: 'agent-b', token_address: USDC, period_amount_atomic: '1500000' })
    expect(Number.isInteger(body.expires_at)).toBe(true)
    expect(screen.getByTestId('sub-budget-pending').textContent).toMatch(/waiting for Atlas/)
    expect(screen.getByTestId('sub-budget-pending').textContent).toMatch(/Ask Atlas to finish setting it up/)
    expect(onIssued).toHaveBeenCalledTimes(1)
  })

  it('shows plain-words copy for a refusal and keeps the form', async () => {
    mockIssue.mockRejectedValueOnce(
      Object.assign(new Error('refused'), {
        status: 400,
        body: { error_code: 'sub_budget_wider_than_parent', reason: 'amount' },
      }),
    )
    renderModal()
    fill()
    fireEvent.click(screen.getByText('Issue sub-budget', { selector: 'button' }))
    await waitFor(() =>
      expect(screen.getByText("This is more than Atlas's own budget allows per period. Lower the amount.")).toBeTruthy(),
    )
    expect(screen.queryByTestId('sub-budget-pending')).toBeNull()
  })
})
