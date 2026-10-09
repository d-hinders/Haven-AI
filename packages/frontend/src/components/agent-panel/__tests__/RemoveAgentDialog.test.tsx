/**
 * #1402: the remove orchestration's failure-order contract.
 *
 * One action, three effects, and the order is the safety property: budgets
 * die FIRST (the only step that can fail without consequence), so no path
 * can produce a dead credential next to a live on-chain budget. These tests
 * drive each failure point and assert what the user is told and what is
 * (and is not) called.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Agent } from '@/hooks/useAgents'
// #3544: the dialog tests carry the REAL wire refusal shape — an
// ApiRequestError with the route's status and error_code body.
import { ApiRequestError } from '@/lib/api'

// #3812: the in-flow connect/switch control reads wagmi and RainbowKit, which
// these tests do not provide. Stub it so the test can assert WHEN a flow
// offers it; `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

const { mockRevokeAll, mockBudgetState, mockBalanceState } = vi.hoisted(() => ({
  mockRevokeAll: vi.fn(),
  // `budgets` is the dialog's own delegation list (#3542): the signature is
  // decided from it, never from `agent.status` or `agent.allowances`. `null` is
  // "still loading". The signature-expecting tests below get a live row by
  // default (see `beforeEach`) — the agent fixture itself stays allowance-free.
  mockBudgetState: {
    ready: true,
    busy: false,
    budgets: null as null | Array<{ id: string; status: string }>,
    budgetsError: false,
    signersLoading: false,
    signersError: null as string | null,
  },
  mockBalanceState: {
    balance: null as null | Record<string, unknown>,
    hasRecoverableUsdc: false,
    hasStranded: false,
    loading: false,
    refetch: vi.fn(),
  },
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    budgets: mockBudgetState.budgets,
    budgetsError: mockBudgetState.budgetsError,
    grant: vi.fn(),
    revoke: vi.fn(),
    revokeAll: mockRevokeAll,
    busy: mockBudgetState.busy,
    ready: mockBudgetState.ready,
    reload: vi.fn(),
    signersError: mockBudgetState.signersError,
    signersLoading: mockBudgetState.signersLoading,
    reloadSigners: vi.fn(),
  }),
}))
vi.mock('@/hooks/useDelegateBalance', () => ({
  useDelegateBalance: () => mockBalanceState,
}))

const { RemoveAgentDialog } = await import('../RemoveAgentDialog')

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x' + '22'.repeat(20),
    account_id: 'safe-1',
    account_address: '0x' + '11'.repeat(20),
    account_name: 'Main account',
    account_chain_id: 84532,
    status: 'active',
    account_type: 'delegator_hybrid',
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    ...overrides,
  } as Agent
}

function renderDialog(
  agent: Agent,
  callbacks: Partial<{
    onRevokeCredential: () => Promise<void>
    onArchive: () => Promise<void>
    onClose: () => void
  }> = {},
) {
  const onRevokeCredential = callbacks.onRevokeCredential ?? vi.fn().mockResolvedValue(undefined)
  const onArchive = callbacks.onArchive ?? vi.fn().mockResolvedValue(undefined)
  const onClose = callbacks.onClose ?? vi.fn()
  render(
    <RemoveAgentDialog
      agent={agent}
      chainId={84532}
      onRevokeCredential={onRevokeCredential}
      onArchive={onArchive}
      onClose={onClose}
    />,
  )
  return { onRevokeCredential, onArchive, onClose }
}

beforeEach(() => {
  mockRevokeAll.mockReset()
  mockBudgetState.ready = true
  mockBudgetState.busy = false
  mockBudgetState.budgets = [{ id: 'd-1', status: 'active' }]
  mockBudgetState.budgetsError = false
  mockBudgetState.signersLoading = false
  mockBudgetState.signersError = null
  mockBalanceState.balance = null
  mockBalanceState.hasRecoverableUsdc = false
})

describe('RemoveAgentDialog', () => {
  it('happy path: revoke-all → credential revoke → archive → close, in that order', async () => {
    const order: string[] = []
    mockRevokeAll.mockImplementation(async () => {
      order.push('revokeAll')
      return { ok: true }
    })
    const { onClose } = renderDialog(agentFixture(), {
      onRevokeCredential: vi.fn(async () => {
        order.push('credential')
      }),
      onArchive: vi.fn(async () => {
        order.push('archive')
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(order).toEqual(['revokeAll', 'credential', 'archive'])
  })

  it('a rejected signature ABORTS the whole flow: nothing revoked, nothing archived', async () => {
    mockRevokeAll.mockResolvedValue({ ok: false, reason: 'cancelled' })
    const { onRevokeCredential, onArchive, onClose } = renderDialog(agentFixture())

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/the agent was not removed/i),
    )
    expect(onRevokeCredential).not.toHaveBeenCalled()
    expect(onArchive).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // The action stays available for another attempt.
    expect(screen.getByRole('button', { name: 'Remove agent' })).toBeTruthy()
  })

  it('a failed revoke-all also says the budget is still live — no false comfort', async () => {
    mockRevokeAll.mockResolvedValue({ ok: false, reason: 'failed' })
    renderDialog(agentFixture())

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/can still spend within its budget/i),
    )
  })

  it('archive failure AFTER a successful revoke-all reports honestly and offers to finish', async () => {
    mockRevokeAll.mockResolvedValue({ ok: true })
    const { onClose } = renderDialog(agentFixture(), {
      // api.ts throws the backend's raw error string as .message — the dialog
      // must never surface it in this destructive flow (design review, #1424).
      onArchive: vi.fn().mockRejectedValue(new Error('Archive service temporarily unavailable')),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/can no longer spend/i),
    )
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull()
    // The dialog stays open with a finish affordance, never a silent success.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Finish removal' })).toBeTruthy()
  })

  it('an already-revoked agent with NO live delegation skips both the signature and the credential step', async () => {
    mockBudgetState.budgets = []
    const { onRevokeCredential, onArchive, onClose } = renderDialog(
      agentFixture({ status: 'revoked' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockRevokeAll).not.toHaveBeenCalled()
    expect(onRevokeCredential).not.toHaveBeenCalled()
    expect(onArchive).toHaveBeenCalled()
  })

  // #3542 (C): `POST /agents/:id/revoke` only flips the status, so a REVOKED
  // agent can still hold a redeemable budget. Skipping the signature for it
  // archived nothing and 409'd into `filing_failed`.
  it('a revoked agent whose delegation list holds a live row signs, then archives (no credential step)', async () => {
    const order: string[] = []
    mockRevokeAll.mockImplementation(async () => {
      order.push('revokeAll')
      return { ok: true }
    })
    mockBudgetState.budgets = [{ id: 'd-1', status: 'active' }]
    const { onRevokeCredential, onClose } = renderDialog(agentFixture({ status: 'revoked' }), {
      onArchive: vi.fn(async () => {
        order.push('archive')
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(order).toEqual(['revokeAll', 'archive'])
    expect(onRevokeCredential).not.toHaveBeenCalled()
  })

  it('an agent whose only row is `replaced` (allowances: []) still signs — active or revoked', async () => {
    // `allowances` is projected from ACTIVE rows only; a replaced row is still
    // redeemable and is in revoke-all's target set. The revoked case is the one
    // the old status-keyed gate got wrong.
    for (const status of ['active', 'revoked'] as const) {
      mockRevokeAll.mockReset()
      mockRevokeAll.mockResolvedValue({ ok: true })
      mockBudgetState.budgets = [{ id: 'd-1', status: 'replaced' }]
      const onClose = vi.fn()
      const { unmount } = render(
        <RemoveAgentDialog
          agent={agentFixture({ status, allowances: [] })}
          chainId={84532}
          onRevokeCredential={vi.fn().mockResolvedValue(undefined)}
          onArchive={vi.fn().mockResolvedValue(undefined)}
          onClose={onClose}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(mockRevokeAll, status).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it('a list holding only revoked rows needs no signature', async () => {
    mockBudgetState.budgets = [{ id: 'd-1', status: 'revoked' }]
    const { onClose } = renderDialog(agentFixture({ status: 'revoked' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockRevokeAll).not.toHaveBeenCalled()
  })

  it('says "already ended" only once the list has loaded and is empty', () => {
    mockBudgetState.budgets = []
    const { unmount } = render(
      <RemoveAgentDialog
        agent={agentFixture({ status: 'revoked' })}
        chainId={84532}
        onRevokeCredential={vi.fn()}
        onArchive={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(document.body.textContent).toMatch(/spending authority is already ended/i)
    unmount()

    // Still loading: no verdict is claimed either way.
    mockBudgetState.budgets = null
    renderDialog(agentFixture({ status: 'revoked' }))
    expect(document.body.textContent).not.toMatch(/already ended/i)
  })

  it('a live row never says "already ended"', () => {
    mockBudgetState.budgets = [{ id: 'd-1', status: 'active' }]
    renderDialog(agentFixture({ status: 'revoked' }))
    expect(document.body.textContent).not.toMatch(/already ended/i)
    expect(document.body.textContent).toMatch(/you sign once/i)
  })

  it('while the list loads, a signature is still required (Remove waits for a signer)', () => {
    mockBudgetState.budgets = null
    mockBudgetState.ready = false
    renderDialog(agentFixture({ status: 'revoked' }))
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  it('a failed list read keeps the signature required and never says "already ended"', () => {
    mockBudgetState.budgets = null
    mockBudgetState.budgetsError = true
    mockBudgetState.ready = false
    renderDialog(agentFixture({ status: 'revoked' }))
    expect(screen.queryByText(/already ended/i)).not.toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  it('a revoked agent with a live row and no signer is blocked, and told why', () => {
    mockBudgetState.ready = false
    renderDialog(agentFixture({ status: 'revoked' }))
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText(/connect a wallet or use a passkey/i)).toBeTruthy()
    // #3812: revoking never depends on the header — the way out is here.
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('offers no wallet connect while the signer set is still loading (#3812)', () => {
    mockBudgetState.ready = false
    mockBudgetState.signersLoading = true
    renderDialog(agentFixture({ status: 'revoked' }))
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('offers no wallet connect when the signer set failed to load (#3812)', () => {
    mockBudgetState.ready = false
    mockBudgetState.signersError = 'failed'
    renderDialog(agentFixture({ status: 'revoked' }))
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('a ready (passkey) owner is offered no wallet connect (#3812)', () => {
    renderDialog(agentFixture({ status: 'revoked' }))
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('an unlinked revoked agent is not gated behind a signature Haven cannot collect', async () => {
    mockBudgetState.ready = false
    const { onClose, onArchive } = renderDialog(
      agentFixture({ status: 'revoked', account_id: null, live_delegation_count: 1 }),
    )
    expect(document.body.textContent).toMatch(/cannot end its budget from here/i)
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onArchive).toHaveBeenCalled()
    expect(mockRevokeAll).not.toHaveBeenCalled()
  })

  it('tells the caller the budget ended, after the filing steps settle', async () => {
    const order: string[] = []
    mockRevokeAll.mockResolvedValue({ ok: true })
    const onBudgetEnded = vi.fn(() => {
      order.push('ended')
    })
    const onArchive = vi.fn(async () => {
      order.push('archive')
    })
    const onClose = vi.fn()
    render(
      <RemoveAgentDialog
        agent={agentFixture()}
        chainId={84532}
        onRevokeCredential={vi.fn().mockResolvedValue(undefined)}
        onArchive={onArchive}
        onBudgetEnded={onBudgetEnded}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(order).toEqual(['archive', 'ended'])
  })

  it('does NOT tell the caller the budget ended when the signature is cancelled', async () => {
    mockRevokeAll.mockResolvedValue({ ok: false, reason: 'cancelled' })
    const onBudgetEnded = vi.fn()
    render(
      <RemoveAgentDialog
        agent={agentFixture()}
        chainId={84532}
        onRevokeCredential={vi.fn()}
        onArchive={vi.fn()}
        onBudgetEnded={onBudgetEnded}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(onBudgetEnded).not.toHaveBeenCalled()
  })

  describe('finish mode (#3542 D): ends the remaining budget of an already revoked/archived agent', () => {
    function renderFinish(agent: Agent, extra: { onBudgetEnded?: () => void } = {}) {
      const onRevokeCredential = vi.fn().mockResolvedValue(undefined)
      const onArchive = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      render(
        <RemoveAgentDialog
          agent={agent}
          chainId={84532}
          mode="finish"
          onRevokeCredential={onRevokeCredential}
          onArchive={onArchive}
          onBudgetEnded={extra.onBudgetEnded}
          onClose={onClose}
        />,
      )
      return { onRevokeCredential, onArchive, onClose }
    }

    it('speaks of ending the budget, not of moving the agent or stopping its credential', () => {
      renderFinish(agentFixture({ status: 'revoked', live_delegation_count: 1 }))
      expect(screen.getByText('Finish revoking Research agent?')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Finish revoking' })).toBeTruthy()
      const text = document.body.textContent ?? ''
      expect(text).toMatch(/remaining budget ends/i)
      expect(text).not.toMatch(/moves to Removed/i)
      expect(text).not.toMatch(/credential stops working/i)
    })

    it('signs once, leaves the agent where it is, and reports the budget ended', async () => {
      mockRevokeAll.mockResolvedValue({ ok: true })
      const onBudgetEnded = vi.fn()
      const { onRevokeCredential, onArchive, onClose } = renderFinish(
        agentFixture({ status: 'revoked', live_delegation_count: 1 }),
        { onBudgetEnded },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Finish revoking' }))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(mockRevokeAll).toHaveBeenCalledTimes(1)
      expect(onBudgetEnded).toHaveBeenCalledTimes(1)
      expect(onRevokeCredential).not.toHaveBeenCalled()
      // Finish never files anything: no archive, so nothing for a caller to
      // navigate away over.
      expect(onArchive).not.toHaveBeenCalled()
    })

    it('an archived agent: signs, leaves it archived, and does not restore it', async () => {
      mockRevokeAll.mockResolvedValue({ ok: true })
      const { onArchive, onClose } = renderFinish(
        agentFixture({
          status: 'revoked',
          archived_at: '2026-06-01T00:00:00Z',
          live_delegation_count: 1,
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Finish revoking' }))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(mockRevokeAll).toHaveBeenCalledTimes(1)
      expect(onArchive).not.toHaveBeenCalled()
    })

    it('a cancelled signature says the budget is still active and keeps the dialog open', async () => {
      mockRevokeAll.mockResolvedValue({ ok: false, reason: 'cancelled' })
      const onBudgetEnded = vi.fn()
      const { onClose } = renderFinish(
        agentFixture({ status: 'revoked', live_delegation_count: 1 }),
        { onBudgetEnded },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Finish revoking' }))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/budget is still active/i),
      )
      expect(onClose).not.toHaveBeenCalled()
      expect(onBudgetEnded).not.toHaveBeenCalled()
    })

    it('stops a credential that is somehow still live, only when status is not revoked', async () => {
      mockRevokeAll.mockResolvedValue({ ok: true })
      const { onRevokeCredential, onClose } = renderFinish(
        agentFixture({
          status: 'active',
          archived_at: '2026-06-01T00:00:00Z',
          live_delegation_count: 1,
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Finish revoking' }))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(onRevokeCredential).toHaveBeenCalledTimes(1)
    })
  })

  it('no reachable signer disables Remove and says why — for agents that need a signature', () => {
    mockBudgetState.ready = false
    renderDialog(agentFixture())
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText(/connect a wallet or use a passkey/i)).toBeTruthy()
  })

  it('no-signer does NOT block removing an already-revoked agent with no live budget (archive-only leg)', () => {
    mockBudgetState.ready = false
    mockBudgetState.budgets = []
    renderDialog(agentFixture({ status: 'revoked' }))
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
  })

  it('the balance warning is information, not a gate: shown with funds, Remove stays enabled', () => {
    mockBalanceState.hasRecoverableUsdc = true
    mockBalanceState.balance = { usdc: '1.25', usdc_atomic: '1250000' }
    renderDialog(agentFixture())
    expect(screen.getByText(/1\.25 USDC can be recovered/i)).toBeTruthy()
    const sweep = screen.getByRole('link', { name: /sweep funds first/i }) as HTMLAnchorElement
    expect(sweep.getAttribute('href')).toBe('/agents/agent-1/sweep')
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
  })

  it('a slow or failed balance read degrades to no warning — Remove never waits on it', () => {
    mockBalanceState.balance = null
    mockBalanceState.hasRecoverableUsdc = false
    renderDialog(agentFixture())
    expect(screen.queryByText(/can be recovered/i)).toBeNull()
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
  })

  // #1437: two refusals that used to be dead ends — the user could press the
  // same button forever with nothing to act on.
  it('the batch-cap refusal names the remedy instead of repeating the generic failure', async () => {
    mockRevokeAll.mockResolvedValue({ ok: false, reason: 'too_many' })
    const { onRevokeCredential, onArchive } = renderDialog(agentFixture())

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/too many budgets/i),
    )
    // Actionable: a link to where the per-budget stop lives.
    const link = screen.getByRole('link', { name: /budget card/i }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/agents/agent-1')
    // And it must NOT claim the generic budget-not-stopped line.
    expect(document.body.textContent).not.toMatch(/could not be stopped/i)
    expect(onRevokeCredential).not.toHaveBeenCalled()
    expect(onArchive).not.toHaveBeenCalled()
  })

  it('a credential already revoked in another tab still completes the removal (#1437 stale-status race, real wire shape)', async () => {
    // The stale-status race: revoke-all no-ops (409 → ok), the credential
    // revoke 404s because another tab already did it, and archive — which
    // WOULD succeed — used to be unreachable behind that failure. The mock
    // carries the REAL wire shape now: an ApiRequestError with the route's
    // status and body (the old mock threw a bare Error('Agent not found'),
    // a string the backend never sends).
    mockRevokeAll.mockResolvedValue({ ok: true })
    const onArchive = vi.fn().mockResolvedValue(undefined)
    const { onClose } = renderDialog(agentFixture(), {
      onRevokeCredential: vi.fn().mockRejectedValue(
        new ApiRequestError('Agent not found', 404, { error: 'Agent not found' }),
      ),
      onArchive,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onArchive).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByText(/could not be moved to Removed/i)).toBeNull()
  })

  it('a 409 already_revoked refusal is step-already-done: archive still runs and the dialog closes', async () => {
    // #3544: the route answers an owned, already-revoked agent with 409
    // error_code "already_revoked" — the typed "done" the message matcher
    // used to guess at.
    mockRevokeAll.mockResolvedValue({ ok: true })
    const onArchive = vi.fn().mockResolvedValue(undefined)
    const { onClose } = renderDialog(agentFixture(), {
      onRevokeCredential: vi.fn().mockRejectedValue(
        new ApiRequestError('Agent is already revoked', 409, {
          error: 'Agent is already revoked',
          error_code: 'already_revoked',
        }),
      ),
      onArchive,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onArchive).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('a not-revocable 409 refusal is a REAL failure: no archive, an error surfaces, and the message is not swallowed', async () => {
    // The old /not found|already revoked/i match swallowed the route's
    // all-cases 404 "Agent not found or cannot be revoked" — the bug in
    // #3544. The typed refusal must reach the user.
    mockRevokeAll.mockResolvedValue({ ok: true })
    const onArchive = vi.fn().mockResolvedValue(undefined)
    const { onClose } = renderDialog(agentFixture(), {
      onRevokeCredential: vi.fn().mockRejectedValue(
        new ApiRequestError('Agent cannot be revoked', 409, {
          error: 'Agent cannot be revoked',
          error_code: 'not_revocable',
        }),
      ),
      onArchive,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Finish removal' })).toBeTruthy(),
    )
    expect(onArchive).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a pending_approval agent is removed end to end: no live budget, both filing steps run, dialog closes', async () => {
    // #3544: the issue's repro — a connect-modal agent still awaiting its
    // first budget. No delegation exists, so revoke-all is never asked for;
    // the widened revoke 200s; archive files it under Removed.
    mockBudgetState.budgets = []
    const order: string[] = []
    const { onClose } = renderDialog(agentFixture({ status: 'pending_approval' }), {
      onRevokeCredential: vi.fn(async () => {
        order.push('credential')
      }),
      onArchive: vi.fn(async () => {
        order.push('archive')
      }),
    })

    expect(mockRevokeAll).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(order).toEqual(['credential', 'archive'])
  })

  it('a genuine credential-revoke failure still aborts to filing_failed', async () => {
    // The escape hatch above must not swallow real errors. 500s have no
    // error_code and no 404 status.
    mockRevokeAll.mockResolvedValue({ ok: true })
    const onArchive = vi.fn().mockResolvedValue(undefined)
    renderDialog(agentFixture(), {
      onRevokeCredential: vi.fn().mockRejectedValue(new Error('Internal server error')),
      onArchive,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Finish removal' })).toBeTruthy(),
    )
    expect(onArchive).not.toHaveBeenCalled()
  })

  it('names all three consequences and the restore promise in the confirm copy', () => {
    renderDialog(agentFixture())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/stops being able to spend/i)
    expect(text).toMatch(/credential stops working/i)
    expect(text).toMatch(/history stays/i)
    expect(text).toMatch(/restoring never brings back its ability to spend/i)
  })
})
