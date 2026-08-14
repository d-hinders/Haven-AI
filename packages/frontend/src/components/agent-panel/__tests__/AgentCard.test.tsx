/**
 * #1402: the action-row visibility matrix. RemoveAgentDialog.test.tsx proves
 * the dialog's internal state machine; this file pins WHICH control renders
 * for each {status, account_type, archived_at} combination, so dropping a
 * gate (e.g. !isArchived) or inverting the rail check cannot ship silently.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Agent } from '@/hooks/useAgents'

vi.mock('../RemoveAgentDialog', () => ({
  RemoveAgentDialog: () => <div data-testid="remove-agent-dialog" />,
}))

const { AgentCard } = await import('../AgentCard')

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

function renderCard(agent: Agent, { canUseWalletActions = true } = {}) {
  const onRestore = vi.fn()
  render(
    <AgentCard
      agent={agent}
      onChainAllowances={null}
      onChainLoading={false}
      chainTimeSec={null}
      onViewDetails={vi.fn()}
      onEdit={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onRevoke={vi.fn()}
      onRevokeCredential={vi.fn().mockResolvedValue(undefined)}
      onArchive={vi.fn().mockResolvedValue(undefined)}
      onRestore={onRestore}
      busyAction={null}
      canUseWalletActions={canUseWalletActions}
    />,
  )
  return { onRestore }
}

describe('AgentCard action-row matrix (#1402)', () => {
  it('active delegation agent: Remove shown, Safe Revoke hidden', () => {
    renderCard(agentFixture())
    expect(screen.getByRole('button', { name: 'Remove Research agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke Research agent' })).toBeNull()
  })

  it('active legacy agent: Safe Revoke shown, Remove hidden while operational', () => {
    renderCard(agentFixture({ account_type: 'safe' as Agent['account_type'] }))
    expect(screen.getByRole('button', { name: 'Revoke Research agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove Research agent' })).toBeNull()
  })

  it('revoked-not-archived agent (any rail): status note + Remove, no Restore', () => {
    renderCard(agentFixture({ status: 'revoked', account_type: 'safe' as Agent['account_type'] }))
    expect(screen.getByText('Network access already revoked')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Research agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
  })

  it('archived agent: Restore only — no Remove, no Revoke, and the restore promise is stated', () => {
    const { onRestore } = renderCard(
      agentFixture({ status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }),
    )
    expect(screen.queryByRole('button', { name: 'Remove Research agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke Research agent' })).toBeNull()
    expect(screen.getByText(/restoring never re-enables spending/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore Research agent to the list' }))
    expect(onRestore).toHaveBeenCalled()
  })

  it('Remove opens the dialog; it is not mounted before that', () => {
    renderCard(agentFixture())
    expect(screen.queryByTestId('remove-agent-dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Research agent' }))
    expect(screen.getByTestId('remove-agent-dialog')).toBeTruthy()
  })
})
