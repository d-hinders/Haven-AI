import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DelegationBudget } from '@/hooks/useDelegationBudget'

// #3812: the in-flow connect/switch control reads wagmi and RainbowKit, which
// these tests do not provide. Stub it so the test can assert WHEN a flow
// offers it; `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

const { mockEditBudget, mockRevoke, mockSignersError, mockReloadSigners, mockReady, mockSignersLoading, mockPasskeyElsewhere } = vi.hoisted(() => ({
  mockRevoke: vi.fn(),
  mockPasskeyElsewhere: vi.fn(() => false),
  mockReady: vi.fn(() => true),
  mockSignersLoading: vi.fn(() => false),
  mockEditBudget: vi.fn(),
  mockSignersError: vi.fn(() => false),
  mockReloadSigners: vi.fn(),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    editBudget: mockEditBudget,
    revoke: mockRevoke,
    busy: false,
    ready: mockReady(),
    signersLoading: mockSignersLoading(),
    signersError: mockSignersError(),
    reloadSigners: mockReloadSigners,
    passkeyElsewhere: mockPasskeyElsewhere(),
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
  mockReady.mockReturnValue(true)
  mockSignersLoading.mockReturnValue(false)
  mockPasskeyElsewhere.mockReturnValue(false)
  mockReloadSigners.mockReset()
  mockRevoke.mockReset()
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
  // #3812: Edit opens only with a reachable signer, but the wallet can go away
  // before the review is signed. The way back is offered in the modal.
  it('offers the owner wallet connect on the review step when nobody here can sign', () => {
    mockReady.mockReturnValue(false)
    toReview()
    expect(screen.getByText(/Connect your account owner wallet to sign the new budget/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument()
    // Same gate as BudgetGrantAction: the signature is dead while the hint shows.
    expect(screen.getByRole('button', { name: 'Sign new budget' })).toBeDisabled()
  })

  it('no wallet connect while the signer set loads — connecting would not fix it', () => {
    mockReady.mockReturnValue(false)
    mockSignersLoading.mockReturnValue(true)
    toReview()
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('a signable review whose passkey is elsewhere carries the cross-device hint (#3825)', () => {
    mockPasskeyElsewhere.mockReturnValue(true)
    toReview()
    expect(screen.getByText(/passkey may be on another device/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign new budget' })).toBeEnabled()
  })

  it('a signable review offers no wallet connect', () => {
    toReview()
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign new budget' })).toBeEnabled()
  })

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

describe('EditBudgetModal (#3331 F3) — merchant-locked budgets', () => {
  function merchantLockedBudget(overrides: Record<string, unknown> = {}) {
    return budget({
      recipient_address: RECIPIENT,
      merchant_id: 'm-1',
      merchant_slug: 'ampersend-demo-api',
      merchant_name: 'Ampersend Demo API',
      ...overrides,
    })
  }

  it('shows the recipient read-only, naming the merchant, and never renders an editable Recipient field', () => {
    renderModal({ budget: merchantLockedBudget() })
    expect(screen.getByText(/Pays Ampersend Demo API only/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Recipient')).toBeNull()
  })

  it('the build body carries merchant_slug and the STORED recipient, never a retargeted or blank one', async () => {
    renderModal({ budget: merchantLockedBudget() })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(mockEditBudget).toHaveBeenCalledTimes(1))
    expect(mockEditBudget.mock.calls[0][1]).toMatchObject({
      recipientAddress: RECIPIENT,
      merchantSlug: 'ampersend-demo-api',
    })
  })

  it('names the merchant and truncated address in the read-only row (design review round 2, finding 6)', () => {
    renderModal({ budget: merchantLockedBudget() })
    expect(
      screen.getByText(new RegExp(`Pays Ampersend Demo API only · ${RECIPIENT.slice(0, 6)}`)),
    ).toBeInTheDocument()
  })

  it('the form intro does not say "for its recipient" for a merchant-locked budget (design review round 2, finding 1)', () => {
    renderModal({ budget: merchantLockedBudget() })
    expect(screen.queryByText(/budget for its recipient/)).toBeNull()
  })

  it('review step: names the merchant and truncated address in Now/After, never "one recipient" (design review round 2, finding 1)', () => {
    renderModal({ budget: merchantLockedBudget() })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.queryByText(/one recipient/)).toBeNull()
    const nowAndAfter = screen.getAllByText(
      new RegExp(`Ampersend Demo API only · ${RECIPIENT.slice(0, 6)}`),
    )
    expect(nowAndAfter).toHaveLength(2)
  })

  // ── R2-2: the merchant-STALE build refusals get plain copy with a way out ──
  it.each([
    [
      "recipient_address does not match the merchant's current verified payTo; reload the merchant page",
      /Ampersend Demo API now uses a different payment address, so this budget can't be changed here\. Stop it, then fund Ampersend Demo API again/,
    ],
    [
      'Merchant has no verified payTo on this chain; a merchant-locked budget cannot be issued yet',
      /Ampersend Demo API does not have a confirmed payment address right now, so this budget can't be changed here/,
    ],
    [
      'Merchant does not accept ERC-7710 payments on this chain; its payments use the open budget',
      /Not every offer from Ampersend Demo API accepts this kind of budget now, so it can't be changed here\. This budget keeps paying only the address it was set up with — Ampersend Demo API's page shows whether that is still where it is paid\./,
    ],
    ['Merchant not found', /Ampersend Demo API could not be found, so this budget can't be changed here\. Close this and stop the budget on the agent page instead\./],
  ])('maps the merchant-stale refusal ("%s") to plain copy with a way out, and offers only Close', async (detail, expected) => {
    mockEditBudget.mockResolvedValue({ ok: false, reason: 'refused', detail })
    renderModal({ budget: merchantLockedBudget() })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText(/The budget could not be changed/)).toBeInTheDocument())
    expect(screen.getByText(expected)).toBeInTheDocument()
    // Never the raw backend sentence verbatim.
    expect(screen.queryByText(detail)).toBeNull()
    // No jargon (delegation, recipient_address, payTo, ERC-7710).
    expect(document.body.textContent).not.toMatch(/delegation|recipient_address|payTo|erc-?7710/i)
    // A same-input retry cannot fix this — no "Try again".
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByText('Close').closest('button')).toBeInTheDocument()
  })

  it('keeps the raw backend sentence and Try again for a NON-merchant refusal (re-key in flight) even on a merchant-locked budget', async () => {
    mockEditBudget.mockResolvedValue({
      ok: false,
      reason: 'refused',
      detail: 'A key rotation is in flight for this agent — finish or abandon the re-key before granting a new budget',
    })
    renderModal({ budget: merchantLockedBudget() })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText(/The budget could not be changed/)).toBeInTheDocument())
    expect(screen.getByText(/A key rotation is in flight for this agent/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('an ordinary (non-merchant-locked) budget is completely unaffected — no merchantSlug, recipient stays editable', async () => {
    renderModal({ budget: budget({ recipient_address: RECIPIENT }) })
    expect(screen.getByLabelText('Recipient')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(mockEditBudget).toHaveBeenCalledTimes(1))
    expect(mockEditBudget.mock.calls[0][1]).not.toHaveProperty('merchantSlug')
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
    // #3933: the replaced budget no longer has a row with a Stop beside it —
    // the screen names it, says what it can still do, and offers the Stop.
    expect(screen.getByText(/The previous 5 USDC per day budget can still be spent outside Haven until it is stopped/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop old budget' })).toBeInTheDocument()
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

// #3537: the agent detail page re-renders every 10s on its agent poll, handing
// the open modal a NEW `tokens` array and a NEW `budget` object carrying the
// same data. That must not re-prefill the form or drop the step / outcome.
describe('EditBudgetModal (#3537) — background poll', () => {
  function renderControlled() {
    const props = { onClose: vi.fn(), onBudgetChange: vi.fn(), agentId: 'agent-1', chainId: 84532 }
    const view = render(<EditBudgetModal open tokens={PROPS.tokens} budget={budget()} {...props} />)
    const rerenderWith = (next: { open?: boolean; budget?: DelegationBudget } = {}) =>
      view.rerender(
        <EditBudgetModal
          open={next.open ?? true}
          // Fresh identities, identical data — what the poll produces.
          tokens={PROPS.tokens.map((t) => ({ ...t }))}
          budget={next.budget ?? budget()}
          {...props}
        />,
      )
    return { rerenderWith }
  }

  it('keeps the typed amount, period and recipient across a poll', () => {
    const { rerenderWith } = renderControlled()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '604800' } })
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: RECIPIENT } })

    rerenderWith()

    expect(screen.getByLabelText('Budget amount')).toHaveValue('10')
    expect(screen.getByLabelText('Period')).toHaveValue('604800')
    expect(screen.getByLabelText('Recipient')).toHaveValue(RECIPIENT)
  })

  it('stays on the review step across a poll', () => {
    const { rerenderWith } = renderControlled()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('button', { name: 'Sign new budget' })).toBeInTheDocument()

    rerenderWith()

    expect(screen.getByRole('button', { name: 'Sign new budget' })).toBeInTheDocument()
  })

  it('keeps the revoke_unfinished outcome across a poll', async () => {
    mockEditBudget.mockResolvedValue({
      ok: false,
      reason: 'revoke_unfinished',
      newDelegationHash: '0x' + 'be'.repeat(32),
    })
    const { rerenderWith } = renderControlled()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText(/New budget is live — one step left/)).toBeInTheDocument())

    rerenderWith()

    expect(screen.getByText(/New budget is live — one step left/)).toBeInTheDocument()
  })

  it('discards unsaved edits on close and re-prefills from the current budget on reopen', () => {
    const { rerenderWith } = renderControlled()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    rerenderWith({ open: false })
    rerenderWith({ open: true, budget: budget({ budget_atomic: '7000000' }) })

    expect(screen.getByLabelText('Budget amount')).toHaveValue('7')
    expect(screen.queryByRole('button', { name: 'Sign new budget' })).not.toBeInTheDocument()
  })
})

/**
 * #3933: the edit flow is where every replace now goes. It opens with typed
 * limits when a new-budget form routed here, carries a Fund flow's merchant,
 * says what the second signature does on-chain, and finishes an unfinished
 * Stop in place.
 */
describe('EditBudgetModal — replace without a silent leftover (#3933)', () => {
  const OLD_HASH = '0x' + 'ab'.repeat(32)

  it('opened from a new-budget form: prefilled with the typed limits, and says why', () => {
    renderModal({ prefill: { budgetAtomic: '12000000', periodSeconds: 604_800 } })
    expect(screen.getByLabelText('Budget amount')).toHaveValue('12')
    expect(screen.getByLabelText('Period')).toHaveValue('604800')
    expect(screen.getByText(/already has a budget for this token and recipient, so your new limits replace it here/)).toBeInTheDocument()
    // Typed limits differ from the current ones: Review is live at once.
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('opened directly (no prefill): no routing notice', () => {
    renderModal()
    expect(screen.queryByText(/so your new limits replace it here/)).toBeNull()
  })

  it("a Fund flow's merchant rides the replacement grant, and the recipient stays read-only", async () => {
    renderModal({
      budget: budget({ recipient_address: RECIPIENT }),
      merchant: { slug: 'ampersend-demo-api', name: 'Ampersend Demo API' },
    })
    expect(screen.queryByLabelText('Recipient')).toBeNull()
    expect(screen.getByText(/Pays Ampersend Demo API only/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(mockEditBudget).toHaveBeenCalled())
    const [oldHash, input] = mockEditBudget.mock.calls[0]!
    expect(oldHash).toBe(OLD_HASH)
    expect(input).toMatchObject({ merchantSlug: 'ampersend-demo-api', recipientAddress: RECIPIENT })
  })

  it('the review states what the second signature does on-chain', () => {
    toReview('10')
    expect(screen.getByText(/Until it is stopped, the old budget can still be spent outside Haven/)).toBeInTheDocument()
    expect(screen.getByText(/Stopping it also ends any open task budget or sub-budget taken from it/)).toBeInTheDocument()
  })

  async function toRevokeUnfinished() {
    const view = renderModal()
    mockEditBudget.mockResolvedValue({ ok: false, reason: 'revoke_unfinished', newDelegationHash: '0x' + 'be'.repeat(32) })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await screen.findByRole('button', { name: 'Stop old budget' })
    return view
  }

  it('revoke_unfinished: Stop old budget stops THE OLD hash through the per-hash revoke, then reads as done', async () => {
    const { onBudgetChange } = await toRevokeUnfinished()
    mockRevoke.mockResolvedValue({ ok: true })
    fireEvent.click(screen.getByRole('button', { name: 'Stop old budget' }))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith(OLD_HASH))
    await waitFor(() => expect(screen.getByText(/the previous budget is stopped/)).toBeInTheDocument())
    expect(onBudgetChange).toHaveBeenCalled()
  })

  it('revoke_unfinished: "Already revoked" is finished, not an error', async () => {
    await toRevokeUnfinished()
    mockRevoke.mockResolvedValue({ ok: true, alreadyStopped: true })
    fireEvent.click(screen.getByRole('button', { name: 'Stop old budget' }))
    await waitFor(() => expect(screen.getByText(/the previous budget was already stopped/)).toBeInTheDocument())
  })

  it('revoke_unfinished: a failed Stop stays on the screen and says so', async () => {
    await toRevokeUnfinished()
    mockRevoke.mockResolvedValue({ ok: false, reason: 'failed' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop old budget' }))
    await waitFor(() => expect(screen.getByText('The previous budget could not be stopped. Try again.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Stop old budget' })).toBeInTheDocument()
  })

  it('slot_occupied (a stale `replaces`): names it, refreshes the card, and offers only Close', async () => {
    const { onBudgetChange } = renderModal()
    mockEditBudget.mockResolvedValue({ ok: false, reason: 'slot_occupied', existingDelegationHash: '0x' + 'e1'.repeat(32) })
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign new budget' }))
    await waitFor(() => expect(screen.getByText('This budget has changed')).toBeInTheDocument())
    expect(screen.getByText(/nothing was signed\. Close this and edit the current budget/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(onBudgetChange).toHaveBeenCalled()
  })
})
