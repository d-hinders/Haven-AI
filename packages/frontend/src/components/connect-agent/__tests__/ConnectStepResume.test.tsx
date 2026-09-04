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
  approval: { status: 'pending_approval', safe_tx_hash: null, tx_hash: null },
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
    restartFromReview: vi.fn(),
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
    expect(screen.getByText(/Nothing to approve until the agent runs its setup command/i)).toBeInTheDocument()
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

  it('still renders nothing when there is neither a setup nor a resume', () => {
    // Positive control: the guard must still be able to say no, or the three
    // assertions above prove nothing about it.
    const { container } = render(
      <ConnectStep flow={resumedFlow({ resumed: false, setup: null })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
