import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE,
  BASE_SAFE,
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
  mockApiGet,
  mockGrant,
  mockDelegationBudgetReady,
  mockUseAccount,
  mockSwitchChain,
} = vi.hoisted(() => ({
  SAFE: {
    id: 'safe-1',
    name: 'Operating wallet',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: 100,
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
  },
  BASE_SAFE: {
    id: 'safe-2',
    name: 'Base wallet',
    safe_address: '0x4444444444444444444444444444444444444444',
    chain_id: 8453,
    is_default: false,
    created_at: '2026-01-02T00:00:00.000Z',
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
  mockApiGet: vi.fn(),
  mockGrant: vi.fn(),
  mockDelegationBudgetReady: vi.fn(),
  mockUseAccount: vi.fn(),
  mockSwitchChain: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  // #1069: the modal routes delegation-rail users to the agent page for the
  // budget grant; tests render without the app router, so mock it.
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('wagmi', () => ({
  usePublicClient: (args: unknown) => mockUsePublicClient(args),
  // Not connected by default — avoids wrong-chain detection in tests that
  // don't explicitly set up a wallet connection.
  useAccount: () => mockUseAccount(),
  useSwitchChain: () => ({ switchChain: mockSwitchChain, isPending: false }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (safeAddress: string | null, options: unknown) => mockUseSafeDetails(safeAddress, options),
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
    get: (...args: unknown[]) => mockApiGet(...args),
  },
  getResolvedApiBaseUrl: () => 'https://api.haven.example',
}))

// #1073: the delegation approval step performs the grant in-modal. Drive the
// grant outcome directly so a cancelled signature is testable without a
// WebAuthn ceremony.
vi.mock('@/hooks/useDelegationBudget', () => ({
  useDelegationBudget: () => ({
    budgets: [],
    grant: mockGrant,
    revoke: vi.fn(),
    busy: false,
    ready: mockDelegationBudgetReady(),
    reload: vi.fn(),
  }),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
  // Real predicate shape (#1079): narrows away the delegator_passkey variant.
  isSafeCapableSigner: (s: { type?: string } | null) => s !== null && s.type !== 'delegator_passkey',
}))

vi.mock('@/lib/allowance-module', () => ({
  allowanceModuleFor: () => '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
  RESET_PERIODS: [
    { value: 1440, label: 'Daily' },
    { value: 10080, label: 'Weekly' },
    { value: 43200, label: 'Monthly' },
  ],
  isModuleEnabled: (...args: unknown[]) => mockIsModuleEnabled(...args),
  buildAgentSetupTx: (...args: unknown[]) => mockBuildAgentSetupTx(...args),
}))

vi.mock('@/lib/safe-tx', () => ({
  getChainTokens: (chainId: number) =>
    chainId === 8453
      ? {
          ETH: { address: null, decimals: 18 },
          USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
        }
      : {
          xDAI: { address: null, decimals: 18 },
          'USDC.e': { address: '0x9999999999999999999999999999999999999999', decimals: 6 },
        },
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

import ConnectAgentModal from '@/components/ConnectAgentModal'

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
    <ConnectAgentModal
      open
      onClose={onClose}
      safeAddress={safeAddress}
      safeId={safeId}
    />,
  )
  return { onClose }
}

function ReopenableModal() {
  const [open, setOpen] = useState(true)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen modal
      </button>
      <ConnectAgentModal
        open={open}
        onClose={() => setOpen(false)}
        safeAddress={SAFE.safe_address}
        safeId={SAFE.id}
      />
    </>
  )
}

async function fillAndCreateSetup() {
  fireEvent.change(screen.getByLabelText('Agent name'), {
    target: { value: 'Research Agent' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
  if (!screen.queryByPlaceholderText('Amount')) {
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
  }
  fireEvent.change(screen.getByPlaceholderText('Amount'), {
    target: { value: '10' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review agent budget' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
    await Promise.resolve()
  })
}

/** Put the modal on a delegation-rail (Hybrid DeleGator) Haven wallet. */
function useDelegationAccount() {
  mockUseAuth.mockReturnValue({
    user: { safes: [{ ...SAFE, account_type: 'delegator_hybrid' }] },
    activeSafe: { ...SAFE, account_type: 'delegator_hybrid' },
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
    // #1672: the connector reports the runtime it DETECTED; runtime-specific
    // copy (restart guidance) keys off this, not the collapsed picker choice.
    runtime: 'claude-code',
    install_status: {
      runtime_mcp_mode: 'local_stdio',
      hosted_mcp_configured: false,
      local_signer_configured: true,
      local_mcp_configured: true,
      credential_files_written: true,
      local_mcp_acknowledged: true,
      activation_command_available: false,
      restart_required: true,
      probe_result: 'local_stdio_mcp_ready',
    },
    approval: { status: 'pending_approval', safe_tx_hash: null, tx_hash: null },
    ...overrides,
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

const SETUP_PROMPT = [
  'Please connect this workspace to Haven.',
  '',
  'I approve running this exact Haven setup command. It may download and execute the published npm package @haven_ai/connect@alpha, connect to Haven at https://api.haven.example, write local Haven credential files under ~/.haven, and update the local agent MCP config when supported.',
  '',
  'Run this exact command:',
  '',
  'npx -y @haven_ai/connect@alpha --setup hv_setup_abc --api https://api.haven.example --ack-local-tools --runtime claude-code',
  '',
  'Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.',
  '',
  'The Haven connector generates the signing key locally and sends Haven only the public signing address plus proof.',
  '',
  'If you are orchestrating this setup programmatically, the connector also supports a --json mode: one machine-readable, secret-free result object on stdout, progress on stderr. Appending --json is the ONLY permitted change to the command above.',
  '',
  'When the connector finishes, tell me to return to Haven to approve the budget.',
].join('\n')

describe('ConnectAgentModal', () => {
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
    mockApiGet.mockResolvedValue({})
    mockGrant.mockResolvedValue({ ok: true })
    mockDelegationBudgetReady.mockReturnValue(true)
    mockUseAccount.mockReturnValue({ address: undefined, chain: undefined })
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
      connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_abc --api https://api.haven.example --ack-local-tools --runtime claude-code',
      setup_prompt: SETUP_PROMPT,
    })
  })

  it('prefills a 10/day starter budget when opened with starterAllowance (#352)', () => {
    render(
      <ConnectAgentModal
        open
        onClose={vi.fn()}
        safeAddress={SAFE.safe_address}
        safeId={SAFE.id}
        starterAllowance
      />,
    )

    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'First Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    // The policy step opens with the starter budget already prefilled in the
    // amount input — the inputs ARE the draft (#1381, no card below them).
    expect(screen.getByPlaceholderText('Amount')).toHaveValue('10')
    expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Budget draft')).not.toBeInTheDocument()
  })

  it('typing a valid amount adds nothing below the input row — no content shift (#1381)', () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'Shift Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    const amount = screen.getByPlaceholderText('Amount')
    // Everything below the input row, captured in the empty state.
    const dialog = amount.closest('[role="dialog"]') ?? document.body
    const structureBelow = () => {
      const nodes = Array.from(dialog.querySelectorAll('*'))
      const start = nodes.indexOf(amount)
      return nodes.slice(start + 1).map((node) => node.tagName + ':' + (node.getAttribute('class') ?? '')).join('|')
    }
    const before = structureBelow()

    fireEvent.change(amount, { target: { value: '25' } })

    // The passport checkbox and the Back/Continue footer keep their exact
    // structure — no draft card mounts mid-typing.
    expect(structureBelow()).toBe(before)
    expect(screen.queryByText('Budget draft')).not.toBeInTheDocument()
    // Continue still arms on the valid amount alone.
    expect(screen.getByRole('button', { name: 'Review agent budget' })).toBeEnabled()
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
    // #1377 B: the pinned budget token is the wallet chain's USDC variant —
    // USDC.e on this Gnosis fixture — 6 decimals, address included.
    expect(body.allowances).toEqual([
      expect.objectContaining({
        token_symbol: 'USDC.e',
        token_address: '0x9999999999999999999999999999999999999999',
        allowance_amount: '10000000',
        reset_period_min: 1440,
      }),
    ])

    expect(await screen.findByText('Connect your agent')).toBeInTheDocument()
    expect(screen.getAllByText(/hv_setup_abc/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/public signing address/i).length).toBeGreaterThan(0)
    const modalText = screen.getByRole('dialog').textContent ?? ''
    expect(modalText).not.toMatch(/delegate_key|private_key|privateKey|sk_agent_/)
    // #1545 rendered-content pin (named headless equivalent — these lines sit
    // below the prompt block's scroll fold in screenshot evidence): the full
    // prompt renders the --json discoverability sentence and names the gate
    // "the budget", never "agent rules".
    expect(modalText).toContain('Appending --json is the ONLY permitted change to the command above.')
    expect(modalText).toContain('return to Haven to approve the budget')
    expect(modalText).not.toContain('approve the agent rules')
  })

  it('omits issue_passport by default (#1072)', async () => {
    renderModal()
    await fillAndCreateSetup()
    const body = mockApiPost.mock.calls[0][1] as Record<string, unknown>
    expect(body.issue_passport).toBeUndefined()
  })

  it('sends issue_passport when the passport opt-in is checked (#1072)', async () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'Research Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    if (!screen.queryByPlaceholderText('Amount')) {
      fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    }
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /issue an agent passport/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Review agent budget' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
      await Promise.resolve()
    })

    const body = mockApiPost.mock.calls[0][1] as Record<string, unknown>
    expect(body.issue_passport).toBe(true)
  })

  it('confirms the passport choice on the review step before submitting (#1072)', async () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'Research Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    if (!screen.queryByPlaceholderText('Amount')) {
      fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    }
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } })

    // Unchecked by default — review step must say so, not stay silent.
    // #1411: the row restates the choice only ("Yes"/"No"), no longer a
    // sentence explaining what issuing means — that stays on the policy step.
    fireEvent.click(screen.getByRole('button', { name: 'Review agent budget' }))
    expect(screen.getByText('No')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /issue an agent passport/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Review agent budget' }))
    expect(screen.getByText('Yes')).toBeInTheDocument()
  })

  it('exposes local MCP only as an Advanced opt-in and sends local_mcp when chosen', async () => {
    renderModal()

    // Advanced affordance is visible for the default Claude Code row, which is
    // on the command path and so supports local MCP.
    fireEvent.click(screen.getByText('Advanced'))
    fireEvent.click(screen.getByRole('checkbox'))

    await fillAndCreateSetup()

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups',
      expect.objectContaining({ runtime: 'claude-code', local_mcp: true }),
    ))
  })

  it('hides the Advanced local MCP affordance for runtimes without local support', () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('Where will this agent run?'), {
      target: { value: 'cursor' },
    })

    expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
  })

  it('does not send local_mcp by default', async () => {
    renderModal()

    await fillAndCreateSetup()

    await waitFor(() => expect(mockApiPost).toHaveBeenCalled())
    const body = mockApiPost.mock.calls[0][1] as Record<string, unknown>
    expect(body.local_mcp).toBeUndefined()
  })

  it('produces a byte-identical create-setup payload for fixed inputs across steps 1-3 (#1411)', async () => {
    // #1411 acceptance criterion: the design pass over Details/Policy/Review
    // must not change the setup payload for the same inputs. This walks all
    // three steps with one fixed set of inputs — every field the payload
    // carries (name, description, runtime, wallet, token, atomic amount,
    // reset_period_min, passport opt-in, local MCP flag) — and asserts the
    // EXACT request body (not `objectContaining`), so any future step-level
    // markup change that quietly drops or renames a field fails here.
    renderModal()

    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'Research Agent' },
    })
    fireEvent.change(screen.getByLabelText('Description (optional)'), {
      target: { value: 'Handles vendor invoices' },
    })
    fireEvent.change(screen.getByLabelText('Where will this agent run?'), {
      target: { value: 'cowork' },
    })
    fireEvent.click(screen.getByText('Advanced'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '42.50' } })
    fireEvent.change(screen.getByLabelText('Budget reset period'), { target: { value: '10080' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /issue an agent passport/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Review agent budget' }))

    // Review restates the exact choices made above — Runtime and Budget rows
    // in particular are new to this pass (#1411); assert them here too so a
    // silently-dropped row and a silently-changed payload are both caught.
    expect(screen.getByText('Cowork')).toBeInTheDocument()
    expect(screen.getByText(/42\.50 USDC\.e per week/)).toBeInTheDocument()
    expect(screen.getByText('Yes')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/agent-connection-setups', expect.any(Object)))
    const body = mockApiPost.mock.calls[0][1] as Record<string, unknown>
    expect(body).toEqual({
      name: 'Research Agent',
      description: 'Handles vendor invoices',
      safe_id: SAFE.id,
      runtime: 'cowork',
      local_mcp: true,
      allowances: [
        {
          token_address: '0x9999999999999999999999999999999999999999',
          token_symbol: 'USDC.e',
          allowance_amount: '42500000',
          reset_period_min: 10080,
        },
      ],
      issue_passport: true,
    })
  })

  it('defaults the wallet picker to a supported-chain wallet and does not offer the legacy Gnosis one', () => {
    // Regression: with a leftover Gnosis (unsupported) wallet as the default,
    // the picker used to default to it and snap back to it when the user tried
    // to switch to a Base wallet (the chain change re-ran the init effect).
    mockUseAuth.mockReturnValue({
      user: { safes: [SAFE, BASE_SAFE] }, // SAFE = Gnosis (default, unsupported), BASE_SAFE = Base
      activeSafe: SAFE,
    })

    renderModal({ safeAddress: '', safeId: null })

    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'Research Agent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    const select = screen.getByLabelText('Spend from') as HTMLSelectElement
    // Defaults to the supported Base wallet, not the Gnosis default.
    expect(select.value).toBe(BASE_SAFE.id)
    // The unsupported Gnosis wallet is not offered for a new agent.
    expect(within(select).getByRole('option', { name: 'Base wallet' })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: 'Operating wallet' })).not.toBeInTheDocument()
  })

  // #1682: the picker is a flat list of PRODUCT NAMES. No umbrella row, no
  // optgroups, Claude Code selected by default, and the catch-all last.
  it('offers exactly the named runtime rows, with Claude Code selected by default', () => {
    renderModal()

    const select = screen.getByLabelText('Where will this agent run?') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Claude Code',
      'Claude Desktop',
      'Codex (CLI or Desktop)',
      'Cowork',
      'Cursor',
      'Hermes Agent',
      'OpenClaw',
      'VS Code (incl. Insiders)',
      'Not listed / other',
    ])
    expect(select.value).toBe('claude-code')
    // The umbrella label #1682 removed: no row asks the user to classify
    // their own app, and no <optgroup> reintroduces the taxonomy.
    expect(screen.queryByText(/AI agent \(Claude Code, Codex, Cowork\)/)).not.toBeInTheDocument()
    expect(select.querySelector('optgroup')).toBeNull()
  })

  // #1682 acceptance: the three command-path rows are LABELS over one
  // behaviour — the identical flag-free command — differing only in the id
  // they record. #1672's detection is what decides the config, so a row that
  // sent its own --runtime hint would reintroduce the bug that closed.
  it.each(['claude-code', 'codex', 'cowork'])(
    'sends the %s row down the command path with the Advanced local-MCP affordance',
    async (runtime) => {
      renderModal()

      fireEvent.change(screen.getByLabelText('Where will this agent run?'), {
        target: { value: runtime },
      })
      expect(screen.getByText('Advanced')).toBeInTheDocument()

      await fillAndCreateSetup()

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
        '/agent-connection-setups',
        expect.objectContaining({ runtime }),
      ))
      // The pre-run approval heads-up covers the whole command path, not one
      // named row (#1672 review).
      expect(await screen.findByText(/Your agent app may ask you to approve running the setup command/i)).toBeInTheDocument()
      expect(screen.getByText(/It includes your approval for the exact local setup actions/i)).toBeInTheDocument()
    },
  )

  // The snippet rows are the other modality: no local-MCP opt-in, and the
  // command-path approval heads-up must not appear for them.
  it.each(['claude-desktop', 'cursor', 'openclaw', 'vscode', 'hermes', 'other'])(
    'keeps the %s row on the snippet path, without the command-path affordances',
    async (runtime) => {
      renderModal()

      fireEvent.change(screen.getByLabelText('Where will this agent run?'), {
        target: { value: runtime },
      })
      expect(screen.queryByText('Advanced')).not.toBeInTheDocument()

      await fillAndCreateSetup()

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
        '/agent-connection-setups',
        expect.objectContaining({ runtime }),
      ))
      expect(await screen.findByText('Connect your agent')).toBeInTheDocument()
      expect(screen.queryByText(/may ask you to approve running the setup command/i)).not.toBeInTheDocument()
    },
  )

  // Regression (#1682 review): `resetForm` and the initial state each held
  // their own default-runtime literal, so renaming the default left the reset
  // pointing at an id with no matching <option>. Reopening the modal then
  // posted the stale id — and in a real browser showed an EMPTY picker. Both
  // now read one constant; this walks close → reopen, the only path that runs
  // `resetForm`.
  //
  // The PAYLOAD assertion is the one that bites: verified by mutation, jsdom
  // still reports the old value on a select whose option no longer exists, so
  // the `select.value` checks below are a cheap sanity guard, NOT the catch.
  it('reopens on the default row after a close, not a stale runtime id', async () => {
    render(<ReopenableModal />)

    fireEvent.change(screen.getByLabelText('Where will this agent run?'), {
      target: { value: 'cursor' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen modal' }))

    const select = screen.getByLabelText('Where will this agent run?') as HTMLSelectElement
    expect(select.value).toBe('claude-code')

    await fillAndCreateSetup()
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups',
      expect.objectContaining({ runtime: 'claude-code' }),
    ))
  })

  // #1672: Codex Desktop has no picker row of its own — the Codex row covers
  // both, and the connector detects which one it is actually executing
  // inside. BEFORE the connector runs the specific runtime is unknowable, so
  // the approval heads-up stays generic (the review found a codex-desktop-only
  // gate would render AFTER the user already faced the dialog).
  it('does not offer a Codex Desktop row of its own', () => {
    renderModal()

    expect(screen.queryByRole('option', { name: 'Codex Desktop' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Codex (CLI or Desktop)' })).toBeInTheDocument()
  })

  // Once the connector's /resolve reports the detected runtime (which happens
  // while the setup row is still awaiting_connection — metadata updates at
  // resolve, status flips at register), the copy sharpens to name the app.
  it('sharpens the approval heads-up to Codex Desktop once the connector reports that runtime', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus({ status: 'awaiting_connection', runtime: 'codex-desktop' }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()
    await fillAndCreateSetup()

    expect(await screen.findByText(/Codex Desktop may ask you to approve running the setup command/i)).toBeInTheDocument()
  })

  it('supports Hermes Agent as a first-class runtime option', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      // The connector in a Hermes environment reports hermes (#1672) — the
      // runtime-specific restart copy keys off this reported value.
      data: connectedSetupStatus({ status: 'active', runtime: 'hermes' }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()

    expect(screen.getByRole('option', { name: 'Hermes Agent' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Where will this agent run?'), {
      target: { value: 'hermes' },
    })
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument()

    await fillAndCreateSetup()

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups',
      expect.objectContaining({
        runtime: 'hermes',
      }),
    ))
    expect(await screen.findByText(/Restart Hermes in a new session/i)).toBeInTheDocument()
    expect(screen.getByText(/Gateway users should run \/restart/i)).toBeInTheDocument()
    expect(screen.getByText(/pip install mcp/i)).toBeInTheDocument()
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

    // The single anchor summary headline replaces the old stack of green
    // success / awaiting-approval / "Ready for Haven approval" / yellow
    // restart callouts. Restart guidance moves to the post-approval state.
    expect(await screen.findByText('Approve agent budget')).toBeInTheDocument()
    // #1377 C: the legacy approval renders inside the one step-4 shell.
    expect(screen.getByLabelText('Connection progress')).toBeInTheDocument()
    // #1418: ONE status voice on step 4 — the shell ticker above is the only
    // progress chrome; the wizard band must NOT stack on top of it.
    expect(screen.queryByLabelText(/^Step \d+ of \d+$/)).not.toBeInTheDocument()
    expect(screen.getByText(/Local connection verified/i)).toBeInTheDocument()
    expect(screen.getByText(/You sign to give Research Agent authority to spend/i)).toBeInTheDocument()
    expect(screen.queryByText('Connected locally')).not.toBeInTheDocument()
    expect(screen.queryByText('Ready for Haven approval')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent restart prepared')).not.toBeInTheDocument()
    expect(screen.queryByText(/until that approval is completed/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeInTheDocument()
    expect(screen.queryByText(/active spending today/i)).not.toBeInTheDocument()
  })

  it('a DELEGATION account approves the budget IN the modal — never the wallet approval (#1073)', async () => {
    // A Hybrid DeleGator (possibly passkey-only) has no AllowanceModule and
    // maybe no connectable EOA — the legacy approval step is a dead end.
    //
    // #1070 replaced that dead end with a hand-off to the agent page, which
    // made the user RE-ENTER the budget they already set at the policy step.
    // #1073 completes the grant here instead: the budget is restated, not
    // re-typed, and the signature is taken where the rules are shown.
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    useDelegationAccount()
    renderModal()
    await fillAndCreateSetup()

    expect(await screen.findByText('Approve agent budget')).toBeInTheDocument()
    // The budget is RESTATED from the setup — never an empty field to refill.
    expect(screen.getByText(/10\.00 USDC\.e per day/)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Amount')).not.toBeInTheDocument()

    // #1377 C: the delegation approval renders inside the one step-4 shell.
    expect(screen.getByLabelText('Connection progress')).toBeInTheDocument()
    // The legacy approval UI must be absent — that is the original bug. Both
    // rails' approve buttons now share the label 'Approve budget' (#1572:
    // one gate, one name), so the legacy screen is identified by its own
    // description copy ("You sign to give…" vs the delegation rail's
    // "You sign once to give…") instead of the button label:
    expect(document.body.textContent).not.toContain('You sign to give')
    expect(document.body.textContent).not.toContain('still connecting to the wallet network')
    // ...and so must the hand-off that replaced it.
    expect(document.body.textContent).not.toContain("Set the agent's budget to activate it")

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
      await Promise.resolve()
    })

    // Granted with the policy step's budget, UNPINNED: a recipient-pinned
    // budget cannot fund the agent wallet and would lock it out of standard
    // x402.
    expect(mockGrant).toHaveBeenCalledWith({
      tokenAddress: '0x9999999999999999999999999999999999999999',
      recipientAddress: null,
      budgetAtomic: '10000000',
      periodSeconds: 86_400,
    })
    // Haven is then asked to confirm — it verifies the signed budget itself,
    // so the body carries no assertion.
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith(
        '/agent-connection-setups/setup-1/budget-approval',
        {},
      ),
    )
  })

  it('a cancelled signature re-arms the delegation step in place — not an error (#1073)', async () => {
    // Dismissing the passkey sheet is the most common interaction here. It
    // means "not yet", not "something broke": the step must stay live, the
    // copy must not be an error, and nothing may be reported to Haven.
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockGrant.mockResolvedValue({ ok: false, reason: 'cancelled' })
    useDelegationAccount()
    renderModal()
    await fillAndCreateSetup()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Approve budget' }))
      await Promise.resolve()
    })

    expect(screen.getByText(/No signature yet — nothing changed/)).toBeInTheDocument()
    // Still on the approval step, still actionable.
    expect(screen.getByRole('button', { name: 'Approve budget' })).toBeEnabled()
    expect(screen.getByText('Approve agent budget')).toBeInTheDocument()
    // A cancelled signature is not a failure and not an approval.
    expect(document.body.textContent).not.toMatch(/could not set the budget/i)
    expect(mockApiPost).not.toHaveBeenCalledWith(
      '/agent-connection-setups/setup-1/budget-approval',
      {},
    )
  })

  it('after the budget is signed there is no "Cancel setup" left to offer (#1073)', async () => {
    // The signature already activated the agent, in its own transaction. A
    // cancel here would promise a reversal Haven cannot perform and would
    // report the setup dead while a live, spending agent remained.
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    // Grant succeeds; the follow-up confirm fails — the partial-failure window.
    mockApiPost.mockImplementation(async (url: string) => {
      if (String(url).includes('/budget-approval')) throw new Error('network')
      return { setup_id: 'setup-1', status: 'awaiting_connection', setup_token: 't', expires_at: '2099-01-01T00:00:00.000Z', connector_command: 'cmd', setup_prompt: 'prompt' }
    })
    useDelegationAccount()
    renderModal()
    await fillAndCreateSetup()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Approve budget' }))
      await Promise.resolve()
    })

    // Honest about what DID happen: the money authority is real.
    expect(await screen.findByText('Budget set — finishing up')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel setup' })).not.toBeInTheDocument()
    // A visible "Close" in the step footer — not the header's icon button,
    // which is aria-labelled the same way.
    expect(
      screen.getAllByRole('button', { name: 'Close' }).some((b) => b.textContent === 'Close'),
    ).toBe(true)
  })

  it('keeps the legacy step-4 footer shape: cancel beside approve, approve carrying the weight (#1073)', async () => {
    // A rendered review caught the first cut inverting this — approve was a
    // small button above a full-width Cancel, making the loudest element on a
    // money screen the one that does nothing.
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    useDelegationAccount()
    renderModal()
    await fillAndCreateSetup()

    const approve = await screen.findByRole('button', { name: 'Approve budget' })
    const cancel = screen.getByRole('button', { name: 'Cancel setup' })
    // Same row...
    expect(approve.parentElement).toBe(cancel.parentElement)
    // ...both sharing the width, approve rendered last so it reads as primary.
    expect(approve.className).toContain('flex-1')
    expect(cancel.className).toContain('flex-1')
    expect(cancel.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers the SAME verification disclosure as the legacy step (#1073)', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    useDelegationAccount()
    renderModal()
    await fillAndCreateSetup()

    await screen.findByText('Approve agent budget')
    expect(screen.getByText('Verification details')).toBeInTheDocument()
    expect(screen.getByText('0x3333333333333333333333333333333333333333')).toBeInTheDocument()
    // Safe-only row must NOT appear on this rail — one signature IS the approval.
    expect(screen.queryByText('Approvals required')).not.toBeInTheDocument()
  })

  it('a wrong-network owner wallet gets a switch action, not a dead connect button (#1073)', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    // Connected, but on a different chain than the account: useActiveSigner
    // returns null, so the budget hook is not ready.
    mockUseAccount.mockReturnValue({ address: SIGNER_ADDRESS, chain: { id: 8453 } })
    mockUseActiveSigner.mockReturnValue(null)
    mockDelegationBudgetReady.mockReturnValue(false)
    useDelegationAccount()
    renderModal()
    await fillAndCreateSetup()

    await screen.findByText('Approve agent budget')
    expect(screen.getByRole('button', { name: /^Switch to / })).toBeInTheDocument()
    expect(screen.getByText(/Switch networks to approve the budget/)).toBeInTheDocument()
  })

  it('keeps the stepper at 4 steps on the delegation rail — the rail is not a step (#1073)', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    useDelegationAccount()
    renderModal()

    // The stepper mock reports "Step {current} of {total}": the TOTAL is 4 on
    // this rail exactly as on the legacy one — the rail changes the
    // instrument, never the shape of the flow. Asserted on step 1 because
    // since #1418 the wizard band no longer renders on step 4 at all (the
    // shell ticker is the one status voice there).
    expect(screen.getByLabelText('Step 1 of 4')).toBeInTheDocument()

    await fillAndCreateSetup()
    await screen.findByText('Approve agent budget')
    expect(screen.queryByLabelText(/^Step \d+ of \d+$/)).not.toBeInTheDocument()
  })

  it('delegation setup takes ONE budget — further tokens are added later (#1073)', async () => {
    // Each grant is its own signature: N tokens would mean N consecutive
    // passkey prompts and a half-approved agent if one fails.
    useDelegationAccount()
    renderModal()
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research Agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } })

    // The add-another affordance is gone, replaced by an explanation.
    expect(screen.queryByRole('button', { name: 'Add budget' })).not.toBeInTheDocument()
    expect(screen.getByText(/Setup grants one .*budget/)).toBeInTheDocument()
    // ...and the flow still continues.
    expect(screen.getByRole('button', { name: 'Review agent budget' })).toBeEnabled()
  })

  it('uses non-wallet copy on the approval screen', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()
    await fillAndCreateSetup()

    // Regression: "wallet" language was ambiguous (Safe vs. signing EOA vs.
    // passkey). Step copy should be direct and not reference wallet on the
    // approval screen.
    expect(await screen.findByText('Approve the agent budget')).toBeInTheDocument() // header subtitle
    expect(
      screen.getByText(/^You sign to give Research Agent authority to spend/),
    ).toBeInTheDocument()
    const screenText = document.body.textContent ?? ''
    expect(screenText).not.toContain('Approve the agent budget in your wallet')
    expect(screenText).not.toContain('Your wallet signs')
    expect(screenText).not.toContain('Return to Haven and approve')
  })

  it('names the granted authority on the approved screen, and states status once (#1394)', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus({ status: 'active' }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()
    await fillAndCreateSetup()

    // The success line names what the user just granted, in the same shape the
    // connector prints in the agent's own terminal ("I can now spend up to
    // 25 USDC per day from your Haven wallet"). The fixture grants 10000000
    // atomic USDC.e (6 decimals) per 1440 minutes from "Operating wallet", so
    // every part of this sentence is derived, not hardcoded prose: a decimals
    // bug or a period-label regression breaks it.
    const grantLine = 'Research Agent can now spend up to 10.00 USDC.e per day from Operating wallet.'
    // Matched on the whole paragraph: the amount is wrapped in a .v2-tabular
    // span (design-system.md wants tabular numerals on every amount), and
    // getByText's default only joins an element's DIRECT text-node children,
    // so a plain string query would no longer see the sentence.
    expect(
      await screen.findByText(
        (_content, element) => element?.tagName === 'P' && element.textContent === grantLine,
      ),
    ).toBeInTheDocument()
    // The amount itself carries the tabular class, not the whole sentence.
    expect(document.querySelector('.v2-tabular')?.textContent).toBe('10.00 USDC.e per day')
    // Stated once, not once per render path.
    expect(countOccurrences(document.body.textContent ?? '', grantLine)).toBe(1)
    // ...and it leads with a heading rather than a badge, so the ending reads
    // as a conclusion instead of a fragment.
    expect(screen.getByText('Research Agent is ready to spend')).toBeInTheDocument()

    // ONE status voice. "Agent rules approved" used to appear twice in this
    // viewport — a success StatusBadge and the header subtitle — on top of the
    // shell ticker's "Approved". The ticker owns status now; nothing else may
    // restate it.
    expect(screen.queryByText('Agent rules approved')).not.toBeInTheDocument()
    expect(countOccurrences(document.body.textContent ?? '', 'Approved')).toBe(1)
    // The subtitle's job on this flow is to say what to DO; on the ending it
    // orients rather than restating the ticker. Asserted positively, not just
    // by the absence of the old string.
    expect(screen.getByText('What your agent can do now')).toBeInTheDocument()

    // Runtime-specific restart copy: Claude Code (the default) is a session
    // runtime, so users are not told to restart needlessly.
    expect(screen.getByText(/next Claude Code message/i)).toBeInTheDocument()
    expect(screen.getByText(/Haven tools wired/i)).toBeInTheDocument()
    expect(screen.queryByText('Agent restart prepared')).not.toBeInTheDocument()
  })

  it('falls back to the generic success line when no budget is available (#1394)', async () => {
    // A half-named authority ("can spend up to  from ") would read worse than
    // the abstract line, so an absent budget degrades rather than interpolates.
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus({ status: 'active', agent_budget: [] }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()
    await fillAndCreateSetup()

    expect(await screen.findByText('Your agent is ready to spend')).toBeInTheDocument()
    expect(screen.getByText('Your agent can now spend within budget.')).toBeInTheDocument()
    expect(screen.queryByText(/can now spend up to/)).not.toBeInTheDocument()
  })

  it('hides verification details behind a disclosure on the approval screen', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()
    await fillAndCreateSetup()

    // The truncated form sits inline as a verification check; the disclosure
    // exists so the full address + runtime status are one click away.
    // (We don't assert the full address is removed when collapsed — `<details>`
    // hides via CSS in browsers but still mounts the children in JSDOM.)
    expect(await screen.findByText(/Local connection verified/i)).toBeInTheDocument()
    expect(screen.getByText('Verification details')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Verification details'))
    expect(
      screen.getByText('0x3333333333333333333333333333333333333333'),
    ).toBeInTheDocument()
  })

  it('shows specific runtime setup recovery copy for local MCP failures', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus({
        install_status: {
          runtime_mcp_mode: 'local_stdio',
          hosted_mcp_configured: false,
          local_signer_configured: false,
          local_mcp_configured: false,
          credential_files_written: true,
          local_mcp_acknowledged: true,
          activation_command_available: false,
          restart_required: true,
          probe_result: 'local_stdio_mcp_runtime_install_failed',
          error_code: 'local_mcp_runtime_install_failed',
        },
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()

    await fillAndCreateSetup()

    // Runtime status detail lives behind the "Verification details" disclosure
    // — the pre-approval screen is calm by default; install diagnostics are a
    // click away when needed.
    fireEvent.click(await screen.findByText('Verification details'))
    expect(await screen.findByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText(/could not install Haven tools locally/i)).toBeInTheDocument()
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
        install_status: { credential_files_written: true, local_mcp_configured: true, local_mcp_acknowledged: true },
        approval: { status: 'pending_approval' },
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderModal()
    await fillAndCreateSetup()

    expect(await screen.findByText('Approval unavailable')).toBeInTheDocument()
    expect(screen.getByText(/Connect a wallet or use a passkey/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument()
  })

  it('renders the approval screen for the hosted MCP + signer topology', async () => {
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus({
        install_status: {
          runtime_mcp_mode: 'hosted_plus_signer',
          hosted_mcp_configured: true,
          local_signer_configured: true,
          local_mcp_configured: false,
          credential_files_written: true,
          local_mcp_acknowledged: false,
          activation_command_available: false,
          restart_required: true,
          probe_result: 'hosted_ok_local_signer_ready',
        },
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    renderModal()

    await fillAndCreateSetup()

    // The hosted topology must not get stuck on the local finalizing spinner.
    expect(await screen.findByRole('button', { name: 'Approve budget' })).toBeInTheDocument()
    expect(screen.queryByText('Finishing local setup')).not.toBeInTheDocument()
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
      fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
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
      100,
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

  it('uses the setup wallet for approval readiness when the selected wallet is stale', async () => {
    const refetch = vi.fn()
    const setupWalletStatus = connectedSetupStatus({
      haven_wallet: {
        id: BASE_SAFE.id,
        name: BASE_SAFE.name,
        address: BASE_SAFE.safe_address,
        chain_id: 8453,
        network: 'Base',
      },
      agent_budget: [{
        id: 'budget-base-usdc',
        token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        token_symbol: 'USDC',
        allowance_amount: '10000000',
        reset_period_min: 1440,
      }],
    })

    mockUseAuth.mockReturnValue({
      user: { safes: [SAFE, BASE_SAFE] },
      activeSafe: SAFE,
    })
    mockUseAgentConnectionSetupStatus.mockImplementation((setupId: string | null) => ({
      data: setupId ? setupWalletStatus : null,
      loading: false,
      error: null,
      refetch,
    }))
    mockUseSafeDetails.mockImplementation((safeAddress: string | null) =>
      safeAddress?.toLowerCase() === BASE_SAFE.safe_address.toLowerCase()
        ? {
            details: {
              address: BASE_SAFE.safe_address,
              threshold: 2,
              owners: [SIGNER_ADDRESS, '0x5555555555555555555555555555555555555555'],
            },
            loading: false,
            error: null,
          }
        : {
            details: { address: SAFE.safe_address, threshold: 1, owners: [SIGNER_ADDRESS] },
            loading: false,
            error: null,
          },
    )

    renderModal({ safeAddress: SAFE.safe_address, safeId: SAFE.id })
    await fillAndCreateSetup()

    expect(await screen.findByText('Approve agent budget')).toBeInTheDocument()
    expect(screen.getByText('Base wallet on Base')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit approval' })).toBeInTheDocument()
    expect(mockUseSafeDetails).toHaveBeenLastCalledWith(BASE_SAFE.safe_address, { chainId: 8453 })
    expect(mockUseSafeOperationGate).toHaveBeenLastCalledWith({
      safeAddress: BASE_SAFE.safe_address,
      chainId: 8453,
    })
    expect(mockUsePublicClient).toHaveBeenLastCalledWith({ chainId: 8453 })
    expect(mockUseActiveSigner).toHaveBeenLastCalledWith({
      safeAddress: BASE_SAFE.safe_address,
      chainId: 8453,
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit approval' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(mockProposeSafeTx).toHaveBeenCalled())
    expect(mockExecuteSafeTx).not.toHaveBeenCalled()
    expect(mockBuildAgentSetupTx).toHaveBeenCalledWith(
      BASE_SAFE.safe_address,
      '0x3333333333333333333333333333333333333333',
      [expect.objectContaining({
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: 10000000n,
        resetTimeMin: 1440,
      })],
      true,
      7n,
      8453,
    )
    expect(mockApiPost).toHaveBeenCalledWith(
      '/agent-connection-setups/setup-1/wallet-approval',
      expect.objectContaining({
        result: 'proposed',
        safe_tx_hash: SAFE_TX_HASH,
        chain_id: 8453,
        safe_address: BASE_SAFE.safe_address,
        delegate_address: '0x3333333333333333333333333333333333333333',
      }),
    )
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
      fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
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
      fireEvent.click(screen.getByRole('button', { name: 'Submit approval' }))
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
      fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
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
          connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_abc --api https://api.haven.example --ack-local-tools --runtime claude-code',
          setup_prompt: SETUP_PROMPT,
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
    // Extra explicit step: the warnings and create button stay hidden until
    // the user states they cannot run the connector.
    expect(screen.queryByRole('button', { name: 'Create manual credential' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /I really can't run the connector/i }))
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

  it('resets the manual fallback reveal after closing and reopening the modal', async () => {
    mockApiPost.mockImplementation(async (path: string) => {
      if (path === '/agent-connection-setups') {
        return {
          setup_id: 'setup-1',
          status: 'awaiting_connection',
          setup_token: 'hv_setup_abc',
          expires_at: '2099-01-01T00:00:00.000Z',
          connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_abc --api https://api.haven.example --ack-local-tools --runtime claude-code',
          setup_prompt: SETUP_PROMPT,
        }
      }
      return {}
    })

    render(<ReopenableModal />)

    await fillAndCreateSetup()
    fireEvent.click(screen.getByText('Manual credential fallback'))
    fireEvent.click(screen.getByRole('button', { name: /I really can't run the connector/i }))
    expect(screen.getByLabelText(/I understand this fallback shows/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen modal' }))

    await fillAndCreateSetup()
    fireEvent.click(screen.getByText('Manual credential fallback'))
    expect(screen.getByRole('button', { name: /I really can't run the connector/i })).toBeInTheDocument()
    expect(screen.queryByLabelText(/I understand this fallback shows/i)).not.toBeInTheDocument()
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
          connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_abc --api https://api.haven.example --ack-local-tools --runtime claude-code',
          setup_prompt: SETUP_PROMPT,
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
    fireEvent.click(screen.getByRole('button', { name: /I really can't run the connector/i }))
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
    expect(await screen.findByText('Approve agent budget')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve budget' }))
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
      100,
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
    fireEvent.click(screen.getByRole('button', { name: 'Review agent budget' }))

    expect(screen.getByText('Haven wallet unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create setup prompt' })).toBeDisabled()
  })

  it.each([
    ['approval_in_progress', 'Approval in progress'],
    ['proposed', 'Waiting for more approvals'],
    // #1394: this row carries `agent_budget: []`, so `active` renders the
    // generic heading — the same graceful-degradation path asserted above.
    ['active', 'Your agent is ready to spend'],
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

    // findAllByText, not findByText: the non-`active` rows still render their
    // title in both a StatusBadge and the header subtitle.
    const matches = await screen.findAllByText(title)
    expect(matches.length).toBeGreaterThan(0)
  })
})
