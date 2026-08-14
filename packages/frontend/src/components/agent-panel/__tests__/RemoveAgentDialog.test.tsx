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

const { mockRevokeAll, mockBudgetState, mockBalanceState } = vi.hoisted(() => ({
  mockRevokeAll: vi.fn(),
  mockBudgetState: { ready: true, busy: false },
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
    budgets: null,
    grant: vi.fn(),
    revoke: vi.fn(),
    revokeAll: mockRevokeAll,
    busy: mockBudgetState.busy,
    ready: mockBudgetState.ready,
    reload: vi.fn(),
    signersError: null,
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
    safe_id: 'safe-1',
    safe_address: '0x' + '11'.repeat(20),
    safe_name: 'Main account',
    safe_chain_id: 84532,
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
      onArchive: vi.fn().mockRejectedValue(new Error('network')),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() =>
      expect(screen.getByText(/can no longer spend/i)).toBeTruthy(),
    )
    // The dialog stays open with a finish affordance, never a silent success.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Finish removal' })).toBeTruthy()
  })

  it('an already-revoked agent skips both the signature and the credential step', async () => {
    const { onRevokeCredential, onClose } = renderDialog(
      agentFixture({ status: 'revoked' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockRevokeAll).not.toHaveBeenCalled()
    expect(onRevokeCredential).not.toHaveBeenCalled()
  })

  it('a legacy (non-delegation) revoked agent archives without any signing machinery', async () => {
    const { onClose } = renderDialog(
      agentFixture({ status: 'revoked', account_type: 'safe' as Agent['account_type'] }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockRevokeAll).not.toHaveBeenCalled()
  })

  it('no reachable signer disables Remove and says why — for agents that need a signature', () => {
    mockBudgetState.ready = false
    renderDialog(agentFixture())
    const confirm = screen.getByRole('button', { name: 'Remove agent' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText(/connect a wallet or use a passkey/i)).toBeTruthy()
  })

  it('no-signer does NOT block removing an already-revoked agent (archive-only leg)', () => {
    mockBudgetState.ready = false
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

  it('names all three consequences and the restore promise in the confirm copy', () => {
    renderDialog(agentFixture())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/stops being able to spend/i)
    expect(text).toMatch(/credential stops working/i)
    expect(text).toMatch(/history stays/i)
    expect(text).toMatch(/restoring never brings back its ability to spend/i)
  })
})
