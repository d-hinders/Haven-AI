import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConnectionSetupStatusResponse } from '@/hooks/useAgentConnectionSetupStatus'
import { budgetEndsAt, formatBudgetEndDate } from '@/lib/budget-end'

/**
 * #3825: the connect flow's budget grant carries the #1097 cross-device
 * heads-up. The global wallet menu that disclosed the fallback passkey left
 * the top bar, and #1969 declined offering that passkey silently.
 */

const { budgetState, grant } = vi.hoisted(() => ({
  budgetState: { ready: true, passkeyElsewhere: false },
  grant: vi.fn<(input: unknown) => Promise<unknown>>(),
}))

vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    grant,
    busy: false,
    ready: budgetState.ready,
    passkeyElsewhere: budgetState.passkeyElsewhere,
  }),
}))
// The not-ready exit reads wagmi/RainbowKit; this suite is about the ready path.
vi.mock('../../WalletButton', () => ({ default: () => <button type="button">Connect wallet</button> }))
vi.mock('../ConnectionVerificationFooter', () => ({ ConnectionVerificationFooter: () => null }))

const { DelegationApprovalStep } = await import('../DelegationApprovalStep')

const STATUS = {
  setup_id: 'setup-1',
  agent_id: 'agent-1',
  status: 'awaiting_wallet_approval',
  expires_at: '2099-01-01T00:00:00.000Z',
  agent: { name: 'Research agent', description: null },
  haven_wallet: { id: 'safe-1', name: 'Operating wallet', address: '0x111', chain_id: 84532, network: 'Base Sepolia' },
  agent_budget: [],
  delegate_address: '0x333',
  runtime: null,
  install_status: {},
  approval: { status: 'pending_approval', account_tx_hash: null, tx_hash: null },
} as unknown as AgentConnectionSetupStatusResponse

// #3895: the grant control stays disabled while the input is incomplete
// (agent_budget empty), so the failed-grant test needs a budget on the setup.
const STATUS_WITH_BUDGET = {
  ...STATUS,
  agent_budget: [
    {
      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      allowance_amount: '5000000',
      token_symbol: 'USDC',
      reset_period_min: 1440,
    },
  ],
} as unknown as AgentConnectionSetupStatusResponse

function renderStep(status: AgentConnectionSetupStatusResponse = STATUS) {
  render(
    <DelegationApprovalStep
      agentId="agent-1"
      setupId="setup-1"
      chainId={84532}
      status={status}
      walletName="Operating wallet"
      onApproved={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
      onClose={vi.fn()}
      isWrongChain={false}
      approvalChainName="Base Sepolia"
      onSwitchChain={vi.fn()}
      isSwitchingChain={false}
    />,
  )
}

beforeEach(() => {
  budgetState.ready = true
  budgetState.passkeyElsewhere = false
  grant.mockReset()
})

describe('DelegationApprovalStep cross-device hint (#3825)', () => {
  it('shows the hint above Approve budget when the passkey is elsewhere', () => {
    budgetState.passkeyElsewhere = true
    renderStep()
    expect(screen.getByText(/passkey may be on another device/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeTruthy()
  })

  it('shows no hint when the passkey is on this device', () => {
    renderStep()
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeTruthy()
    expect(screen.queryByText(/passkey may be on another device/)).toBeNull()
  })
})

describe('DelegationApprovalStep failed grant (#3895)', () => {
  it('a failed grant reads in the approve verb — no "set" anywhere in the error', async () => {
    // The button on this screen is "Approve budget"; the failure sentence must
    // carry the same verb. The agent page's "set" sentence lives in ITS caller.
    grant.mockResolvedValue({ ok: false, reason: 'failed' })
    renderStep(STATUS_WITH_BUDGET)

    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))

    const message = await screen.findByText(/budget was not approved/i)
    expect(message.textContent).toMatch(/Nothing changed — try again\./)
    expect(message.textContent).not.toMatch(/set/i)
    // The owner approves by signing; Haven is never named as the approver.
    expect(message.textContent).not.toMatch(/haven/i)
  })
})

/**
 * #3933: on a resume or a retry the agent may already hold a live budget for
 * this token, and the backend refuses a second one. The step must not show
 * the generic failure, must not loop, and must point at the agent page.
 */
describe('DelegationApprovalStep occupied slot (#3933)', () => {
  it('says the agent already has a live budget, links to the agent page, and disables the retry', async () => {
    grant.mockResolvedValue({ ok: false, reason: 'slot_occupied', existingDelegationHash: '0x' + 'e1'.repeat(32) })
    renderStep(STATUS_WITH_BUDGET)
    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
    await screen.findByText(/Research agent already has a live budget for USDC/)
    expect(screen.queryByText(/budget was not approved/i)).toBeNull()
    expect(screen.getByRole('link', { name: 'the agent’s page' }).getAttribute('href')).toBe('/agents/agent-1')
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeDisabled()
    expect(grant).toHaveBeenCalledTimes(1)
  })
})

/**
 * #4350: the approval step carries the end-date choice and sends it — until
 * this slice the connect flow showed no end date at all, and every grant
 * silently ended on the server's 90-day default.
 */
describe('DelegationApprovalStep end date (#4350)', () => {
  it('shows the end-date choice with its resulting day, dated from this clock', () => {
    renderStep(STATUS_WITH_BUDGET)
    const select = screen.getByLabelText('Ends') as HTMLSelectElement
    expect([...select.options].map((o) => o.text)).toEqual(['30 days', '90 days', '180 days', '365 days'])
    expect(select.value).toBe('90')
    // The stated day is the 90-day preset from now — the lib's own conversion,
    // so the pin is exact and cannot drift from what the control computes.
    const expected = `Ends ${formatBudgetEndDate(budgetEndsAt(90, Math.floor(Date.now() / 1000))!)}.`
    expect(screen.getByTestId('budget-end-date').textContent).toBe(expected)
  })

  it('the grant input carries the chosen end — the mutation cell fails if the choice never reaches the build', async () => {
    grant.mockResolvedValue({ ok: true })
    renderStep(STATUS_WITH_BUDGET)
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '180' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
    await screen.findByText(/When it ends, Research agent can no longer spend/)
    expect(grant).toHaveBeenCalledTimes(1)
    const input = grant.mock.calls[0][0] as { expiresAt?: number }
    const nowSec = Date.now() / 1000
    expect(input.expiresAt).toBeDefined()
    expect(input.expiresAt!).toBeGreaterThan(nowSec + 178 * 86_400)
    expect(input.expiresAt!).toBeLessThan(nowSec + 182 * 86_400)
  })
})
