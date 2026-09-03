import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockGet, mockGrant, mockRevoke, mockReload, mockBudgetsError } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockGrant: vi.fn(),
  mockRevoke: vi.fn(),
  mockReload: vi.fn(),
  mockBudgetsError: vi.fn(() => false),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    budgets: mockGet(),
    grant: mockGrant,
    revoke: mockRevoke,
    busy: false,
    ready: true,
    budgetsError: mockBudgetsError(),
    reload: mockReload,
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
  mockReload.mockReset()
  mockBudgetsError.mockReturnValue(false)
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

  it('notifies onBudgetChange after a successful revoke — the page summary reads a different source (#1090)', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    const onBudgetChange = vi.fn()
    render(<DelegationBudgetCard {...PROPS} onBudgetChange={onBudgetChange} />)
    await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy())
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(onBudgetChange).toHaveBeenCalled())
  })

  it('does NOT notify onBudgetChange when the revoke fails', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'failed' })
    const onBudgetChange = vi.fn()
    render(<DelegationBudgetCard {...PROPS} onBudgetChange={onBudgetChange} />)
    await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy())
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalled())
    expect(onBudgetChange).not.toHaveBeenCalled()
  })
})

// #2473: a failed budget fetch used to collapse into the same `null` as the
// pre-first-load state, so the card rendered nothing and the agent page's
// "Add budget" button scrolled to an empty region with no error anywhere.
describe('DelegationBudgetCard load failure (#2473)', () => {
  it('renders a retryable error instead of nothing when the budget fetch failed', async () => {
    mockGet.mockReturnValue(null)
    mockBudgetsError.mockReturnValue(true)
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeTruthy())
    fireEvent.click(screen.getByText('Try again'))
    expect(mockReload).toHaveBeenCalled()
  })

  // Design review (#2473): a failed budget fetch is the same CATEGORY of
  // problem as a failed signer fetch, so it gets the same shape — an inline
  // banner inside the card — instead of collapsing the card and taking the
  // grant form with it.
  it('keeps the card and its grant form when the budget fetch failed', async () => {
    mockGet.mockReturnValue(null)
    mockBudgetsError.mockReturnValue(true)
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeTruthy())
    expect(screen.getByText('Set budget')).toBeTruthy()
    expect(screen.getByLabelText('Budget amount')).toBeTruthy()
    // The unknown budget list must not read as "you have no budget".
    expect(screen.queryByText(/No budget yet/i)).toBeNull()
  })

  // Money-path review (#2473): a grant REPLACES the active budget in the same
  // (token, recipient) slot, silently. The rows above the form are what let an
  // owner see that coming — with the list unknown they cannot, so the action
  // is gated on reloading rather than on the owner reading a warning.
  it('refuses to grant while the current budgets are unknown', async () => {
    mockGet.mockReturnValue(null)
    mockBudgetsError.mockReturnValue(true)
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByText('Set budget'))
    await waitFor(() => expect(screen.getByText(/Reload the current budgets/i)).toBeTruthy())
    expect(mockGrant).not.toHaveBeenCalled()
  })

  it('says it is loading while the first load is still in flight — never renders empty', () => {
    mockGet.mockReturnValue(null)
    mockBudgetsError.mockReturnValue(false)
    const { container } = render(<DelegationBudgetCard {...PROPS} />)
    // The agent page scrolls to this card's anchor; an empty card is a
    // button that visibly does nothing.
    expect(container.textContent).not.toBe('')
    // Skeleton placeholders reserve the loaded card's shape (design review).
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
    expect(screen.getByText(/Agent budgets/)).toBeTruthy()
  })

  it('explains itself rather than rendering no form when the chain offers no grantable token', async () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} tokens={[]} />)
    await waitFor(() => expect(screen.getByText(/aren.t available for this network/i)).toBeTruthy())
    expect(screen.queryByText('Set budget')).toBeNull()
  })
})
