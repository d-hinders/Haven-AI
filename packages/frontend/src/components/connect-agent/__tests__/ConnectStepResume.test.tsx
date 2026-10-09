import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectStep } from '../ConnectStep'
import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'

/**
 * Renders the REAL ConnectStep for a session resumed from a hand-off link
 * (#2522) — `/agents?setup=<id>`.
 *
 * This file exists because of a defect the hook tests could not see. Those
 * assert `step === 'connect'` and that the right status is polled, and both
 * were true while the modal rendered a blank body: `ConnectStep` opened with
 * `if (!setup) return null`, and `setup` is the CREATE response, which a
 * resumed session never has. Every status — waiting, approval, active — fell
 * out of that guard before `connectView` was read.
 *
 * So the assertions below are on RENDERED OUTPUT, not on flow state. A test
 * that mocks `ConnectStep` away (as `ConnectAgentModal.test.tsx` does, for its
 * own good reasons) cannot catch this class at all.
 */

vi.mock('../DelegationApprovalStep', () => ({
  DelegationApprovalStep: ({ setupId, agentId }: { setupId: string; agentId: string }) => (
    <div>{`approval for ${agentId} on ${setupId}`}</div>
  ),
}))

vi.mock('../WaitingForConnector', () => ({
  WaitingForConnector: () => <div>paste this into your agent</div>,
}))

const STATUS = {
  setup_id: '11111111-2222-3333-4444-555555555555',
  agent_id: 'agent-1',
  status: 'awaiting_connection',
  expires_at: '2099-01-01T00:00:00.000Z',
  agent: { name: 'Research agent', description: null },
  haven_wallet: { id: 'safe-1', name: 'Operating wallet', address: '0x111', chain_id: 84532, network: 'Base Sepolia' },
  agent_budget: [],
  delegate_address: '0x333',
  runtime: null,
  install_status: {},
  approval: { status: 'pending_approval', account_tx_hash: null, tx_hash: null },
}

function resumedFlow(overrides: Record<string, unknown> = {}): AgentConnectionSetupFlow {
  return {
    // The defining fact of a resumed session: no create response.
    setup: null,
    resumed: true,
    setupStatus: STATUS,
    connectView: { kind: 'waiting_for_connector' },
    statusLoading: false,
    statusError: null,
    awaitingConnectionStage: 'starting',
    copied: null,
    copyText: vi.fn(),
    manualCredential: null,
    manualCredentialAcknowledged: false,
    manualCreating: false,
    manualError: null,
    handleCreateManualCredential: vi.fn(),
    handleContinueAfterManualCredential: vi.fn(),
    handleCancelSetup: vi.fn(),
    handleClose: vi.fn(),
    handleDelegationApproved: vi.fn(),
    restartFromPolicy: vi.fn(),
    approvalChainId: 84532,
    approvalWalletLabel: 'Operating wallet',
    isWrongChain: false,
    approvalChainName: 'Base Sepolia',
    switchToApprovalChain: vi.fn(),
    isSwitchingChain: false,
    ...overrides,
  } as unknown as AgentConnectionSetupFlow
}

describe('ConnectStep resumed from a hand-off link (#2522)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders a body at all — the regression this file is named for', () => {
    const { container } = render(<ConnectStep flow={resumedFlow()} />)
    expect(container).not.toBeEmptyDOMElement()
  })

  it('awaiting_connection: says there is nothing to approve yet, and offers no connector command', () => {
    render(<ConnectStep flow={resumedFlow()} />)
    expect(screen.getByText(/Not connected yet/i)).toBeInTheDocument()
    expect(screen.getByText(/Nothing to approve until the agent runs its connector command/i)).toBeInTheDocument()
    // The setup token is a create-time secret and this path has none. Handing
    // the approver a connector command would be handing them somebody else's
    // terminal step.
    expect(screen.queryByText(/paste this into your agent/i)).not.toBeInTheDocument()
  })

  it('awaiting_wallet_approval: renders the budget approval for that setup', () => {
    render(
      <ConnectStep
        flow={resumedFlow({
          setupStatus: { ...STATUS, status: 'awaiting_wallet_approval' },
          connectView: { kind: 'delegation_approval', agentId: 'agent-1' },
        })}
      />,
    )
    // The setup id must come from the STATUS on this path — reading it from
    // the absent create response is what broke.
    expect(screen.getByText(`approval for agent-1 on ${STATUS.setup_id}`)).toBeInTheDocument()
  })

  it('active: renders the done state', () => {
    render(
      <ConnectStep
        flow={resumedFlow({
          // An approved setup always has a budget — that is what was approved.
          setupStatus: {
            ...STATUS,
            status: 'active',
            agent_budget: [
              { allowance_amount: '10.00', token_symbol: 'USDC', reset_period_min: 1440 },
            ],
          },
          connectView: { kind: 'active' },
        })}
      />,
    )
    expect(screen.getByText(/Research agent/i)).toBeInTheDocument()
  })

  it('a stale or mistyped link says so instead of showing an empty body', () => {
    // Second review round. `resolveConnectStepView` returns null with no
    // status, so this rendered chrome over nothing — the first round's defect
    // reached by the likeliest route in practice, not by a named status.
    render(
      <ConnectStep
        flow={resumedFlow({
          setupStatus: undefined,
          connectView: null,
          statusError: 'We could not load this agent setup.',
        })}
      />,
    )
    expect(screen.getByText(/We could not open this setup/i)).toBeInTheDocument()
    expect(screen.getByText(/may belong to a different Haven account/i)).toBeInTheDocument()
  })

  it.each(['expired', 'cancelled', 'failed'] as const)(
    '%s on a resumed link offers Close, never "Create a new setup"',
    (kind) => {
      // "Create a new setup" drops the user on the POLICY step, and a resumed
      // session never filled in details or policy — it would post an unnamed,
      // budget-less setup against whichever wallet the viewer defaults to.
      const restartFromPolicy = vi.fn()
      render(
        <ConnectStep
          flow={resumedFlow({
            setupStatus: { ...STATUS, status: kind },
            connectView: { kind },
            restartFromPolicy,
          })}
        />,
      )
      expect(screen.queryByRole('button', { name: /Create a new setup/i })).not.toBeInTheDocument()
      expect(restartFromPolicy).not.toHaveBeenCalled()
    },
  )

  it('a NON-resumed terminal state still offers it — the ordinary flow is unchanged', () => {
    // Positive control: the three cases above prove nothing if the action was
    // simply removed for everyone.
    render(
      <ConnectStep
        flow={resumedFlow({
          setup: { setup_id: STATUS.setup_id, expires_at: STATUS.expires_at },
          resumed: false,
          setupStatus: { ...STATUS, status: 'expired' },
          connectView: { kind: 'expired' },
        })}
      />,
    )
    expect(screen.getByRole('button', { name: /Create a new setup/i })).toBeInTheDocument()
  })

  it('still renders nothing when there is neither a setup nor a resume', () => {
    // Positive control: the guard must still be able to say no, or the three
    // assertions above prove nothing about it.
    const { container } = render(
      <ConnectStep flow={resumedFlow({ resumed: false, setup: null })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

/**
 * #3832: the numbered step list across the sub-states ConnectStep owns (the
 * waiting screen's own rows are covered in ConnectStepShell.test.tsx).
 */
describe('ConnectStep step list (#3832)', () => {
  function rows(container: HTMLElement) {
    return Array.from(container.querySelectorAll('ol[aria-label="Connection steps"] > li')).map((li) => ({
      state: li.getAttribute('data-step-state'),
      title: li.querySelector('h3')?.textContent?.replace(/^[^:]+: /, ''),
    }))
  }

  it('a resumed setup already past waiting renders rows 1-2 done, with the approval inside row 3', () => {
    const { container } = render(
      <ConnectStep
        flow={resumedFlow({
          setupStatus: { ...STATUS, status: 'awaiting_wallet_approval' },
          connectView: { kind: 'delegation_approval', agentId: 'agent-1' },
        })}
      />,
    )
    expect(rows(container)).toEqual([
      { state: 'done', title: 'Prompt copied' },
      { state: 'done', title: 'Agent connected' },
      { state: 'active', title: 'Review and sign' },
    ])
    const third = container.querySelectorAll('ol[aria-label="Connection steps"] > li')[2]
    expect(third.textContent).toContain(`approval for agent-1 on ${STATUS.setup_id}`)
    // #1684: the subtitle names the gate; nothing in the body repeats it.
    expect(container.textContent).not.toContain('Approve the agent budget')
    expect(container.textContent).not.toMatch(/Approve the budget/)
  })

  it('finalizing_local: rows 1-2 done, row 3 in flight, and a poll tick changes nothing', () => {
    const flow = resumedFlow({
      setupStatus: { ...STATUS, status: 'connected_local' },
      connectView: { kind: 'finalizing_local' },
      statusLoading: true,
    })
    const { container, rerender } = render(<ConnectStep flow={flow} />)
    expect(rows(container).map((r) => r.state)).toEqual(['done', 'done', 'working'])
    const first = container.innerHTML
    rerender(<ConnectStep flow={{ ...flow, statusLoading: false } as AgentConnectionSetupFlow} />)
    expect(container.innerHTML).toBe(first)
    rerender(<ConnectStep flow={{ ...flow, statusLoading: true } as AgentConnectionSetupFlow} />)
    expect(container.innerHTML).toBe(first)
  })

  it('active: every row done, and the ending carries a status word', () => {
    const { container } = render(
      <ConnectStep
        flow={resumedFlow({
          setupStatus: {
            ...STATUS,
            status: 'active',
            agent_budget: [{ allowance_amount: '10.00', token_symbol: 'USDC', reset_period_min: 1440 }],
          },
          connectView: { kind: 'active' },
        })}
      />,
    )
    expect(rows(container)).toEqual([
      { state: 'done', title: 'Prompt copied' },
      { state: 'done', title: 'Agent connected' },
      { state: 'done', title: 'Budget approved' },
    ])
  })

  it.each(['expired', 'cancelled', 'failed', 'unknown_status'] as const)(
    '%s renders through the shell with no step list',
    (kind) => {
      const { container } = render(
        <ConnectStep flow={resumedFlow({ setupStatus: { ...STATUS, status: kind }, connectView: { kind } })} />,
      )
      expect(container).not.toBeEmptyDOMElement()
      expect(container.querySelector('ol[aria-label="Connection steps"]')).toBeNull()
      expect(container.querySelector('.min-h-\\[340px\\]')).not.toBeNull()
    },
  )
})
