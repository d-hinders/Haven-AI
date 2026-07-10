import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockGet, mockGrant, mockRevoke } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockGrant: vi.fn(),
  mockRevoke: vi.fn(),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    budgets: mockGet(),
    grant: mockGrant,
    revoke: mockRevoke,
    busy: false,
    ready: true,
    reload: vi.fn(),
  }),
}))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }),
}))

const DelegationBudgetCard = (await import('../DelegationBudgetCard')).default

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PROPS = {
  agentId: 'agent-1',
  chainId: 84532,
  tokens: [{ address: USDC, symbol: 'USDC', decimals: 6 }],
}

function budget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1', token_address: USDC, recipient_address: '0x' + 'cc'.repeat(20),
    delegation_hash: '0x' + 'ab'.repeat(32), version: 1, status: 'active',
    budget_atomic: '5000000', period_seconds: 86_400, expires_at: 9_999_999_999,
    ...overrides,
  }
}

beforeEach(() => {
  mockGet.mockReset()
  mockGrant.mockReset()
  mockRevoke.mockReset()
})

describe('DelegationBudgetCard (#833)', () => {
  it('lists active budgets in outcome language — no delegation/caveat/UserOp jargon', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.getByText(/to any recipient/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/delegation|caveat|redemption|userop|permission/i)
  })

  it('grant: one Set-budget action calls grant with parsed atomic amount + period', async () => {
    mockGet.mockReturnValue([])
    mockGrant.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Set budget')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByText('Set budget'))
    await waitFor(() => expect(mockGrant).toHaveBeenCalled())
    expect(mockGrant.mock.calls[0][0]).toMatchObject({
      tokenAddress: USDC,
      budgetAtomic: '2500000', // 2.5 * 1e6
      periodSeconds: 86_400,
      recipientAddress: null,
    })
  })

  it('grant with a recipient passes it through', async () => {
    mockGet.mockReturnValue([])
    mockGrant.mockResolvedValue({ ok: true })
    const R = '0x' + 'ee'.repeat(20)
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Set budget')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: R } })
    fireEvent.click(screen.getByText('Set budget'))
    await waitFor(() => expect(mockGrant.mock.calls[0][0].recipientAddress).toBe(R))
  })

  it('Set budget stays disabled without a valid amount', async () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Set budget')).toBeTruthy())
    expect((screen.getByText('Set budget') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Stop calls revoke with the budget hash', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy())
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('0x' + 'ab'.repeat(32)))
  })

  it('renders nothing while budgets are loading (null)', () => {
    mockGet.mockReturnValue(null)
    const { container } = render(<DelegationBudgetCard {...PROPS} />)
    expect(container.textContent).toBe('')
  })
})
