import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { budgetCaption } from '@/lib/budget-caption'
import { AGENT_PAUSED_SHORT } from '@/lib/agent-pause-copy'
import { timeAgo } from '@/lib/format'
import type { DashboardAgentStats } from '@/types/dashboard'

// #3812: the in-flow connect/switch control reads wagmi and RainbowKit, which
// these tests do not provide. Stub it so the test can assert WHEN a flow
// offers it; `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

const { mockGet, mockGrant, mockEdit, mockRevoke, mockReload, mockBudgetsError, mockTaskBudgets, mockTrees, mockReceivedGrants, mockHookArgs, mockToast, mockSigner } =
  vi.hoisted(() => ({
  // #3812: whether this device can sign, and whether the signer set is known.
  mockSigner: { ready: true, signersLoading: false, signersError: null as string | null, passkeyElsewhere: false },
  mockHookArgs: vi.fn(),
  mockGet: vi.fn(),
  mockGrant: vi.fn(),
  // #4154: the edit flow's activate-then-Stop, one call as in the hook.
  mockEdit: vi.fn(),
  mockRevoke: vi.fn(),
  mockReload: vi.fn(),
  mockBudgetsError: vi.fn(() => false),
  mockTaskBudgets: vi.fn(() => [] as unknown[]),
  // #3922: the sub-budget trees the card renders; null = nothing read (default).
  mockTrees: vi.fn(() => null as unknown[] | null),
  // #3988: the grants the agent RECEIVES; null = nothing read (default).
  mockReceivedGrants: vi.fn(() => null as unknown[] | null),
  // Shared so the revoke-toast tests can assert on it; the component only
  // ever calls the namespaced methods (success/info/error).
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

// #4226: the hero's Last 30 days column formats through the user's display
// currency. Pinned so the rendered figure is deterministic; the column tests
// override it through a dedicated helper if a currency case ever needs one.
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ currency: 'USD' }),
}))

// The modal's Stop-set read (#3933), over the mocked list: the real helper
// with no remembered attempt (the hook's own tests cover that case).
const budgetSlot = await vi.importActual<typeof import('@/lib/budget-slot')>('@/lib/budget-slot')
vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: (...args: unknown[]) => {
    mockHookArgs(...args)
    return {
    budgets: mockGet(),
    grant: mockGrant,
    editBudget: mockEdit,
    editStopSet: (hash: string, slot: { tokenAddress: string; recipientAddress?: string | null }, nowSec: number) =>
      budgetSlot.slotOccupantHashesForEdit(mockGet() as never, hash, slot, nowSec),
    isOwnAttemptedGrant: () => false,
    revoke: mockRevoke,
    busy: false,
    ready: mockSigner.ready,
    signersLoading: mockSigner.signersLoading,
    signersError: mockSigner.signersError,
    passkeyElsewhere: mockSigner.passkeyElsewhere,
    budgetsError: mockBudgetsError(),
    reload: mockReload,
    }
  },
}))
// #3329: read separately — DelegationBudgetCard's own tests must not need to
// know this hook's wire shape, only what it returns.
vi.mock('@/hooks/useTaskBudgets', () => ({
  useTaskBudgets: () => ({ taskBudgets: mockTaskBudgets(), error: false, reload: vi.fn() }),
}))
vi.mock('@/hooks/useSubBudgets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useSubBudgets')>()),
  useSubBudgetTrees: () => ({ trees: mockTrees(), error: false, reload: vi.fn() }),
  useReceivedSubBudgets: () => ({ grants: mockReceivedGrants(), error: false, reload: vi.fn() }),
}))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

const DelegationBudgetCard = (await import('../DelegationBudgetCard')).default
const DELEGATION_BUDGET_CARD_ID = (await import('../DelegationBudgetCard')).DELEGATION_BUDGET_CARD_ID

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PROPS = {
  agentId: 'agent-1',
  chainId: 84532,
  tokens: [{ address: USDC, symbol: 'USDC', decimals: 6 }],
  // #3717: the Stop confirm names the agent in its body.
  agentName: 'Research agent',
}

function budget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1', token_address: USDC, recipient_address: '0x' + 'cc'.repeat(20),
    delegation_hash: '0x' + 'ab'.repeat(32), version: 1, status: 'active', is_live: true,
    budget_atomic: '5000000', period_seconds: 86_400, expires_at: 9_999_999_999,
    // #3806: the anchor — 2026-09-01T02:00:00Z, so the daily boundary after the
    // frozen clock (2026-09-01T12:00Z) is 2026-09-02T02:00Z, 14h out.
    start_date: '1788228000', created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

function taskBudget(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1', agent_id: 'agent-1', chain_id: 84532, token_address: USDC,
    recipient_address: null, parent_delegation_hash: '0x' + 'ab'.repeat(32),
    delegation_hash: '0x' + 'dd'.repeat(32), label: null, max_atomic: '1000000',
    status: 'open', expires_at: Math.floor(Date.now() / 1000) + 3600, is_expired: false, is_live: true,
    created_at: '2026-01-01T00:00:00Z', opened_at: '2026-01-01T00:00:00Z',
    closed_at: null, close_tx_hash: null,
    ...overrides,
  }
}

/**
 * #4226: Stop lives in the budget's per-budget ⋯ menu, beside Edit — the
 * irreversible action gets a menu of its own and its confirm still stands
 * between the click and the signature. Opens the row's menu and clicks the
 * item; the direct-button tests keep their bodies behind this preamble.
 */
async function openStopViaMenu(label: string) {
  const trigger = await waitFor(() =>
    screen.getByRole('button', { name: new RegExp(`^Budget options ${label}$`) }),
  )
  fireEvent.click(trigger)
  fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: 'Stop budget…' })))
}

/**
 * #4226: the needs-setup state collapses the grant form behind "Set budget"
 * (mockup v2). Tests that interact with the form click it open first; with
 * budgets listed the opener is "Add budget" and the form is untouched.
 */
async function openGrantForm() {
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Set budget' })))
}

beforeEach(() => {
  mockSigner.ready = true
  mockSigner.passkeyElsewhere = false
  mockSigner.signersLoading = false
  mockSigner.signersError = null
  mockGet.mockReset()
  mockTrees.mockReset()
  mockTrees.mockReturnValue(null)
  mockReceivedGrants.mockReset()
  mockReceivedGrants.mockReturnValue(null)
  mockGrant.mockReset()
  mockEdit.mockReset()
  mockRevoke.mockReset()
  mockReload.mockReset()
  mockBudgetsError.mockReturnValue(false)
  mockTaskBudgets.mockReset()
  mockTaskBudgets.mockReturnValue([])
  mockToast.mockClear()
  mockToast.success.mockClear()
  mockToast.error.mockClear()
  mockToast.info.mockClear()
})

// #3825: one cross-device heads-up for every signature the card asks for.
describe('DelegationBudgetCard cross-device hint (#3825)', () => {
  it('shows the hint once when this device can sign but the passkey is elsewhere', async () => {
    mockSigner.passkeyElsewhere = true
    render(<DelegationBudgetCard {...PROPS} />)
    expect(await screen.findAllByText(/passkey may be on another device/)).toHaveLength(1)
  })

  it('shows no hint when the passkey is on this device', async () => {
    render(<DelegationBudgetCard {...PROPS} />)
    await screen.findByText('Spending')
    expect(screen.queryByText(/passkey may be on another device/)).toBeNull()
  })

  it('a retired agent with a live budget still shows the hint — its Stop is an owner signature too', async () => {
    mockSigner.passkeyElsewhere = true
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} retired="archived" />)
    expect(await screen.findAllByText(/passkey may be on another device/)).toHaveLength(1)
  })

  it('a retired agent with no active budget shows no hint — nothing to approve', async () => {
    mockSigner.passkeyElsewhere = true
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} retired="archived" />)
    await screen.findByText('No active budget.')
    expect(screen.queryByText(/passkey may be on another device/)).toBeNull()
  })

  it('shows no hint while nobody here can sign', async () => {
    mockSigner.passkeyElsewhere = true
    mockSigner.ready = false
    render(<DelegationBudgetCard {...PROPS} />)
    await screen.findByText('Spending')
    expect(screen.queryByText(/passkey may be on another device/)).toBeNull()
  })
})

describe('DelegationBudgetCard (#833)', () => {
  it('lists active budgets in outcome language — no delegation/caveat/UserOp jargon', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.getByText(/to any recipient/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/delegation|caveat|redemption|userop|permission/i)
  })

  it('names the merchant for a merchant-locked budget instead of its raw address (#3331)', async () => {
    mockGet.mockReturnValue([
      budget({ recipient_address: '0x' + 'f0'.repeat(20), merchant_id: 'm-1', merchant_slug: 'ampersend-demo-api', merchant_name: 'Ampersend Demo API' }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.getByText('pays Ampersend Demo API only')).toBeTruthy()
    expect(screen.queryByText(/to 0x/)).toBeNull()
  })

  it('falls back to the address when a budget carries no merchant (ordinary pinned budget, unaffected by #3331)', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: '0x' + 'f0'.repeat(20), merchant_id: null, merchant_name: null })])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.getByText(/to 0xf0f0/)).toBeTruthy()
  })

  it('offers Issue sub-budget only when the agent has an active budget (#3506, #3716)', async () => {
    mockGet.mockReturnValue([])
    const { unmount } = render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Set budget')).toBeTruthy())
    expect(screen.queryByText('Issue sub-budget')).toBeNull()
    expect(screen.queryByText('Or share part of an existing budget with another agent')).toBeNull()
    unmount()

    // A pending (not yet active) budget is not something to slice either.
    mockGet.mockReturnValue([budget({ status: 'pending', is_live: false })])
    const second = render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Set budget')).toBeTruthy())
    expect(screen.queryByText('Issue sub-budget')).toBeNull()
    second.unmount()

    // #3716: with an eligible budget the entry lives INSIDE the Add budget
    // panel — absent while the panel is closed, present once it is open.
    mockGet.mockReturnValue([budget()])
    const third = render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.queryByText('Issue sub-budget')).toBeNull()
    expect(screen.queryByText('Or share part of an existing budget with another agent')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(screen.getByText('Issue sub-budget')).toBeTruthy()
    third.unmount()
  })

  it('grant: one Set-budget action calls grant with parsed atomic amount + period', async () => {
    mockGet.mockReturnValue([])
    mockGrant.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    await openGrantForm()
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
    await openGrantForm()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: R } })
    fireEvent.click(screen.getByText('Set budget'))
    await waitFor(() => expect(mockGrant.mock.calls[0][0].recipientAddress).toBe(R))
  })

  // #3895: this surface's verb is "set" (label "Set budget" / "Setting…"), so
  // its failure sentence keeps the exact wording the shared grant control used
  // to hard-code. The modal passes its own approve sentence — see its test.
  it('a failed grant says "could not set the budget" — the agent page keeps its verb', async () => {
    mockGet.mockReturnValue([])
    mockGrant.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<DelegationBudgetCard {...PROPS} />)
    await openGrantForm()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('Set budget'))

    const message = await screen.findByText(
      'Haven could not set the budget. Nothing changed — try again.',
    )
    expect(message.className).toMatch(/danger/)
  })

  it('Set budget stays disabled without a valid amount', async () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    // #4226: the opener opens the form; the submit inside it stays disabled
    // until the amount parses.
    await openGrantForm()
    expect((screen.getByRole('button', { name: 'Set budget' }) as HTMLButtonElement).disabled).toBe(true)
  })

  // ── #3812: the owner wallet's way in, on the card itself ──
  // Stop and Edit (and Set budget) are dead while nobody here can sign; the
  // header used to be the only place to connect a wallet.

  it('a listed budget with no reachable signer explains why Stop is dead and offers the connect', async () => {
    mockSigner.ready = false
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Budget options 5 USDC per day' })).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Budget options 5 USDC per day' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Connect your account owner wallet to change or stop a budget/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('the grant form with no reachable signer offers the connect beside Set budget', async () => {
    mockSigner.ready = false
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    await openGrantForm()
    expect(screen.getByText(/Connect your account owner wallet to set a budget/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('no connect while the signer set loads or failed to load — connecting fixes neither', async () => {
    mockSigner.ready = false
    mockSigner.signersLoading = true
    mockGet.mockReturnValue([budget()])
    const { unmount } = render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Budget options 5 USDC per day' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
    unmount()
    mockSigner.signersLoading = false
    mockSigner.signersError = 'failed'
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/could not load how this account is approved/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('a ready (passkey) owner is offered no wallet connect', async () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Budget options 5 USDC per day' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  // ── #3717: Stop budget, behind a confirm ──
  // Stopping ends an irreversible on-chain delegation, so the row's button
  // now opens the ConfirmDialog with the owner copy and only the dialog's
  // confirm reaches the signature.

  it('Stop budget opens the confirm with the owner copy; no signature until confirmed', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    // #4226: the menu item opens the confirm directly; the copy below is the
    // dialog's, and nothing is signed until its own confirm is clicked.
    await openStopViaMenu('5 USDC per day')
    // The owner copy, rendered for the row: agent name, 5 USDC, period noun.
    expect(screen.getByRole('heading', { name: 'Stop this budget?' })).toBeTruthy()
    expect(
      screen.getByText(/Research agent can no longer spend from this 5 USDC\/day budget\. This can.t be undone, but you can set a new budget for the agent at any time\./),
    ).toBeTruthy()
    // Nothing has been signed yet.
    expect(mockRevoke).not.toHaveBeenCalled()
    // Confirming is what fires the revoke, with this row's hash.
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('0x' + 'ab'.repeat(32)))
  })

  it('Cancel closes the Stop confirm with nothing called', async () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    await openStopViaMenu('5 USDC per day')
    expect(screen.getByRole('heading', { name: 'Stop this budget?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull()
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('the Stop confirm falls back to the row label for an off-list period and an unknown token', async () => {
    // 90 s is off the picker's trio: the words come from the caption helper's
    // largest-dividing-unit rule ("every 90 seconds"), not a raw "90s".
    mockGet.mockReturnValue([budget({ period_seconds: 90 })])
    render(<DelegationBudgetCard {...PROPS} />)
    await openStopViaMenu('5 USDC every 90 seconds')
    expect(screen.getByText(/from this 5 USDC every 90 seconds budget\./)).toBeTruthy()

    mockGet.mockReturnValue([budget({ budget_atomic: '5' })])
    const { unmount } = render(<DelegationBudgetCard {...PROPS} tokens={[]} />)
    // An unknown token has no decimals, so the row shows the raw atomic
    // amount — its own fallback, without the slash form.
    await openStopViaMenu('5 per day')
    expect(screen.getByText(/from this 5 per day budget\./)).toBeTruthy()
    unmount()
  })

  it('a successful stop toasts "Budget stopped." and closes the confirm', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    await openStopViaMenu('5 USDC per day')
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Budget stopped.'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull())
  })

  it('a cancelled signature toasts "Approval was cancelled." and closes the confirm', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'cancelled' })
    render(<DelegationBudgetCard {...PROPS} />)
    await openStopViaMenu('5 USDC per day')
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('Approval was cancelled.'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull())
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it('a failed stop toasts the retry line and closes the confirm', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<DelegationBudgetCard {...PROPS} />)
    await openStopViaMenu('5 USDC per day')
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Could not stop the budget. Try again.'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull())
  })

  it('notifies onBudgetChange after a successful revoke — the page summary reads a different source (#1090)', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    const onBudgetChange = vi.fn()
    render(<DelegationBudgetCard {...PROPS} onBudgetChange={onBudgetChange} />)
    await openStopViaMenu('5 USDC per day')
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(onBudgetChange).toHaveBeenCalled())
  })

  it('does NOT notify onBudgetChange when the revoke fails', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'failed' })
    const onBudgetChange = vi.fn()
    render(<DelegationBudgetCard {...PROPS} onBudgetChange={onBudgetChange} />)
    await openStopViaMenu('5 USDC per day')
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalled())
    expect(onBudgetChange).not.toHaveBeenCalled()
  })

  // ── ?grant=<delegation hash> prefill (#2539) ──
  // The CLI's signing link lands on this page with the pending build's hash;
  // the form must open pre-filled from the row it already fetches.

  function withSearch(search: string) {
    // jsdom: seed and restore window.location.search around one test.
    const original = window.location
    // @ts-expect-error — jsdom permits the delete/delete-then-assign dance.
    delete window.location
    // @ts-expect-error — see above.
    window.location = new URL(`https://app.haven.test/agents/agent-1${search}`) as unknown as Location
    return () => {
      // @ts-expect-error — see above.
      window.location = original
    }
  }

  it('?grant= pre-fills the grant form from the pending build the card already fetched (#2539)', async () => {
    const restore = withSearch(`?grant=${'0x' + 'cd'.repeat(32)}`)
    try {
      mockGet.mockReturnValue([
        budget({
          delegation_hash: '0x' + 'cd'.repeat(32),
          status: 'pending',
          recipient_address: null,
          budget_atomic: '5000000',
          period_seconds: 86_400,
        }),
      ])
      render(<DelegationBudgetCard {...PROPS} />)
      await waitFor(() => expect((screen.getByLabelText('Budget amount') as HTMLInputElement).value).toBe('5'))
      expect((screen.getByLabelText('Recipient') as HTMLInputElement).value).toBe('')
      expect((screen.getByLabelText('Period') as HTMLSelectElement).value).toBe('86400')
    } finally {
      restore()
    }
  })

  // #3695 (B3): the grant form is collapsed once a budget exists — but a
  // `?grant=` link must still land on the build it carries, prefilled.
  it('?grant= opens the collapsed form prefilled even with an active budget present (#3695)', async () => {
    const restore = withSearch(`?grant=${'0x' + 'cd'.repeat(32)}`)
    try {
      mockGet.mockReturnValue([
        budget(),
        budget({
          id: 'b2',
          delegation_hash: '0x' + 'cd'.repeat(32),
          status: 'pending',
          is_live: false,
          recipient_address: null,
          budget_atomic: '7000000',
        }),
      ])
      render(<DelegationBudgetCard {...PROPS} />)
      await waitFor(() => expect((screen.getByLabelText('Budget amount') as HTMLInputElement).value).toBe('7'))
      expect(screen.getByText('Set budget')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Add budget' })).toBeNull()
      // #3716: the prefill opens the panel, so the entry shows there too.
      expect(screen.getByText('Issue sub-budget')).toBeTruthy()
      expect(screen.getByText('Or share part of an existing budget with another agent')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('?grant= on a retired agent leaves the link alone — there is no form to fill (#3549)', async () => {
    const restore = withSearch(`?grant=${'0x' + 'cd'.repeat(32)}`)
    const replaceState = vi.spyOn(window.history, 'replaceState')
    try {
      mockGet.mockReturnValue([budget({ delegation_hash: '0x' + 'cd'.repeat(32), status: 'pending' })])
      render(<DelegationBudgetCard {...PROPS} retired="archived" />)
      await waitFor(() => expect(screen.getByText('No active budget.')).toBeTruthy())
      expect(screen.queryByLabelText('Budget amount')).toBeNull()
      expect(replaceState).not.toHaveBeenCalled()
    } finally {
      replaceState.mockRestore()
      restore()
    }
  })

  it('?grant= with a recipient pin pre-fills the recipient too (#2539)', async () => {
    const restore = withSearch(`?grant=${'0x' + 'cd'.repeat(32)}`)
    try {
      mockGet.mockReturnValue([
        budget({
          delegation_hash: '0x' + 'cd'.repeat(32),
          status: 'pending',
          recipient_address: '0x' + 'cc'.repeat(20),
          budget_atomic: '1500000',
          period_seconds: 3_600,
        }),
      ])
      render(<DelegationBudgetCard {...PROPS} />)
      await waitFor(() => expect((screen.getByLabelText('Budget amount') as HTMLInputElement).value).toBe('1.5'))
      expect((screen.getByLabelText('Recipient') as HTMLInputElement).value).toBe('0x' + 'cc'.repeat(20))
      // An off-rhythm period (1h) gets its own Select option rather than
      // silently desyncing from the state it displays.
      expect((screen.getByLabelText('Period') as HTMLSelectElement).value).toBe('3600')
    } finally {
      restore()
    }
  })

  it('an unknown or non-pending ?grant= hash leaves the form blank — never an error state (#2539)', async () => {
    const restore = withSearch(`?grant=${'0x' + 'ef'.repeat(32)}`)
    try {
      mockGet.mockReturnValue([])
      render(<DelegationBudgetCard {...PROPS} />)
      // #4226: the collapsed needs-setup state — open the form to see that
      // the unknown hash left it blank.
      await openGrantForm()
      expect((screen.getByLabelText('Budget amount') as HTMLInputElement).value).toBe('')
    } finally {
      restore()
    }
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

  // Money-path review (#2473): a submit into a (token, recipient) slot that
  // already holds a budget must be edited, not granted (#3933 — the backend
  // refuses a plain grant there). The rows above the form are what the
  // card's slot check reads — with the list unknown it cannot, so the action
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
    expect(screen.getByRole('heading', { name: 'Spending' })).toBeTruthy()
  })

  it('explains itself rather than rendering no form when the chain offers no grantable token', async () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} tokens={[]} />)
    await waitFor(() => expect(screen.getByText(/aren.t available for this network/i)).toBeTruthy())
    expect(screen.queryByText('Set budget')).toBeNull()
  })
})

// #3329: task budgets — a self-closing authority carved from a budget above.
describe('DelegationBudgetCard task budgets (#3329)', () => {
  it('no open task budgets: no reserved line, no section', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    mockTaskBudgets.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.queryByText(/reserved for task budgets/)).toBeNull()
    expect(screen.queryByText('Task budgets')).toBeNull()
  })

  it('one open task budget under a budget: shows the reserved line and the section', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    mockTaskBudgets.mockReturnValue([taskBudget({ parent_delegation_hash: '0x' + 'ab'.repeat(32), max_atomic: '2000000' })])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/2.00 USDC reserved for task budgets/)).toBeTruthy())
    expect(screen.getByText('Task budgets')).toBeTruthy()
    expect(screen.getByText(/up to 2 USDC · ends/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/delegation|caveat|redemption|userop|permission/i)
  })

  it('shows the task budget label and recipient when set', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    const R = '0x' + 'ee'.repeat(20)
    mockTaskBudgets.mockReturnValue([
      taskBudget({ label: 'Scrape run', recipient_address: R, parent_delegation_hash: '0x' + 'ab'.repeat(32) }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Scrape run')).toBeTruthy())
    expect(screen.getByText(new RegExp(`to ${R.slice(0, 6)}`))).toBeTruthy()
  })

  it('an expired task budget is ignored — no line, no section', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    mockTaskBudgets.mockReturnValue([
      taskBudget({
        parent_delegation_hash: '0x' + 'ab'.repeat(32),
        is_expired: true,
        is_live: false,
        expires_at: Math.floor(Date.now() / 1000) - 3600,
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.queryByText(/reserved for task budgets/)).toBeNull()
    expect(screen.queryByText('Task budgets')).toBeNull()
  })

  it('a task-budget fetch error does not break the budgets list', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    mockTaskBudgets.mockReturnValue([]) // the hook degrades to null/[] on error — see useTaskBudgets tests
    render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.queryByText(/reserved for task budgets/)).toBeNull()
  })
})

describe('DelegationBudgetCard on a retired agent (#3549)', () => {
  // Nothing that GRANTS authority is offered to a revoked or removed agent;
  // reading what is left and ending it (Stop budget) still are.
  it.each([
    ['revoked', /This agent has been revoked, so its budgets can only be stopped/],
    ['archived', /This agent has been removed, so its budgets can only be stopped/],
  ] as const)('%s: no Set budget, Edit or Issue sub-budget — one-line reason instead', async (retired, reason) => {
    // Same fixture, two renders: the controls are THERE on a live agent, so
    // their absence below is the retired gate and not a fixture that never
    // rendered them (an Edit / Issue sub-budget needs an active, unexpired row).
    mockGet.mockReturnValue([budget()])
    const live = render(<DelegationBudgetCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    // #3695: with an active budget the grant form waits behind "Add budget",
    // so "Set budget" is not on screen until it is opened — asserting "Add
    // budget" is what keeps the retired half below from passing vacuously.
    expect(screen.getByRole('button', { name: 'Add budget' })).toBeTruthy()
    expect(screen.getByText('Edit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(screen.getByText('Set budget')).toBeTruthy()
    expect(screen.getByLabelText('Period')).toBeTruthy()
    // #3716: the live half's sub-budget assertion moved here — the entry only
    // exists once the panel is open, and a retired agent has neither.
    expect(screen.getByText('Issue sub-budget')).toBeTruthy()
    live.unmount()

    render(<DelegationBudgetCard {...PROPS} retired={retired} />)
    await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
    expect(screen.getByText(reason)).toBeTruthy()
    // The whole grant form is gone, not just its button.
    expect(screen.queryByText('Set budget')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add budget' })).toBeNull()
    expect(screen.queryByLabelText('Budget amount')).toBeNull()
    expect(screen.queryByLabelText('Period')).toBeNull()
    expect(screen.queryByLabelText('Recipient')).toBeNull()
    expect(screen.queryByText('Edit')).toBeNull()
    expect(screen.queryByText('Issue sub-budget')).toBeNull()
    // #4226: Stop moved into the per-budget ⋯ menu; the trigger stays, and
    // the next test opens the menu to prove the item is still offered.
    expect(screen.getByRole('button', { name: 'Budget options 5 USDC per day' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/delegation|caveat|redemption|userop|permission/i)
  })

  it.each(['revoked', 'archived'] as const)('%s: Stop stays available and still ends the budget', async (retired) => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} retired={retired} />)
    // #4226: retired keeps the per-budget menu; the item is available.
    await openStopViaMenu('5 USDC per day')
    const stop = screen.getByRole('button', { name: 'Stop budget' })
    expect((stop as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(stop)
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('0x' + 'ab'.repeat(32)))
  })

  it('keeps the task-budget list read-only on a retired agent', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    mockTaskBudgets.mockReturnValue([taskBudget({ max_atomic: '2000000' })])
    render(<DelegationBudgetCard {...PROPS} retired="revoked" />)
    await waitFor(() => expect(screen.getByText('Task budgets')).toBeTruthy())
    expect(screen.getByText(/2.00 USDC reserved for task budgets/)).toBeTruthy()
  })

  it('with no active budget it never invites the owner to set one', async () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} retired="revoked" />)
    await waitFor(() => expect(screen.getByText('No active budget.')).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/set one below|Set how much|can only be stopped|first budget/)
    expect(screen.queryByText('Set budget')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add budget' })).toBeNull()
  })

  // #3716: the sub-budget entry lives inside the Add budget panel, which a
  // retired agent does not have — so `retired ? []` keeps the modal from ever
  // mounting. This asserts it in the only way available from outside: no
  // panel to open, no entry, no dialog.
  it.each(['revoked', 'archived'] as const)(
    '%s: cannot mount the sub-budget modal — the panel it lives in does not exist (#3716)',
    async (retired) => {
      mockGet.mockReturnValue([budget()])
      render(<DelegationBudgetCard {...PROPS} retired={retired} />)
      await waitFor(() => expect(screen.getByText(/5 USDC per day/)).toBeTruthy())
      expect(screen.queryByRole('button', { name: 'Add budget' })).toBeNull()
      expect(screen.queryByText('Issue sub-budget')).toBeNull()
      expect(screen.queryByText('Or share part of an existing budget with another agent')).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
    },
  )
})

// #3695: one Spending surface — the section heading above the card, a meter
// per budget from remaining-this-period (#3693), and a collapsed Add budget.
describe('DelegationBudgetCard Spending section (#3695)', () => {
  const NOW = Date.parse('2026-09-01T12:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the hook for remaining-this-period — the only caller that does', () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(mockHookArgs).toHaveBeenCalledWith('agent-1', 84532, { includeRemaining: true })
  })

  it('heads the section "Spending", above the card', () => {
    mockGet.mockReturnValue([])
    const { container } = render(<DelegationBudgetCard {...PROPS} />)
    const heading = screen.getByRole('heading', { name: 'Spending' })
    // The heading sits outside the card it introduces (design-system.md
    // detail-page section rule, #3692).
    const card = container.querySelector('.rounded-\\[10px\\]')
    expect(card).not.toBeNull()
    expect(card!.contains(heading)).toBe(false)
  })

  it('draws a meter from remaining_atomic: used = budget − remaining, with the refill', () => {
    mockGet.mockReturnValue([
      budget({
        remaining_atomic: '3750000',
        remaining_from_chain: true,
        period_end: '2026-09-02T02:00:00Z',
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    const meter = screen.getByRole('progressbar', { name: 'USDC budget used' })
    expect(meter.getAttribute('aria-valuenow')).toBe('25')
    // #3806: amounts are always two decimals.
    expect(screen.getByText('1.25 of 5.00 USDC · per day · refills in 14h')).toBeTruthy()
  })

  it('says "expires" when the budget ends before its period does', () => {
    mockGet.mockReturnValue([
      budget({
        remaining_atomic: '5000000',
        remaining_from_chain: true,
        period_end: '2026-09-08T12:00:00Z',
        // Ends 2h after the frozen clock — before the 02:00Z boundary would
        // refill it, so "expires" is the next event.
        expires_at: Math.floor(Date.parse('2026-09-01T14:00:00Z') / 1000),
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('0.00 of 5.00 USDC · per day · expires in 2h')).toBeTruthy()
  })

  it('a read whose period has already ended shows unknown — the old amount is never paired with the next refill', () => {
    mockGet.mockReturnValue([
      budget({
        remaining_atomic: '4000000',
        remaining_from_chain: true,
        // A daily period whose end the read put 2h in the past: the used
        // amount belongs to a FINISHED period, so it renders as unknown until
        // the next read — never paired with the next boundary.
        period_end: '2026-09-01T10:00:00Z',
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText(/couldn.t be read/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/expired|refills|used this period/)
  })

  it('a failed chain read shows no meter and says so — never "0 used", never "snapshot"', () => {
    mockGet.mockReturnValue([
      budget({ remaining_atomic: '5000000', remaining_from_chain: false, period_end: '2026-09-02T02:00:00Z' }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText(/couldn.t be read/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/snapshot|0 of 5/)
  })

  it('a row with no remaining figure renders no meter and no caption', () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/used this period|couldn.t be read/)).toBeNull()
  })

  it('with an active budget the grant form is not mounted until Add budget; Cancel collapses it', () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.queryByLabelText('Budget amount')).toBeNull()
    expect(screen.queryByText('Set budget')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(screen.getByLabelText('Budget amount')).toBeTruthy()
    expect(screen.getByText('Set budget')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Budget amount')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add budget' })).toBeTruthy()
  })

  it('with no active budget the collapsed state reads "No budget yet." and Set budget opens the form (#4226)', () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    // Collapsed by default — the mockup's needs-setup state — with the
    // opener; the form's heading appears once it is opened.
    expect(screen.getByText('No budget yet.')).toBeTruthy()
    expect(screen.queryByText('Set its first budget')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    expect(screen.getByText('Set its first budget')).toBeTruthy()
    expect(screen.getByLabelText('Budget amount')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add budget' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  // #3695 review S1: an `active` row past its `expires_at` cannot spend — it
  // must not count down "expires in 1m" forever, nor carry a usage meter.
  it('a budget past its expiry says it has expired — no meter, no countdown', () => {
    mockGet.mockReturnValue([
      budget({
        remaining_atomic: '4000000',
        remaining_from_chain: true,
        period_end: '2026-09-01T10:00:00Z',
        is_live: false,
        expires_at: Math.floor(Date.parse('2026-08-31T00:00:00Z') / 1000),
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('This budget has expired and can no longer be spent.')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.body.textContent).not.toMatch(/expires in|refills in|used this period/)
  })

  // #3802: an expired row keeps its "expired" line but does NOT count toward
  // hasActive — the grant form shows for an agent whose only budget expired,
  // exactly as for one that was never granted (#3695's gate on the row's
  // bookkeeping `active` status alone is not the owner predicate).
  it('an expired-ONLY row keeps its expired line AND shows the grant form (it does not count toward hasActive)', () => {
    mockGet.mockReturnValue([
      budget({
        remaining_atomic: '4000000',
        remaining_from_chain: true,
        is_live: false,
        expires_at: Math.floor(Date.now() / 1000) - 3600,
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('This budget has expired and can no longer be spent.')).toBeTruthy()
    // #4226: the expired-only row does not count toward hasActive, so the
    // collapsed state is the needs-setup one; opening it shows the grant form.
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    expect(screen.getByText('Set its first budget')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add budget' })).toBeNull()
  })

  // #3695 review S2: opening and collapsing swap the pressed control for
  // another, so focus is placed deliberately instead of falling to <body>.
  it('Add budget moves focus to the amount field; Cancel returns it to Add budget', () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Budget amount'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add budget' }))
  })

  it('Cancel sits in the submit row beside Set budget', () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const setBudget = screen.getByRole('button', { name: 'Set budget' })
    expect(cancel.parentElement).toBe(setBudget.parentElement)
  })

  it('a ?grant=-free page load moves no focus — only an owner toggle does', () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('a successful grant collapses the form again', async () => {
    vi.useRealTimers()
    mockGet.mockReturnValue([budget()])
    mockGrant.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Set budget'))
    await waitFor(() => expect(mockGrant).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByLabelText('Budget amount')).toBeNull())
    // ...and focus lands on Add budget, not <body> (#3695 review S2).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add budget' }))
  })
})

// #3716: the sub-budget entry moved from a permanent card row into the Add
// budget panel — below the grant form, visible only while the panel is open.
describe('DelegationBudgetCard sub-budget entry in the Add budget panel (#3716)', () => {
  it('sits below Set budget / Cancel in DOM order once the panel is open', () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    const link = screen.getByRole('button', { name: 'Issue sub-budget' })
    const setBudget = screen.getByRole('button', { name: 'Set budget' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING
    expect(setBudget.compareDocumentPosition(link) & FOLLOWING).toBeTruthy()
    expect(cancel.compareDocumentPosition(link) & FOLLOWING).toBeTruthy()
  })

  it('is absent with the panel open when the only active budget is merchant-pinned', () => {
    mockGet.mockReturnValue([budget({ merchant_id: 'm-1', merchant_slug: 'ampersend-demo-api', merchant_name: 'Ampersend Demo API' })])
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(screen.getByRole('button', { name: 'Set budget' })).toBeTruthy()
    expect(screen.queryByText('Issue sub-budget')).toBeNull()
    expect(screen.queryByText('Or share part of an existing budget with another agent')).toBeNull()
  })

  it('is absent when the form shows by default over a pending-only budget', () => {
    mockGet.mockReturnValue([budget({ status: 'pending', is_live: false })])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('Set budget')).toBeTruthy()
    expect(screen.queryByText('Issue sub-budget')).toBeNull()
    expect(screen.queryByText('Or share part of an existing budget with another agent')).toBeNull()
  })

  // The real hook nulls `budgets` on error (useDelegationBudget), so
  // subBudgetParents is [] there — the rows here keep the fixture one step
  // from vacuous while the clause under test stays `!budgetsError`.
  it('is absent when the budgets read failed, even with the panel open', () => {
    mockGet.mockReturnValue([budget()])
    mockBudgetsError.mockReturnValue(true)
    render(<DelegationBudgetCard {...PROPS} />)
    // #4226: a failed read keeps the form open (#2473's contract) — there is
    // no Add budget button to click, the panel is simply up.
    expect(screen.getByRole('button', { name: 'Set budget' })).toBeTruthy()
    expect(screen.queryByText('Issue sub-budget')).toBeNull()
    expect(screen.queryByText('Or share part of an existing budget with another agent')).toBeNull()
  })

  it('clicking the entry collapses the form, opens the modal inside focus, and returns focus to Add budget on close', async () => {
    mockGet.mockReturnValue([budget()])
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '2' } })
    // act-wrapped: the modal's open/close state lands in effects (its own
    // child effect and the card's focus-restore) that outlive the event.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Issue sub-budget' }))
    })

    // The form is gone; the modal is open with focus INSIDE the dialog (the
    // card's focus effect must not pull it back out).
    expect(screen.queryByLabelText('Budget amount')).toBeNull()
    const dialog = screen.getByRole('dialog', { name: 'Issue sub-budget' })
    expect(dialog.contains(document.activeElement)).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add budget' }))
  })
})

/**
 * #3933: a plain grant into an occupied (token, recipient) slot left the old
 * budget enabled on-chain. The card now routes such a submit to the edit flow
 * (client-side check first, the server's 409 as the fallback), and flags any
 * old budget a past replace left `replaced` but unexpired, with a Stop.
 */
describe('DelegationBudgetCard — occupied slot and replaced-but-enabled budgets (#3933)', () => {
  const PINNED = '0x' + 'cc'.repeat(20)
  const OTHER = '0x' + 'dd'.repeat(20)
  const OLD_HASH = '0x' + '01'.repeat(32)

  async function openFormAndType(amount: string, recipient: string) {
    fireEvent.click(await screen.findByRole('button', { name: 'Add budget' }))
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: amount } })
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: recipient } })
  }

  it('a submit matching a live budget opens the edit flow with the typed limits — no plain grant is signed', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: PINNED })])
    render(<DelegationBudgetCard {...PROPS} />)
    await openFormAndType('10', PINNED)
    // The hint says what happens on-chain before anything is signed.
    expect(screen.getByText(/so you edit it: you approve the new budget, then approve once more to stop the old one\. The review step shows how many approvals that takes\./)).toBeTruthy()
    expect(screen.getByText(/Stopping it ends any open task budget or sub-budget taken from it/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit existing budget' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    expect(mockGrant).not.toHaveBeenCalled()
    // The edit opened on THIS budget, with what the owner typed.
    expect((within(dialog).getByLabelText('Budget amount') as HTMLInputElement).value).toBe('10')
    expect(within(dialog).getByText(/already has a budget for this token and recipient/)).toBeTruthy()
    // Never the generic failure.
    expect(screen.queryByText(/Haven could not set the budget/)).toBeNull()
  })

  it('a submit into an EMPTY slot (another recipient) still grants as before', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: PINNED })])
    mockGrant.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    await openFormAndType('10', OTHER)
    expect(screen.getByText('One approval. Refills every period automatically.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    await waitFor(() => expect(mockGrant).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: 'Edit budget' })).toBeNull()
  })

  it('an EXPIRED budget in the slot does not occupy it — the submit grants', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: PINNED, expires_at: 1, is_live: false })])
    mockGrant.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    // An expired-only agent's collapsed needs-setup state opens to the form (#3802, #4226).
    await openGrantForm()
    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: PINNED } })
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    await waitFor(() => expect(mockGrant).toHaveBeenCalled())
  })

  it("server fallback: the client check missed (stale list), the 409's hash picks the budget once the list has it", async () => {
    const EXISTING = '0x' + 'e1'.repeat(32)
    // The list the card rendered with does not show the occupying budget.
    mockGet.mockReturnValue([budget({ recipient_address: PINNED })])
    mockGrant.mockImplementation(async () => {
      // The hook refreshed the list before answering.
      mockGet.mockReturnValue([
        budget({ recipient_address: PINNED }),
        budget({ recipient_address: OTHER, delegation_hash: EXISTING, budget_atomic: '7000000' }),
      ])
      return { ok: false, reason: 'slot_occupied', existingDelegationHash: EXISTING }
    })
    render(<DelegationBudgetCard {...PROPS} />)
    await openFormAndType('10', OTHER)
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    // The budget the server named: 7 USDC, not the other row's 5.
    expect(within(dialog).getByText(/Editing the 7 USDC per day budget/)).toBeTruthy()
    expect(screen.queryByText(/Haven could not set the budget/)).toBeNull()
  })

  it('server fallback with the list not caught up: a named notice and a reload — never the generic failure', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: PINNED })])
    mockGrant.mockResolvedValue({ ok: false, reason: 'slot_occupied', existingDelegationHash: '0x' + 'e1'.repeat(32) })
    render(<DelegationBudgetCard {...PROPS} />)
    await openFormAndType('10', OTHER)
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    await waitFor(() => expect(screen.getByText(/already has a live budget for this token and recipient\. Nothing was approved/)).toBeTruthy())
    expect(screen.queryByText(/Haven could not set the budget/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reload budgets' }))
    expect(mockReload).toHaveBeenCalled()
  })

  it('flags a replaced-but-unexpired budget with what it can still do, and Stops it through the per-hash revoke', async () => {
    mockGet.mockReturnValue([
      budget(),
      budget({ status: 'replaced', is_live: false, delegation_hash: OLD_HASH, budget_atomic: '3000000' }),
    ])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    expect(await screen.findByText('An old budget has not been stopped')).toBeTruthy()
    expect(screen.getByText(/The 3 USDC per day budget to 0xcccc…cccc was replaced, but it can still be spent outside Haven until it is stopped/)).toBeTruthy()
    expect(screen.getByText(/Stopping it also ends any open task budget or sub-budget taken from it/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop old budget 3 USDC per day' }))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith(OLD_HASH))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Old budget stopped.'))
  })

  it('"Already revoked" on the finish action is finished, not an error', async () => {
    mockGet.mockReturnValue([budget(), budget({ status: 'replaced', is_live: false, delegation_hash: OLD_HASH })])
    mockRevoke.mockResolvedValue({ ok: true, alreadyStopped: true })
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: /Stop old budget/ }))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('That old budget was already stopped.'))
    expect(mockToast.error).not.toHaveBeenCalled()
  })

  it('a failed finish action says so', async () => {
    mockGet.mockReturnValue([budget(), budget({ status: 'replaced', is_live: false, delegation_hash: OLD_HASH })])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: /Stop old budget/ }))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Could not stop the old budget. Try again.'))
  })

  it.each([
    ['an expired replaced row', { status: 'replaced', expires_at: 1, is_live: false }],
    ['a revoked row', { status: 'revoked', is_live: false }],
    ['a pending row', { status: 'pending', is_live: false }],
  ])('no flag for %s', async (_label, overrides) => {
    mockGet.mockReturnValue([budget(), budget({ delegation_hash: OLD_HASH, ...overrides })])
    render(<DelegationBudgetCard {...PROPS} />)
    await screen.findByText('Spending')
    expect(screen.queryByText('An old budget has not been stopped')).toBeNull()
  })

  it('a retired agent shows no flag — its Finish revoking (revoke-all) already covers replaced rows', async () => {
    mockGet.mockReturnValue([budget(), budget({ status: 'replaced', is_live: false, delegation_hash: OLD_HASH })])
    render(<DelegationBudgetCard {...PROPS} retired="revoked" />)
    await screen.findByText('Spending')
    expect(screen.queryByText('An old budget has not been stopped')).toBeNull()
  })
})

// #3922: "ends" is only for a row the server calls live (or a still-pending
// unexpired slice). A closed row with a FUTURE expiry reads "closed" (#3923:
// status wins over expiry), not a countdown as if it were running.
describe('DelegationBudgetCard sub-budget "ends" follows is_live (#3922)', () => {
  const future = Math.floor(Date.now() / 1000) + 7 * 86_400
  const sub = (overrides: Record<string, unknown>) => ({
    id: 's1', agent_id: 'agent-2', parent_agent_id: 'agent-1', parent_sub_budget_id: null, chain_id: 84532,
    token_address: USDC, recipient_address: null, parent_delegation_hash: '0x' + 'ab'.repeat(32),
    delegation_hash: '0x' + 'ee'.repeat(32), label: 'Scraper slice', period_amount_atomic: '2000000',
    status: 'open', expires_at: future, is_expired: false, is_live: true,
    created_at: '2026-01-01T00:00:00Z', opened_at: '2026-01-01T00:00:00Z', closed_at: null, close_tx_hash: null,
    ...overrides,
  })
  const tree = (grant: Record<string, unknown>) => [{
    parent_child_sub_budget: sub({ id: 'p1', label: 'Parent narrowing' }),
    grants: [grant],
  }]

  it('a live grant reads "ends …"', () => {
    mockGet.mockReturnValue([budget()])
    mockTrees.mockReturnValue(tree(sub({})))
    render(<DelegationBudgetCard {...PROPS} />)
    expect(document.body.textContent).toMatch(/up to 2 USDC · ends /)
  })

  it('a closed grant with a future expiry reads "closed", never "ends" or "ended"', () => {
    mockGet.mockReturnValue([budget()])
    mockTrees.mockReturnValue(tree(sub({ status: 'closed', is_live: false })))
    render(<DelegationBudgetCard {...PROPS} />)
    expect(document.body.textContent).toMatch(/up to 2 USDC · closed/)
    expect(document.body.textContent).not.toMatch(/up to 2 USDC · ends/)
  })

  it('a closed parent narrowing row reads "closed" too; an expired non-closed grant keeps "ended"', () => {
    mockGet.mockReturnValue([budget()])
    mockTrees.mockReturnValue([{
      parent_child_sub_budget: sub({ id: 'p1', label: 'Parent narrowing', status: 'closed', is_live: false, period_amount_atomic: '5000000' }),
      grants: [sub({ status: 'open', is_live: false, is_expired: true, expires_at: Math.floor(Date.now() / 1000) - 60 })],
    }])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(document.body.textContent).toMatch(/5 USDC · closed/)
    expect(document.body.textContent).toMatch(/up to 2 USDC · ended/)
  })

  it('a pending, unexpired grant still shows when it ends, beside "waiting for the sharing agent to sign it"', () => {
    mockGet.mockReturnValue([budget()])
    mockTrees.mockReturnValue(tree(sub({ status: 'pending', is_live: false })))
    render(<DelegationBudgetCard {...PROPS} />)
    expect(document.body.textContent).toMatch(/up to 2 USDC · ends .*waiting for the sharing agent to sign it/)
  })
})

// #3988: the holder's side — the read-only "Received budgets" block and an
// empty state that never implies a grant holder cannot pay.
describe('DelegationBudgetCard received budgets (#3988)', () => {
  const receivedGrant = {
    id: 'g1',
    agent_id: 'agent-1',
    parent_agent_id: 'p1',
    parent_agent_name: 'Agent naming',
    parent_sub_budget_id: 'pc1',
    chain_id: 84532,
    token_address: USDC,
    recipient_address: null,
    parent_delegation_hash: '0x' + 'ab'.repeat(32),
    delegation_hash: '0x' + 'ef'.repeat(32),
    label: null,
    period_amount_atomic: '25000000',
    status: 'open',
    expires_at: 9_999_999_999,
    is_expired: false,
    is_live: true,
    created_at: '2026-09-01T00:00:00Z',
    opened_at: '2026-09-01T00:00:00Z',
    closed_at: null,
    close_tx_hash: null,
  }

  it('lists each received grant with the parent agent, amount per period and its end', () => {
    mockReceivedGrants.mockReturnValue([receivedGrant])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('Received budgets')).toBeTruthy()
    expect(screen.getByText('From Agent naming')).toBeTruthy()
    const row = screen.getByText('From Agent naming').closest('div')?.parentElement ?? null
    expect(row?.textContent).toContain('25 USDC')
    expect(row?.textContent).toMatch(/ends /)
  })

  it('words a pending grant as not-yet-signed, not as live authority', () => {
    mockReceivedGrants.mockReturnValue([{ ...receivedGrant, status: 'pending', is_live: false }])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('From Agent naming')).toBeTruthy()
    expect(screen.getByText(/waiting for the sharing agent to sign it/)).toBeTruthy()
  })

  it('renders nothing when the agent has received nothing (never an empty section)', () => {
    mockReceivedGrants.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.queryByText('Received budgets')).toBeNull()
  })

  it('the no-own-budget empty state does not imply a grant holder cannot pay', () => {
    mockReceivedGrants.mockReturnValue([receivedGrant])
    render(<DelegationBudgetCard {...PROPS} />)
    // #4226: the received-budget nuance lives on the form's own line — open it.
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    expect(screen.getByText('Set its first budget')).toBeTruthy()
    expect(screen.getByText(/spends through the received budgets below/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('The agent can start paying within it.')
  })

  it('keeps the original empty-state line when nothing has been received', () => {
    mockReceivedGrants.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }))
    expect(screen.getByText('The agent can start paying within it.')).toBeTruthy()
  })
})

/**
 * #4154: between the edit's two approvals the old row reads `replaced`, and
 * the card's background poll showed "An old budget has not been stopped"
 * behind the still-open modal. The notice now stands down for the slot the
 * edit flow owns, and only while it owns it — any close that leaves the old
 * budget enabled shows it at once.
 */
describe('DelegationBudgetCard — no replaced-budget flash during an edit (#4154)', () => {
  const OLD_HASH = '0x' + 'ab'.repeat(32)
  const NEW_HASH = '0x' + 'be'.repeat(32)
  const OTHER = '0x' + 'dd'.repeat(20)
  const NOTICE = 'An old budget has not been stopped'

  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  /** The old row `replaced`, the new one live — what a poll sees after approval 1. */
  const afterActivate = (extra: Record<string, unknown>[] = []) => [
    budget({ delegation_hash: NEW_HASH, budget_atomic: '10000000' }),
    budget({ delegation_hash: OLD_HASH, status: 'replaced', is_live: false }),
    ...extra.map((o) => budget(o)),
  ]

  /** Opens the edit on the live budget and signs approval 1; the edit resolves when the test says. */
  async function startEdit() {
    const edit = deferred<unknown>()
    mockEdit.mockReturnValue(edit.promise)
    mockGet.mockReturnValue([budget({ delegation_hash: OLD_HASH })])
    const view = render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit budget 5 USDC per day' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    fireEvent.change(within(dialog).getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review changes' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve new budget' }))
    await waitFor(() => expect(mockEdit).toHaveBeenCalled())
    return { view, edit, dialog }
  }

  it('the old row reading `replaced` mid-edit shows no notice behind the open modal', async () => {
    const { view, edit } = await startEdit()
    // The background poll lands between the two approvals.
    mockGet.mockReturnValue(afterActivate())
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByRole('dialog', { name: 'Edit budget' })).toBeTruthy()
    expect(screen.queryByText(NOTICE)).toBeNull()
    await act(async () => edit.resolve({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: true }))
  })

  it('a replaced row in ANOTHER slot keeps its notice while the modal is open', async () => {
    const { view, edit } = await startEdit()
    mockGet.mockReturnValue(
      afterActivate([{ delegation_hash: '0x' + '07'.repeat(32), recipient_address: OTHER, status: 'replaced', is_live: false, budget_atomic: '3000000' }]),
    )
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getAllByText(NOTICE)).toHaveLength(1)
    expect(screen.getByText(/The 3 USDC per day budget to 0xdddd…dddd was replaced/)).toBeTruthy()
    await act(async () => edit.resolve({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: true }))
  })

  it('a leftover `replaced` row in the SAME slot that this edit does not Stop keeps its notice while the modal is open', async () => {
    // An earlier abandoned edit left A `replaced` in B's slot. Editing B
    // Stops only B (the Stop set is the slot's LIVE rows), so A's warning is
    // genuine the whole time.
    const LEFTOVER = '0x' + '0a'.repeat(32)
    const edit = deferred<unknown>()
    mockEdit.mockReturnValue(edit.promise)
    mockGet.mockReturnValue([
      budget({ delegation_hash: OLD_HASH }),
      budget({ delegation_hash: LEFTOVER, status: 'replaced', is_live: false, budget_atomic: '3000000' }),
    ])
    const view = render(<DelegationBudgetCard {...PROPS} />)
    expect(await screen.findByText(NOTICE)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit budget 5 USDC per day' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    // Already on the form step, before any approval.
    expect(screen.getAllByText(NOTICE)).toHaveLength(1)
    fireEvent.change(within(dialog).getByLabelText('Budget amount'), { target: { value: '10' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review changes' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve new budget' }))
    await waitFor(() => expect(mockEdit).toHaveBeenCalled())
    mockGet.mockReturnValue(afterActivate([{ delegation_hash: LEFTOVER, status: 'replaced', is_live: false, budget_atomic: '3000000' }]))
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    // B's own `replaced` row is hidden; A's stays.
    expect(screen.getAllByText(NOTICE)).toHaveLength(1)
    expect(screen.getByText(/The 3 USDC per day budget to 0xcccc…cccc was replaced/)).toBeTruthy()
    await act(async () => edit.resolve({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: true }))
  })

  it('closing with the Stop not done shows the notice at once — no reload needed', async () => {
    const { view, edit } = await startEdit()
    mockGet.mockReturnValue(afterActivate())
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    await act(async () =>
      edit.resolve({ ok: false, reason: 'revoke_unfinished', newDelegationHash: NEW_HASH, unstoppedDelegationHashes: [OLD_HASH], moved: false }),
    )
    // The modal's own step-2 screen says it first…
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    expect(within(dialog).getByText('New budget is live — one step left')).toBeTruthy()
    expect(screen.queryByText(NOTICE)).toBeNull()
    // …and the card says it the moment the modal is gone.
    // The footer Close (the header has its own ✕, also named Close).
    const closes = within(dialog).getAllByRole('button', { name: 'Close' })
    fireEvent.click(closes[closes.length - 1])
    expect(screen.queryByRole('dialog', { name: 'Edit budget' })).toBeNull()
    expect(screen.getByText(NOTICE)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop old budget 5 USDC per day' })).toBeTruthy()
  })

  it('a finished edit shows no notice while the reload after close settles, nor after it reads the row revoked', async () => {
    const { view, edit } = await startEdit()
    mockGet.mockReturnValue(afterActivate())
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    await act(async () => edit.resolve({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: true }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    await within(dialog).findByText('Budget updated')
    const reloadAfterClose = deferred<void>()
    mockReload.mockReset()
    mockReload.mockReturnValue(reloadAfterClose.promise)
    // The list the card holds still predates the Stop.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(mockReload).toHaveBeenCalled()
    expect(screen.queryByText(NOTICE)).toBeNull()
    mockGet.mockReturnValue([
      budget({ delegation_hash: NEW_HASH, budget_atomic: '10000000' }),
      budget({ delegation_hash: OLD_HASH, status: 'revoked', is_live: false }),
    ])
    await act(async () => reloadAfterClose.resolve())
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it("a step-2 Stop finished from the modal's own screen counts as finished too", async () => {
    const { view, edit } = await startEdit()
    mockGet.mockReturnValue(afterActivate())
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    await act(async () =>
      edit.resolve({ ok: false, reason: 'revoke_unfinished', newDelegationHash: NEW_HASH, unstoppedDelegationHashes: [OLD_HASH], moved: false }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    mockRevoke.mockResolvedValue({ ok: true })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop old budget' }))
    await within(dialog).findByText('Budget updated')
    expect(mockRevoke).toHaveBeenCalledWith(OLD_HASH)
    const reloadAfterClose = deferred<void>()
    mockReload.mockReset()
    mockReload.mockReturnValue(reloadAfterClose.promise)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(mockReload).toHaveBeenCalled()
    expect(screen.queryByText(NOTICE)).toBeNull()
    await act(async () => reloadAfterClose.resolve())
  })

  it('reopening Edit before the reload after a finished edit settles does not bring the flash back', async () => {
    const { view, edit } = await startEdit()
    mockGet.mockReturnValue(afterActivate())
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    await act(async () => edit.resolve({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: true }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    await within(dialog).findByText('Budget updated')
    const reloadAfterClose = deferred<void>()
    mockReload.mockReset()
    mockReload.mockReturnValue(reloadAfterClose.promise)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    // Straight back into Edit on the NEW budget, the stale list still in hand.
    fireEvent.click(screen.getByRole('button', { name: 'Edit budget 10 USDC per day' }))
    await screen.findByRole('dialog', { name: 'Edit budget' })
    expect(screen.queryByText(NOTICE)).toBeNull()
    await act(async () => reloadAfterClose.resolve())
  })

  it('a finished edit whose reload still reads the row `replaced` shows the notice — the server has the last word', async () => {
    const { view, edit } = await startEdit()
    mockGet.mockReturnValue(afterActivate())
    view.rerender(<DelegationBudgetCard {...PROPS} />)
    await act(async () => edit.resolve({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: true }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit budget' })
    await within(dialog).findByText('Budget updated')
    mockReload.mockReset()
    mockReload.mockResolvedValue(undefined)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText(NOTICE)).toBeTruthy()
  })
})

describe('DelegationBudgetCard hero states (#4226)', () => {
  const NOW = Date.parse('2026-09-01T12:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const withSearch = (search: string) => {
    const original = window.location
    // @ts-expect-error — jsdom permits the delete/delete-then-assign dance.
    delete window.location
    // @ts-expect-error — see above.
    window.location = new URL(`https://app.haven.test/agents/agent-1${search}`) as unknown as Location
    return () => {
      // @ts-expect-error — see above.
      window.location = original
    }
  }

  // A live row with a chain read: 5 USDC/day, 1.25 used this period.
  const heroBudget = () =>
    budget({
      remaining_atomic: '3750000',
      remaining_from_chain: true,
      period_end: '2026-09-02T02:00:00Z',
    })

  const spendWindow = (usd: number, payments: number) => ({
    gross: { usd, eur: usd, sek: usd * 10 },
    net: { usd, eur: usd, sek: usd * 10 },
    approx: false,
    payments,
    refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
  })

  const stats: DashboardAgentStats = {
    d7: spendWindow(1, 1),
    d30: spendWindow(12.5, 7),
    lastPaymentAt: '2026-08-30T10:00:00Z',
    lastCounterparty: {
      source: 'x402',
      x402ResourceUrl: 'https://api.bitrefill.com/buy',
      to: '0x' + 'ab'.repeat(20),
      merchantName: null,
    },
  }

  it('several budgets render a row each, with a meter and a menu per budget', () => {
    mockGet.mockReturnValue([
      heroBudget(),
      budget({
        id: 'b2',
        delegation_hash: '0x' + 'ee'.repeat(32),
        budget_atomic: '10000000',
        remaining_atomic: '8000000',
        remaining_from_chain: true,
        period_end: '2026-09-02T02:00:00Z',
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getAllByRole('progressbar', { name: 'USDC budget used' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^Budget options / })).toHaveLength(2)
  })

  it('a budget at or past 90% used renders the warning meter', () => {
    mockGet.mockReturnValue([
      budget({ remaining_atomic: '400000', remaining_from_chain: true, period_end: '2026-09-02T02:00:00Z' }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    const meter = screen.getByRole('progressbar', { name: 'USDC budget used' })
    expect(meter.getAttribute('aria-valuenow')).toBe('92')
    const fill = meter.querySelector('div')
    expect(fill?.className).toContain('bg-warning')
  })

  it('a paused agent greys the meter and adds the shared pause line; the caption itself is unchanged', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} agentStatus="paused" />)
    const fill = screen.getByRole('progressbar', { name: 'USDC budget used' }).querySelector('div')
    expect(fill?.className).toContain('bg-[var(--v2-ink-3)]')
    expect(screen.getByText(AGENT_PAUSED_SHORT)).toBeTruthy()
    expect(screen.getByText('1.25 of 5.00 USDC · per day · refills in 14h')).toBeTruthy()
  })

  it("an active agent's hero caption is the dashboard row's caption, verbatim", () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} />)
    // AgentRow renders `budgetCaption(row, { nowMs, style: 'row' })` for the
    // dashboard row. Building the same caption the hero's mapping feeds and
    // asserting the hero renders exactly that string pins the parity the
    // issue demands: one helper, one style, no drift between the surfaces.
    const caption = budgetCaption(
      {
        token: USDC,
        recipient: '0x' + 'cc'.repeat(20),
        startSec: Number('1788228000'),
        periodSeconds: 86_400,
        expiresSec: 9_999_999_999,
        isLive: true,
        budgetAtomic: '5000000',
        usedAtomic: '1250000',
        readFromChain: true,
        periodEndMs: Date.parse('2026-09-02T02:00:00Z'),
        createdMs: Date.parse('2026-09-01T00:00:00Z'),
        symbol: 'USDC',
        chainId: 84532,
      },
      { nowMs: NOW, style: 'row' },
    )
    expect(caption.kind).toBe('meter')
    // The rendered caption IS the helper's row-style output — compared raw
    // (the formatter puts an nbsp between the number and the symbol, which
    // getByText's normalizer does not preserve on the matcher side).
    const meter = screen.getByRole('progressbar', { name: 'USDC budget used' })
    expect(meter.parentElement?.textContent).toBe((caption as { caption: string }).caption)
  })

  // #4260: the figure cell is the <dd> under the named <dt>.
  const figure = (label: string) => {
    const term = screen.getByText(label, { selector: 'dt' })
    return term.nextElementSibling as HTMLElement
  }

  it('the Last 30 days column shows Spent, Payments and Last paid as three labelled figures (#4260)', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} stats={stats} />)
    expect(screen.getByText('Last 30 days')).toBeTruthy()
    const grid = screen.getByText('Spent', { selector: 'dt' }).closest('dl')!
    // Plain matchers over the class list, so a miss is an AssertionError.
    expect([...grid.classList]).toEqual(expect.arrayContaining(['grid', 'grid-cols-3']))
    expect(grid.querySelectorAll(':scope > div')).toHaveLength(3)
    // Spent is Amount size="md": text-xl on the Amount span itself (#4259).
    const spent = within(figure('Spent')).getByText(/12\.50/)
    expect([...spent.classList]).toContain('text-xl')
    expect([...spent.classList]).not.toContain('text-sm')
    expect(figure('Payments').textContent).toBe('7')
    expect([...figure('Payments').classList]).toContain('text-xl')
    expect(figure('Last paid').textContent).toBe(timeAgo('2026-08-30T10:00:00Z'))
    expect([...figure('Last paid').classList]).toContain('text-xl')
    // The 30px headline the column used to carry is gone; the balance is the headline.
    expect(grid.closest('section')?.querySelector('.text-3xl')).toBeNull()
  })

  it('the merchant sits on its own line below the figures, with no divider (#4260)', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} stats={stats} />)
    // #4209's helper: the merchant NAME, else the x402 host — never the
    // recipient address the counterparty also carries.
    const line = screen.getByText('Last paid to api.bitrefill.com')
    expect(line.tagName).toBe('P')
    expect(line.className).not.toMatch(/\bborder/)
    expect(line.closest('dl')).toBeNull()
    expect(document.body.textContent).not.toContain('0x' + 'ab'.repeat(20))
  })

  it('with no merchant label the merchant line is omitted (#4260)', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(
      <DelegationBudgetCard
        {...PROPS}
        stats={{
          ...stats,
          lastCounterparty: { source: 'direct', x402ResourceUrl: null, to: '0x' + 'ab'.repeat(20), merchantName: null },
        }}
      />,
    )
    expect(figure('Last paid').textContent).toBe(timeAgo('2026-08-30T10:00:00Z'))
    expect(screen.queryByText(/Last paid to/)).toBeNull()
  })

  it('no payments in 30 days but an older one: the empty line, then when and to whom (#4260)', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} stats={{ ...stats, d30: spendWindow(0, 0) }} />)
    expect(screen.queryByText('No payments in the last 30 days.')).not.toBeNull()
    expect(screen.queryByText(`Last paid ${timeAgo('2026-08-30T10:00:00Z')} to api.bitrefill.com`)).not.toBeNull()
    expect(screen.queryByText('Spent', { selector: 'dt' })).toBeNull()
  })

  it('no payments in 30 days and never paid: the empty line alone (#4260)', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(
      <DelegationBudgetCard
        {...PROPS}
        stats={{ ...stats, d30: spendWindow(0, 0), lastPaymentAt: null, lastCounterparty: null }}
      />,
    )
    expect(screen.queryByText('No payments in the last 30 days.')).not.toBeNull()
    expect(screen.queryByText(/Last paid/)).toBeNull()
    expect(screen.queryByText('Spent', { selector: 'dt' })).toBeNull()
  })

  it('while the overview read is in flight the column reserves its shape with a skeleton', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} statsLoading />)
    const skeleton = screen.getByLabelText('Loading the last 30 days')
    // #4260: three label-and-value bar pairs, the shape of the figures.
    expect(skeleton.querySelector('.grid-cols-3')?.children).toHaveLength(3)
  })

  it('a retired agent renders no Last 30 days column, even when handed stats', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} retired="revoked" stats={stats} />)
    expect(screen.queryByText('Last 30 days')).toBeNull()
  })

  it('anchors #delegation-budget-card so page affordances can scroll to it', () => {
    mockGet.mockReturnValue([heroBudget()])
    render(<DelegationBudgetCard {...PROPS} />)
    // The id is the PAGE's wrapper (AgentDetailClient), asserted there; the
    // card's contract here is the export itself.
    expect(DELEGATION_BUDGET_CARD_ID).toBe('delegation-budget-card')
  })

  it('?grant= opens the budget expanded alongside the page tab parameter', async () => {
    // Both parameters ride one URL: the card reads ?grant= from the window
    // itself, so a hand-off link that lands with a tab keeps working.
    const restore = withSearch(`?grant=${'0x' + 'cd'.repeat(32)}&tab=activity`)
    try {
      mockGet.mockReturnValue([
        heroBudget(),
        budget({
          id: 'b2',
          delegation_hash: '0x' + 'cd'.repeat(32),
          status: 'pending',
          is_live: false,
          recipient_address: null,
          budget_atomic: '7000000',
        }),
      ])
      render(<DelegationBudgetCard {...PROPS} />)
      await waitFor(() => expect((screen.getByLabelText('Budget amount') as HTMLInputElement).value).toBe('7'))
      expect(screen.getByText('Set budget')).toBeTruthy()
    } finally {
      restore()
    }
  })
})
