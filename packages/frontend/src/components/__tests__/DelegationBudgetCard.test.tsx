import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

const { mockGet, mockGrant, mockRevoke, mockReload, mockBudgetsError, mockTaskBudgets, mockHookArgs, mockToast } =
  vi.hoisted(() => ({
  mockHookArgs: vi.fn(),
  mockGet: vi.fn(),
  mockGrant: vi.fn(),
  mockRevoke: vi.fn(),
  mockReload: vi.fn(),
  mockBudgetsError: vi.fn(() => false),
  mockTaskBudgets: vi.fn(() => [] as unknown[]),
  // Shared so the revoke-toast tests can assert on it; the component only
  // ever calls the namespaced methods (success/info/error).
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: (...args: unknown[]) => {
    mockHookArgs(...args)
    return {
    budgets: mockGet(),
    grant: mockGrant,
    revoke: mockRevoke,
    busy: false,
    ready: true,
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
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

const DelegationBudgetCard = (await import('../DelegationBudgetCard')).default

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
    delegation_hash: '0x' + 'ab'.repeat(32), version: 1, status: 'active',
    budget_atomic: '5000000', period_seconds: 86_400, expires_at: 9_999_999_999,
    ...overrides,
  }
}

function taskBudget(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1', agent_id: 'agent-1', chain_id: 84532, token_address: USDC,
    recipient_address: null, parent_delegation_hash: '0x' + 'ab'.repeat(32),
    delegation_hash: '0x' + 'dd'.repeat(32), label: null, max_atomic: '1000000',
    status: 'open', expires_at: Math.floor(Date.now() / 1000) + 3600, is_expired: false,
    created_at: '2026-01-01T00:00:00Z', opened_at: '2026-01-01T00:00:00Z',
    closed_at: null, close_tx_hash: null,
    ...overrides,
  }
}

beforeEach(() => {
  mockGet.mockReset()
  mockGrant.mockReset()
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
    mockGet.mockReturnValue([budget({ status: 'pending' })])
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

  // ── #3717: Stop budget, behind a confirm ──
  // Stopping ends an irreversible on-chain delegation, so the row's button
  // now opens the ConfirmDialog with the owner copy and only the dialog's
  // confirm reaches the signature.

  it('Stop budget opens the confirm with the owner copy; no signature until confirmed', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    const stop = await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' }))
    fireEvent.click(stop)
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
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' })))
    expect(screen.getByRole('heading', { name: 'Stop this budget?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull()
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('the Stop confirm falls back to the row label for an off-list period and an unknown token', async () => {
    mockGet.mockReturnValue([budget({ period_seconds: 3_600 })])
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC every 3600s' })))
    expect(screen.getByText(/from this 5 USDC every 3600s budget\./)).toBeTruthy()

    mockGet.mockReturnValue([budget({ budget_atomic: '5' })])
    const { unmount } = render(<DelegationBudgetCard {...PROPS} tokens={[]} />)
    // An unknown token has no decimals, so the row shows the raw atomic
    // amount — its own fallback, without the slash form.
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 per day' })))
    expect(screen.getByText(/from this 5 per day budget\./)).toBeTruthy()
    unmount()
  })

  it('a successful stop toasts "Budget stopped." and closes the confirm', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' })))
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Budget stopped.'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull())
  })

  it('a cancelled signature toasts "Signature was cancelled." and closes the confirm', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'cancelled' })
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' })))
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('Signature was cancelled.'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull())
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it('a failed stop toasts the retry line and closes the confirm', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<DelegationBudgetCard {...PROPS} />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' })))
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Could not stop the budget. Try again.'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stop this budget?' })).toBeNull())
  })

  it('notifies onBudgetChange after a successful revoke — the page summary reads a different source (#1090)', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    const onBudgetChange = vi.fn()
    render(<DelegationBudgetCard {...PROPS} onBudgetChange={onBudgetChange} />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' })))
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(onBudgetChange).toHaveBeenCalled())
  })

  it('does NOT notify onBudgetChange when the revoke fails', async () => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: false, reason: 'failed' })
    const onBudgetChange = vi.fn()
    render(<DelegationBudgetCard {...PROPS} onBudgetChange={onBudgetChange} />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' })))
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
      await waitFor(() => expect(screen.getByText('Set budget')).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText(/2 USDC reserved for task budgets/)).toBeTruthy())
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
    expect(screen.getByRole('button', { name: 'Stop budget 5 USDC per day' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/delegation|caveat|redemption|userop|permission/i)
  })

  it.each(['revoked', 'archived'] as const)('%s: Stop stays available and still ends the budget', async (retired) => {
    mockGet.mockReturnValue([budget()])
    mockRevoke.mockResolvedValue({ ok: true })
    render(<DelegationBudgetCard {...PROPS} retired={retired} />)
    const stop = await waitFor(() => screen.getByRole('button', { name: 'Stop budget 5 USDC per day' }))
    expect((stop as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(stop)
    fireEvent.click(screen.getByRole('button', { name: 'Stop budget' }))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('0x' + 'ab'.repeat(32)))
  })

  it('keeps the task-budget list read-only on a retired agent', async () => {
    mockGet.mockReturnValue([budget({ recipient_address: null })])
    mockTaskBudgets.mockReturnValue([taskBudget({ max_atomic: '2000000' })])
    render(<DelegationBudgetCard {...PROPS} retired="revoked" />)
    await waitFor(() => expect(screen.getByText('Task budgets')).toBeTruthy())
    expect(screen.getByText(/2 USDC reserved for task budgets/)).toBeTruthy()
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
    expect(screen.getByText('1.25 of 5 USDC used this period · refills in 14h')).toBeTruthy()
  })

  it('says "expires" when the budget ends before its period does', () => {
    mockGet.mockReturnValue([
      budget({
        remaining_atomic: '5000000',
        remaining_from_chain: true,
        period_end: '2026-09-08T12:00:00Z',
        expires_at: Math.floor(Date.parse('2026-09-04T12:00:00Z') / 1000),
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('0 of 5 USDC used this period · expires in 3 days')).toBeTruthy()
  })

  it('rolls a stale period_end forward instead of saying it already passed', () => {
    mockGet.mockReturnValue([
      budget({
        remaining_atomic: '4000000',
        remaining_from_chain: true,
        // A daily period whose end the read put 2h in the past: the next
        // boundary is 22h away.
        period_end: '2026-09-01T10:00:00Z',
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('1 of 5 USDC used this period · refills in 22h')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/expired/)
  })

  it('a failed chain read shows no meter and says so — never "0 used", never "snapshot"', () => {
    mockGet.mockReturnValue([
      budget({ remaining_atomic: '5000000', remaining_from_chain: false, period_end: '2026-09-02T02:00:00Z' }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText(/couldn.t be read from the chain/)).toBeTruthy()
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

  it('with no active budget the form is open, headed "Set its first budget"', () => {
    mockGet.mockReturnValue([])
    render(<DelegationBudgetCard {...PROPS} />)
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
        expires_at: Math.floor(Date.parse('2026-08-31T00:00:00Z') / 1000),
      }),
    ])
    render(<DelegationBudgetCard {...PROPS} />)
    expect(screen.getByText('This budget has expired and can no longer be spent.')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.body.textContent).not.toMatch(/expires in|refills in|used this period/)
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
    mockGet.mockReturnValue([budget({ status: 'pending' })])
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
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
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
