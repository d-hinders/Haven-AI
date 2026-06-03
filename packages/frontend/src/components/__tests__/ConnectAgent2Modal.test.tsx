import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE,
  mockUseAuth,
  mockUseSafeDetails,
  mockUseSafeOperationGate,
  mockUseAgentConnectionSetupStatus,
  mockApiPost,
} = vi.hoisted(() => ({
  SAFE: {
    id: 'safe-1',
    name: 'Operating wallet',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: 100,
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
  },
  mockUseAuth: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseSafeOperationGate: vi.fn(),
  mockUseAgentConnectionSetupStatus: vi.fn(),
  mockApiPost: vi.fn(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (safeAddress: string | null) => mockUseSafeDetails(safeAddress),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: (args: unknown) => mockUseSafeOperationGate(args),
}))

vi.mock('@/hooks/useAgentConnectionSetupStatus', () => ({
  useAgentConnectionSetupStatus: (setupId: string | null, options: unknown) =>
    mockUseAgentConnectionSetupStatus(setupId, options),
}))

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}))

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

vi.mock('@/hooks/useFocusTrap', () => ({
  useFocusTrap: vi.fn(),
}))

vi.mock('@/components/WalletButton', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

vi.mock('@/components/ui/StepProgress', () => ({
  StepProgress: ({ totalSteps, currentStep }: { totalSteps: number; currentStep: number }) => (
    <div aria-label={`Step ${currentStep + 1} of ${totalSteps}`} />
  ),
}))

vi.mock('@/components/haven', async () => {
  const actual = await vi.importActual<typeof import('@/components/haven')>('@/components/haven')
  return {
    ...actual,
    WalletIdentityBlock: ({ name }: { name: string }) => <div>{name}</div>,
  }
})

import ConnectAgent2Modal from '@/components/ConnectAgent2Modal'

function renderModal({
  onClose = vi.fn(),
  safeAddress = SAFE.safe_address,
  safeId = SAFE.id,
}: {
  onClose?: ReturnType<typeof vi.fn>
  safeAddress?: string
  safeId?: string | null
} = {}) {
  render(
    <ConnectAgent2Modal
      open
      onClose={onClose}
      safeAddress={safeAddress}
      safeId={safeId}
    />,
  )
  return { onClose }
}

async function fillAndCreateSetup() {
  fireEvent.change(screen.getByLabelText('Agent name'), {
    target: { value: 'Research Agent' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
  fireEvent.change(screen.getByPlaceholderText('Amount'), {
    target: { value: '10' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review agent rules' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
    await Promise.resolve()
  })
}

describe('ConnectAgent2Modal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    mockUseAuth.mockReturnValue({
      user: { safes: [SAFE] },
      activeSafe: SAFE,
    })
    mockUseSafeDetails.mockReturnValue({
      details: { address: SAFE.safe_address, threshold: 1, owners: ['0x2222222222222222222222222222222222222222'] },
      loading: false,
      error: null,
    })
    mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockApiPost.mockResolvedValue({
      setup_id: 'setup-1',
      status: 'awaiting_connection',
      setup_token: 'hv_setup_abc',
      expires_at: '2099-01-01T00:00:00.000Z',
      connector_command: 'npx -y @haven_ai/connect --setup hv_setup_abc --api https://api.haven.example --runtime claude-code',
      setup_prompt: 'Please connect this workspace to Haven.\n\nnpx -y @haven_ai/connect --setup hv_setup_abc',
    })
  })

  it('creates a pending setup and shows a private-key-free setup prompt', async () => {
    renderModal()

    await fillAndCreateSetup()

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups',
      expect.objectContaining({
        name: 'Research Agent',
        runtime: 'claude-code',
        safe_id: SAFE.id,
      }),
    ))
    const body = mockApiPost.mock.calls[0][1] as Record<string, unknown>
    expect(JSON.stringify(body)).not.toMatch(/delegate_key|private_key|privateKey|sk_agent_/)
    expect(body.allowances).toEqual([
      expect.objectContaining({
        token_symbol: 'xDAI',
        allowance_amount: '10000000000000000000',
        reset_period_min: 1440,
      }),
    ])

    expect(await screen.findByText('Connect your agent')).toBeInTheDocument()
    expect(screen.getAllByText(/hv_setup_abc/).length).toBeGreaterThan(0)
    expect(screen.getByText(/public signing address/i)).toBeInTheDocument()
    const modalText = screen.getByRole('dialog').textContent ?? ''
    expect(modalText).not.toMatch(/delegate_key|private_key|privateKey|sk_agent_/)
  })

  it('renders local-ready status, runtime status, and approval readiness without enabling activation', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: {
        setup_id: 'setup-1',
        agent_id: 'agent-1',
        status: 'connected_local',
        expires_at: '2099-01-01T00:00:00.000Z',
        agent: { name: 'Research Agent', description: null },
        haven_wallet: {
          id: SAFE.id,
          name: SAFE.name,
          address: SAFE.safe_address,
          chain_id: 100,
          network: 'Gnosis',
        },
        agent_budget: [{
          id: 'budget-1',
          token_address: '0x9999999999999999999999999999999999999999',
          token_symbol: 'USDC',
          allowance_amount: '10000000',
          reset_period_min: 1440,
        }],
        delegate_address: '0x3333333333333333333333333333333333333333',
        install_status: {
          hosted_mcp_configured: true,
          local_signer_configured: true,
          credential_files_written: true,
          restart_required: true,
          probe_result: 'hosted_ok_local_signer_ready',
        },
        approval: { status: 'pending_approval', safe_tx_hash: null, tx_hash: null },
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()

    await fillAndCreateSetup()

    expect(await screen.findByText('Local connection ready')).toBeInTheDocument()
    expect(screen.getByText('Connected locally')).toBeInTheDocument()
    expect(screen.getByText('Ready for Haven approval')).toBeInTheDocument()
    expect(screen.getByText(/until that approval is completed, this agent cannot spend/i)).toBeInTheDocument()
    expect(screen.getByText(/active spending today/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve agent rules/i })).not.toBeInTheDocument()
  })

  it('shows wallet approval blockers from the current device state', async () => {
    mockUseSafeOperationGate.mockReturnValue({ kind: 'no_signer' })
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: {
        setup_id: 'setup-1',
        agent_id: 'agent-1',
        status: 'connected_local',
        expires_at: '2099-01-01T00:00:00.000Z',
        agent: { name: 'Research Agent', description: null },
        haven_wallet: {
          id: SAFE.id,
          name: SAFE.name,
          address: SAFE.safe_address,
          chain_id: 100,
          network: 'Gnosis',
        },
        agent_budget: [],
        delegate_address: '0x3333333333333333333333333333333333333333',
        install_status: { credential_files_written: true },
        approval: { status: 'pending_approval' },
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderModal()
    await fillAndCreateSetup()

    expect(await screen.findByText('Wallet approval unavailable')).toBeInTheDocument()
    expect(screen.getByText(/Connect a wallet or use a passkey/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument()
  })

  it('shows a visible blocker when no Haven wallet is available', async () => {
    mockUseAuth.mockReturnValue({
      user: { safes: [] },
      activeSafe: null,
    })
    renderModal({ safeAddress: '', safeId: null })

    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'Research Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    fireEvent.change(screen.getByPlaceholderText('Amount'), {
      target: { value: '10' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review agent rules' }))

    expect(screen.getByText('Haven wallet unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create setup prompt' })).toBeDisabled()
  })

  it.each([
    ['approval_in_progress', 'Approval in progress'],
    ['proposed', 'Waiting for more approvals'],
    ['active', 'Agent ready'],
  ])('renders %s setup status without a blank connect step', async (status, title) => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: {
        setup_id: 'setup-1',
        agent_id: 'agent-1',
        status,
        expires_at: '2099-01-01T00:00:00.000Z',
        agent: { name: 'Research Agent', description: null },
        haven_wallet: {
          id: SAFE.id,
          name: SAFE.name,
          address: SAFE.safe_address,
          chain_id: 100,
          network: 'Gnosis',
        },
        agent_budget: [],
        delegate_address: '0x3333333333333333333333333333333333333333',
        install_status: { credential_files_written: true },
        approval: { status },
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderModal()
    await fillAndCreateSetup()

    expect(await screen.findByText(title)).toBeInTheDocument()
  })
})
