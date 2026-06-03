import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE,
  SIGNER_ADDRESS,
  SAFE_TX_HASH,
  TX_HASH,
  MANUAL_DELEGATE_PRIVATE_KEY,
  MANUAL_DELEGATE_ADDRESS,
  MANUAL_API_KEY,
  mockUseAuth,
  mockUseSafeDetails,
  mockUseSafeOperationGate,
  mockUseAgentConnectionSetupStatus,
  mockUsePublicClient,
  mockUseActiveSigner,
  mockApiPost,
  mockIsModuleEnabled,
  mockBuildAgentSetupTx,
  mockGetSafeNonce,
  mockSignSafeTx,
  mockExecuteSafeTx,
  mockProposeSafeTx,
  mockGetSafeTxHash,
  mockManualSignMessage,
} = vi.hoisted(() => ({
  SAFE: {
    id: 'safe-1',
    name: 'Operating wallet',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: 100,
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
  },
  SIGNER_ADDRESS: '0x2222222222222222222222222222222222222222',
  SAFE_TX_HASH: `0x${'b'.repeat(64)}`,
  TX_HASH: `0x${'a'.repeat(64)}`,
  MANUAL_DELEGATE_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38',
  MANUAL_DELEGATE_ADDRESS: '0x3333333333333333333333333333333333333333',
  MANUAL_API_KEY: `sk_agent_${'ab'.repeat(24)}`,
  mockUseAuth: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseSafeOperationGate: vi.fn(),
  mockUseAgentConnectionSetupStatus: vi.fn(),
  mockUsePublicClient: vi.fn(),
  mockUseActiveSigner: vi.fn(),
  mockApiPost: vi.fn(),
  mockIsModuleEnabled: vi.fn(),
  mockBuildAgentSetupTx: vi.fn(),
  mockGetSafeNonce: vi.fn(),
  mockSignSafeTx: vi.fn(),
  mockExecuteSafeTx: vi.fn(),
  mockProposeSafeTx: vi.fn(),
  mockGetSafeTxHash: vi.fn(),
  mockManualSignMessage: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: (args: unknown) => mockUsePublicClient(args),
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
  getResolvedApiBaseUrl: () => 'https://api.haven.example',
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
}))

vi.mock('@/lib/allowance-module', () => ({
  ALLOWANCE_MODULE_ADDRESS: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
  RESET_PERIODS: [
    { value: 1440, label: 'Daily' },
    { value: 10080, label: 'Weekly' },
    { value: 43200, label: 'Monthly' },
  ],
  isModuleEnabled: (...args: unknown[]) => mockIsModuleEnabled(...args),
  buildAgentSetupTx: (...args: unknown[]) => mockBuildAgentSetupTx(...args),
}))

vi.mock('@/lib/safe-tx', () => ({
  getChainTokens: () => ({
    xDAI: { address: null, decimals: 18 },
    'USDC.e': { address: '0x9999999999999999999999999999999999999999', decimals: 6 },
  }),
  getSafeNonce: (...args: unknown[]) => mockGetSafeNonce(...args),
  signSafeTx: (...args: unknown[]) => mockSignSafeTx(...args),
  executeSafeTx: (...args: unknown[]) => mockExecuteSafeTx(...args),
  proposeSafeTx: (...args: unknown[]) => mockProposeSafeTx(...args),
  getSafeTxHash: (...args: unknown[]) => mockGetSafeTxHash(...args),
}))

vi.mock('viem/accounts', () => ({
  generatePrivateKey: () => MANUAL_DELEGATE_PRIVATE_KEY,
  privateKeyToAccount: () => ({
    address: MANUAL_DELEGATE_ADDRESS,
    signMessage: (...args: unknown[]) => mockManualSignMessage(...args),
  }),
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

function connectedSetupStatus(overrides: Record<string, unknown> = {}) {
  return {
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
      token_symbol: 'USDC.e',
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
    ...overrides,
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

describe('ConnectAgent2Modal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(0xab)
          return bytes
        },
        subtle: {
          digest: vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xcd).buffer),
        },
      },
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
    mockUsePublicClient.mockReturnValue({})
    mockUseActiveSigner.mockReturnValue({
      type: 'eoa',
      address: SIGNER_ADDRESS,
      walletClient: {},
    })
    mockIsModuleEnabled.mockResolvedValue(false)
    mockGetSafeNonce.mockResolvedValue(7n)
    mockBuildAgentSetupTx.mockReturnValue({
      to: '0x4444444444444444444444444444444444444444',
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 7n,
    })
    mockSignSafeTx.mockResolvedValue(`0x${'1'.repeat(130)}`)
    mockExecuteSafeTx.mockResolvedValue({ txHash: TX_HASH })
    mockProposeSafeTx.mockResolvedValue(undefined)
    mockGetSafeTxHash.mockReturnValue(SAFE_TX_HASH)
    mockManualSignMessage.mockResolvedValue(`0x${'9'.repeat(130)}`)
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
    expect(screen.getAllByText(/public signing address/i).length).toBeGreaterThan(0)
    const modalText = screen.getByRole('dialog').textContent ?? ''
    expect(modalText).not.toMatch(/delegate_key|private_key|privateKey|sk_agent_/)
  })

  it('renders local-ready status, runtime status, and wallet approval action', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
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
    expect(screen.getByRole('button', { name: /Approve agent rules/i })).toBeInTheDocument()
    expect(screen.queryByText(/active spending today/i)).not.toBeInTheDocument()
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

  it('uses the connector-registered public address for single-owner wallet approval', async () => {
    const refetch = vi.fn()
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch,
    })
    renderModal()

    await fillAndCreateSetup()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve agent rules' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(mockExecuteSafeTx).toHaveBeenCalled())
    expect(mockBuildAgentSetupTx).toHaveBeenCalledWith(
      SAFE.safe_address,
      '0x3333333333333333333333333333333333333333',
      [expect.objectContaining({
        token: '0x9999999999999999999999999999999999999999',
        amount: 10000000n,
        resetTimeMin: 1440,
      })],
      true,
      7n,
    )
    expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups/setup-1/wallet-approval',
      expect.objectContaining({
        result: 'confirmed',
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
        chain_id: 100,
        safe_address: SAFE.safe_address,
        allowance_module_address: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
        delegate_address: '0x3333333333333333333333333333333333333333',
        confirmation_status: 'confirmed',
      }),
    )
    expect(refetch).toHaveBeenCalled()
  })

  it('disables cancel while wallet approval is in progress', async () => {
    let resolveSignature!: (value: `0x${string}`) => void
    mockSignSafeTx.mockReturnValueOnce(new Promise<`0x${string}`>((resolve) => {
      resolveSignature = resolve
    }))
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()

    await fillAndCreateSetup()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve agent rules' }))
      await Promise.resolve()
    })

    expect(await screen.findByRole('button', { name: 'Approving...' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel setup' })).toBeDisabled()

    await act(async () => {
      resolveSignature(`0x${'1'.repeat(130)}`)
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('records multisig wallet approval as proposed without executing the Safe transaction', async () => {
    mockUseSafeDetails.mockReturnValue({
      details: {
        address: SAFE.safe_address,
        threshold: 2,
        owners: ['0x2222222222222222222222222222222222222222', '0x4444444444444444444444444444444444444444'],
      },
      loading: false,
      error: null,
    })
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()

    await fillAndCreateSetup()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit wallet approval' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(mockProposeSafeTx).toHaveBeenCalled())
    expect(mockExecuteSafeTx).not.toHaveBeenCalled()
    expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups/setup-1/wallet-approval',
      expect.objectContaining({
        result: 'proposed',
        safe_tx_hash: SAFE_TX_HASH,
        delegate_address: '0x3333333333333333333333333333333333333333',
      }),
    )
  })

  it('shows calm copy when wallet approval is cancelled', async () => {
    mockSignSafeTx.mockRejectedValueOnce(new Error('User rejected the request'))
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()

    await fillAndCreateSetup()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve agent rules' }))
      await Promise.resolve()
    })

    expect(await screen.findByText('Wallet approval was cancelled.')).toBeInTheDocument()
  })

  it('keeps manual credential fallback collapsed and requires explicit confirmation', async () => {
    mockApiPost.mockImplementation(async (path: string) => {
      if (path === '/agent-connection-setups') {
        return {
          setup_id: 'setup-1',
          status: 'awaiting_connection',
          setup_token: 'hv_setup_abc',
          expires_at: '2099-01-01T00:00:00.000Z',
          connector_command: 'npx -y @haven_ai/connect --setup hv_setup_abc --api https://api.haven.example --runtime claude-code',
          setup_prompt: 'Please connect this workspace to Haven.\n\nnpx -y @haven_ai/connect --setup hv_setup_abc',
        }
      }
      if (path === '/agent-connection-setups/resolve') {
        return {
          setup_id: 'setup-1',
          status: 'awaiting_connection',
          agent: { name: 'Research Agent', description: null },
          haven_wallet: {
            name: SAFE.name,
            address: SAFE.safe_address,
            chain_id: 100,
            network: 'Gnosis',
          },
          agent_budget: [{
            token_symbol: 'xDAI',
            allowance_amount: '10000000000000000000',
            reset_period_min: 1440,
          }],
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: {
            id: 'challenge-1',
            message: 'Haven challenge',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        }
      }
      if (path === '/agent-connection-setups/register') {
        return {
          setup_id: 'setup-1',
          agent_id: 'agent-1',
          status: 'connected_local',
          agent_status: 'pending_approval',
          api_key_prefix: 'sk_agent_abc',
          api_key_scope: 'setup_pending',
          delegate_address: MANUAL_DELEGATE_ADDRESS,
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          next_action: 'return_to_haven_for_wallet_approval',
        }
      }
      return {}
    })
    renderModal()

    await fillAndCreateSetup()

    const manualDetails = screen.getByText('Manual credential fallback').closest('details')
    expect(manualDetails).not.toHaveAttribute('open')
    const dialogBefore = screen.getByRole('dialog').textContent ?? ''
    expect(dialogBefore).not.toContain(MANUAL_DELEGATE_PRIVATE_KEY)
    expect(dialogBefore).not.toContain(MANUAL_API_KEY)

    fireEvent.click(screen.getByText('Manual credential fallback'))
    expect(screen.getByRole('button', { name: 'Create manual credential' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/I understand this fallback shows/i))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create manual credential' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups/register',
      expect.any(Object),
    ))
    const registerCall = mockApiPost.mock.calls.find(([path]) => path === '/agent-connection-setups/register')
    const registerPayload = registerCall?.[1] as Record<string, unknown>
    expect(JSON.stringify(registerPayload)).not.toContain(MANUAL_DELEGATE_PRIVATE_KEY)
    expect(JSON.stringify(registerPayload)).not.toContain(MANUAL_API_KEY)
    expect(registerPayload).toMatchObject({
      delegate_address: MANUAL_DELEGATE_ADDRESS,
      api_key_hash: 'cd'.repeat(32),
      api_key_prefix: 'sk_agent_aba',
    })

    const dialogAfter = screen.getByRole('dialog').textContent ?? ''
    expect(dialogAfter).toContain('The private signing key lets the agent sign payments within the approved agent budget.')
    expect(dialogAfter).toContain('The API key identifies the agent but cannot spend alone.')
    expect(dialogAfter).toContain('If this credential may have leaked, pause or revoke the agent in Haven.')
    expect(dialogAfter).toContain('HAVEN_API_URL=https://api.haven.example')
    expect(countOccurrences(dialogAfter, MANUAL_DELEGATE_PRIVATE_KEY)).toBe(1)
    expect(countOccurrences(dialogAfter, MANUAL_API_KEY)).toBe(1)

    const manualBlock = screen.getByText('Manual credential prompt').closest('div')
    expect(manualBlock).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(manualBlock as HTMLElement).getByRole('button', { name: 'Copy' }))
      await Promise.resolve()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(MANUAL_DELEGATE_PRIVATE_KEY))
  })

  it('runs one deterministic fallback setup from registration proof to wallet approval request', async () => {
    let connectedAfterManual = false
    const refetch = vi.fn(async () => {
      connectedAfterManual = true
      return connectedSetupStatus({ delegate_address: MANUAL_DELEGATE_ADDRESS })
    })
    mockUseAgentConnectionSetupStatus.mockImplementation(() => ({
      data: connectedAfterManual
        ? connectedSetupStatus({ delegate_address: MANUAL_DELEGATE_ADDRESS })
        : null,
      loading: false,
      error: null,
      refetch,
    }))
    mockApiPost.mockImplementation(async (path: string) => {
      if (path === '/agent-connection-setups') {
        return {
          setup_id: 'setup-1',
          status: 'awaiting_connection',
          setup_token: 'hv_setup_abc',
          expires_at: '2099-01-01T00:00:00.000Z',
          connector_command: 'npx -y @haven_ai/connect --setup hv_setup_abc --api https://api.haven.example --runtime claude-code',
          setup_prompt: 'Please connect this workspace to Haven.\n\nnpx -y @haven_ai/connect --setup hv_setup_abc',
        }
      }
      if (path === '/agent-connection-setups/resolve') {
        return {
          setup_id: 'setup-1',
          status: 'awaiting_connection',
          agent: { name: 'Research Agent', description: null },
          haven_wallet: {
            name: SAFE.name,
            address: SAFE.safe_address,
            chain_id: 100,
            network: 'Gnosis',
          },
          agent_budget: [{
            token_symbol: 'USDC.e',
            allowance_amount: '10000000',
            reset_period_min: 1440,
          }],
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: {
            id: 'challenge-1',
            message: 'Haven challenge',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        }
      }
      if (path === '/agent-connection-setups/register') {
        return {
          setup_id: 'setup-1',
          agent_id: 'agent-1',
          status: 'connected_local',
          agent_status: 'pending_approval',
          api_key_prefix: 'sk_agent_abc',
          api_key_scope: 'setup_pending',
          delegate_address: MANUAL_DELEGATE_ADDRESS,
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          next_action: 'return_to_haven_for_wallet_approval',
        }
      }
      if (path === '/agent-connection-setups/setup-1/wallet-approval') {
        return connectedSetupStatus({
          status: 'active',
          delegate_address: MANUAL_DELEGATE_ADDRESS,
          approval: { status: 'confirmed', safe_tx_hash: SAFE_TX_HASH, tx_hash: TX_HASH },
        })
      }
      return {}
    })
    renderModal()

    await fillAndCreateSetup()
    fireEvent.click(screen.getByText('Manual credential fallback'))
    fireEvent.click(screen.getByLabelText(/I understand this fallback shows/i))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create manual credential' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const registerCall = mockApiPost.mock.calls.find(([path]) => path === '/agent-connection-setups/register')
    expect(registerCall).toBeTruthy()
    expect(registerCall?.[1]).toMatchObject({
      setup_token: 'hv_setup_abc',
      challenge_id: 'challenge-1',
      delegate_address: MANUAL_DELEGATE_ADDRESS,
      proof_signature: `0x${'9'.repeat(130)}`,
      api_key_hash: 'cd'.repeat(32),
      api_key_prefix: 'sk_agent_aba',
    })
    expect(JSON.stringify(registerCall?.[1])).not.toContain(MANUAL_DELEGATE_PRIVATE_KEY)
    expect(JSON.stringify(registerCall?.[1])).not.toContain(MANUAL_API_KEY)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue to wallet approval' }))
      await Promise.resolve()
    })
    expect(await screen.findByText('Local connection ready')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve agent rules' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(mockExecuteSafeTx).toHaveBeenCalled())
    expect(mockBuildAgentSetupTx).toHaveBeenCalledWith(
      SAFE.safe_address,
      MANUAL_DELEGATE_ADDRESS,
      [expect.objectContaining({
        token: '0x9999999999999999999999999999999999999999',
        amount: 10000000n,
        resetTimeMin: 1440,
      })],
      true,
      7n,
    )
    expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups/setup-1/wallet-approval',
      expect.objectContaining({
        result: 'confirmed',
        delegate_address: MANUAL_DELEGATE_ADDRESS,
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
      }),
    )
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
