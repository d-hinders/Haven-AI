import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DelegationBudget } from '@/hooks/useDelegationBudget'

const { mockEditBudget, mockSignersError, mockReloadSigners } = vi.hoisted(() => ({
  mockEditBudget: vi.fn(),
  mockSignersError: vi.fn(() => false),
  mockReloadSigners: vi.fn(),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    editBudget: mockEditBudget,
    busy: false,
    ready: true,
    signersError: mockSignersError(),
    reloadSigners: mockReloadSigners,
  }),
}))

const EditBudgetModal = (await import('../EditBudgetModal')).default

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'cc'.repeat(20)

function budget(overrides: Record<string, unknown> = {}): DelegationBudget {
  return {
    id: 'b1',
    token_address: USDC,
    recipient_address: null,
    delegation_hash: '0x' + 'ab'.repeat(32),
    version: 1,
    status: 'active',
    budget_atomic: '5000000', // 5 USDC at 6 decimals
    period_seconds: 86_400,
    expires_at: 9_999_999_999,
    ...overrides,
  } as DelegationBudget
}

const PROPS = {
  agentId: 'agent-1',
  chainId: 84532,
  tokens: [{ address: USDC, symbol: 'USDC', decimals: 6 }],
}

beforeEach(() => {
  mockEditBudget.mockReset()
  mockEditBudget.mockResolvedValue({ ok: true, newDelegationHash: '0x' + 'be'.repeat(32), oldDelegationRevoked: true })
  mockSignersError.mockReturnValue(false)
  mockReloadSigners.mockReset()
})

function renderModal(overrides: Record<string, unknown> = {}) {
  const onClose = vi.fn()
  const onBudgetChange = vi.fn()
  render(
    <EditBudgetModal
      open
      onClose={onClose}
      agentId="agent-1"
      chainId={84532}
      tokens={PROPS.tokens}
      budget={budget()}
      onBudgetChange={onBudgetChange}
      {...overrides}
    />,
  )
  return { onClose, onBudgetChange }
}

/** Open → change the amount → Review. */
function toReview(newAmount = '10') {
  renderModal()
  fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: newAmount } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
}

describe('EditBudgetModal (#3166) — form', () => {
  it('prefills the current limits from the budget row', () => {
    renderModal({ budget: budget({ recipient_address: RECIPIENT }) })
    expect(screen.getByRole('heading', { name: 'Edit budget' })).toBeInTheDocument()
    expect(screen.getByLabelText('Budget amount')).toHaveValue('5')
    expect(screen.getByLabelText('Recipient')).toHaveValue(RECIPIENT)
    expect(screen.getByLabelText('Period')).toHaveValue('86400')
  })

  it('Review changes is disabled until something actually changes', () => {
    renderModal()
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '5' } })
    // Same amount re-typed is still no change.
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('states the old budget keeps working and nothing changes until signed', () => {
    renderModal()
    expect(screen.getByText(/Your current budget keeps working until the new one is signed/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing changes until you sign/)).toBeInTheDocument()
  })
})

describe('EditBudgetModal (#3166) — review', () => {
  it('shows a RAISE explicitly before signing', () => {
    toReview('10')
    expect(screen.getByText('Raise')).toBeInTheDocument()
    expect(screen.getByText(/You are raising what this agent can spend/)).toBeInTheDocument()
    expect(screen.getByText(/10 USDC per day/)).toBeInTheDocument()
  })

  it('shows a LOWER without raise copy', () => {
    toReview('2')
    expect(screen.getByText('Lower')).toBeInTheDocument()
    expect(screen.queryByText(/You are raising what this agent can spend/)).toBeNull()
  })

  it('states the brief two-grants window and that the flow asks for the second signature', () => {
    toReview('10')
    expect(screen.getByText(/both the old and the new budget exist briefly/)).toBeInTheDocument()
    expect(screen.getByText(/Haven will ask for that second signature/)).toBeInTheDocument()
  })

  it('runs the composition on sign and refreshes the card on success (#1090)', async () => {
    const { onBudgetChange } = renderModal({ budget: budget({ recipient_address: RECIPIENT }) })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))

    await waitFor(() => expect(mockEditBudget).toHaveBeenCalledTimes(1))
    // The OLD hash goes to the composition; the new limits are the input.
    expect(mockEditBudget.mock.calls[0][0]).toBe('0x' + 'ab'.repeat(32))
    expect(mockEditBudget.mock.calls[0][1]).toMatchObject({
      tokenAddress: USDC,
      budgetAtomic: '10000000', // 10 * 1e6
      periodSeconds: 86_400,
      recipientAddress: RECIPIENT,
    })
    await waitFor(() => expect(screen.getByText('Budget updated')).toBeInTheDocument())
    expect(onBudgetChange).toHaveBeenCalled()
  })
})

describe('EditBudgetModal (#3166) — outcomes', () => {
  it('a CANCELLED signature reopens the review — nothing changed, no error', async () => {
    mockEditBudget.mockResolvedValue({ ok: false, reason: 'cancelled' })
    toReview('10')
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(mockEditBudget).toHaveBeenCalled())
    // Back on the review step, still retryable in place.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign new budget' })).toBeEnabled())
    expect(screen.queryByText(/Budget update failed/)).toBeNull()
  })

  it('a FAILED run says nothing changed and the old budget still works', async () => {
    mockEditBudget.mockResolvedValue({ ok: false, reason: 'failed' })
    toReview('10')
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText('Budget update failed')).toBeInTheDocument())
    expect(screen.getByText(/Nothing changed — your current budget still works/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('a REFUSED build surfaces the backend sentence verbatim (re-key in flight)', async () => {
    mockEditBudget.mockResolvedValue({
      ok: false,
      reason: 'refused',
      detail: 'A key rotation is in flight for this agent — finish or abandon the re-key before granting a new budget',
    })
    toReview('10')
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText(/The budget could not be changed/)).toBeInTheDocument())
    expect(screen.getByText(/A key rotation is in flight for this agent/)).toBeInTheDocument()
    expect(screen.getByText(/Your current budget is unchanged/)).toBeInTheDocument()
  })

  it('revoke_unfinished tells the owner the new budget is live and names the way out', async () => {
    const { onBudgetChange } = renderModal()
    mockEditBudget.mockResolvedValue({
      ok: false,
      reason: 'revoke_unfinished',
      newDelegationHash: '0x' + 'be'.repeat(32),
    })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText(/New budget is live — one step left/)).toBeInTheDocument())
    expect(screen.getByText(/Use Stop next to it in the budget list/)).toBeInTheDocument()
    // The new budget IS live — the card must refresh (#1090).
    expect(onBudgetChange).toHaveBeenCalled()
  })

  it('success with oldDelegationRevoked: false still reads as done', async () => {
    mockEditBudget.mockResolvedValue({ ok: true, newDelegationHash: '0x' + 'be'.repeat(32), oldDelegationRevoked: false })
    toReview('10')
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText(/the previous budget was already stopped/)).toBeInTheDocument())
  })

  it('offers a retryable signer-set error instead of a dead modal', () => {
    mockSignersError.mockReturnValue(true)
    renderModal()
    expect(screen.getByText(/could not load how this account is approved/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Try again'))
    expect(mockReloadSigners).toHaveBeenCalled()
  })
})

describe('EditBudgetModal (#3166) — abandoned flow', () => {
  it('closing at the form or review never calls the composition — old budget untouched', () => {
    const { onClose } = renderModal()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mockEditBudget).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('Copy never leaks delegation jargon — outcome language only', () => {
    renderModal()
    expect(document.body.textContent).not.toMatch(/delegation|caveat|redemption|userop/i)
  })
})

describe('EditBudgetModal (#3166) — wiring pins', () => {
  it('is the ONLY edit surface — the budget card wires it, nobody reimplements it', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    expect(
      read('../DelegationBudgetCard.tsx'),
      'the budget card must open the shared edit modal',
    ).toMatch(/import EditBudgetModal from '\.\/EditBudgetModal'/)
  })
})
