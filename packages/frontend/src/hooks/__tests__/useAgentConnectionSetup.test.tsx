/**
 * Direct unit tests for the connect-agent flow logic (#989) — no modal render.
 *
 * The rail-awareness branch (#1069/#1070: `account_type` decides delegation
 * vs legacy approval) broke live with ZERO coverage because it could only be
 * exercised by rendering a 2000-line component. These tests pin it at the
 * hook level.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE,
  mockUseAuth,
  mockUseSafeDetails,
  mockUseSafeOperationGate,
  mockUseAgentConnectionSetupStatus,
  mockUsePublicClient,
  mockUseActiveSigner,
  mockApiPost,
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
  mockUseAuth: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseSafeOperationGate: vi.fn(),
  mockUseAgentConnectionSetupStatus: vi.fn(),
  mockUsePublicClient: vi.fn(),
  mockUseActiveSigner: vi.fn(),
  mockApiPost: vi.fn(),
  mockUseAccount: vi.fn(),
  mockSwitchChain: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: (args: unknown) => mockUsePublicClient(args),
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
    get: vi.fn(),
  },
  getResolvedApiBaseUrl: () => 'https://api.haven.example',
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
  // Real predicate shape (#1079): narrows away the delegator_passkey variant.
  isSafeCapableSigner: (s: { type?: string } | null) => s !== null && s.type !== 'delegator_passkey',
}))

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

import {
  installIsReadyForApproval,
  railBudgetRules,
  resolveConnectStepView,
  runtimeIsConfigured,
  useAgentConnectionSetup,
  buildManualCredentialEnv,
  buildManualCredentialPrompt,
} from '@/hooks/useAgentConnectionSetup'

const CONFIGURED_INSTALL = {
  runtime_mcp_mode: 'local_stdio',
  hosted_mcp_configured: false,
  local_signer_configured: true,
  local_mcp_configured: true,
  credential_files_written: true,
  local_mcp_acknowledged: true,
  activation_command_available: false,
  restart_required: true,
  probe_result: 'local_stdio_mcp_ready',
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
    agent_budget: [],
    delegate_address: '0x3333333333333333333333333333333333333333',
    install_status: CONFIGURED_INSTALL,
    approval: { status: 'pending_approval', safe_tx_hash: null, tx_hash: null },
    ...overrides,
  }
}

describe('railBudgetRules (#1073)', () => {
  // #2413 dropped this helper's rail parameter: no legacy account reaches the
  // connect modal, so the "legacy never fills its slots" half had no reachable
  // input and its two cases went with it.
  it('setup takes exactly ONE budget', () => {
    expect(railBudgetRules(0).budgetSlotsFull).toBe(false)
    expect(railBudgetRules(1).budgetSlotsFull).toBe(true)
  })

  it('does not offer a One-time (0) reset period', () => {
    const { resetPeriodOptions } = railBudgetRules(0)
    expect(resetPeriodOptions.some((period) => period.value === 0)).toBe(false)
    expect(resetPeriodOptions.length).toBeGreaterThan(0)
  })
})

describe('resolveConnectStepView (#2413: no rail branch left)', () => {
  const readyStatuses = ['connected_local', 'awaiting_wallet_approval'] as const

  it.each(readyStatuses)(
    'a DELEGATION account gets the in-modal budget approval on %s — never the legacy wallet step',
    (status) => {
      const view = resolveConnectStepView({
        visibleStatus: status,
        installStatus: CONFIGURED_INSTALL,
        agentId: 'agent-1',
      })
      expect(view).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
    },
  )

  it('a delegation account without agent_id yet keeps finalizing — never routed away (#1073)', () => {
    const view = resolveConnectStepView({
      visibleStatus: 'connected_local',
      installStatus: CONFIGURED_INSTALL,
      agentId: null,
    })
    expect(view).toEqual({ kind: 'finalizing_local' })
  })

  it('an install error still reaches the approval step', () => {
    const erroredInstall = {
      ...CONFIGURED_INSTALL,
      local_mcp_configured: false,
      local_mcp_acknowledged: false,
      error_code: 'local_mcp_runtime_install_failed',
    }
    expect(
      resolveConnectStepView({
        visibleStatus: 'connected_local',
        installStatus: erroredInstall,
        agentId: 'agent-1',
      }),
    ).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
  })

  it('a manual credential fallback reaches the approval step without pretending its runtime was configured (#2472)', () => {
    const manualFallbackInstall = {
      ...CONFIGURED_INSTALL,
      hosted_mcp_configured: false,
      local_signer_configured: false,
      local_mcp_configured: false,
      local_mcp_acknowledged: false,
      manual_credential_fallback: true,
    }

    expect(runtimeIsConfigured(manualFallbackInstall)).toBe(false)
    expect(installIsReadyForApproval(manualFallbackInstall)).toBe(true)
    expect(
      resolveConnectStepView({
        visibleStatus: 'connected_local',
        installStatus: manualFallbackInstall,
        agentId: 'agent-1',
      }),
    ).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
  })

  it('connected_local without a configured runtime or error stays finalizing', () => {
    const view = resolveConnectStepView({
      visibleStatus: 'connected_local',
      installStatus: { ...CONFIGURED_INSTALL, local_mcp_configured: false, local_mcp_acknowledged: false },
      agentId: 'agent-1',
    })
    expect(view).toEqual({ kind: 'finalizing_local' })
  })

  it('maps the simple statuses one-to-one', () => {
    const base = {
      installStatus: CONFIGURED_INSTALL,
      agentId: 'agent-1',
    }
    expect(resolveConnectStepView({ ...base, visibleStatus: 'awaiting_connection' })).toEqual({ kind: 'waiting_for_connector' })
    // `approval_in_progress` and `proposed` were the legacy wallet-approval
    // states; #2413 removed their mapping with the rail that produced them.
    expect(resolveConnectStepView({ ...base, visibleStatus: 'active' })).toEqual({ kind: 'active' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'expired' })).toEqual({ kind: 'expired' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'cancelled' })).toEqual({ kind: 'cancelled' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'failed' })).toEqual({ kind: 'failed' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'something_new' })).toEqual({ kind: 'unknown_status' })
    expect(resolveConnectStepView({ ...base, visibleStatus: undefined })).toBeNull()
  })
})

describe('manual credential renderings (#2482)', () => {
  const input = {
    apiKey: 'sk_agent_render_test',
    delegatePrivateKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    delegateAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    apiBaseUrl: 'https://api.haven.example',
    hostedMcpUrl: 'https://mcp.haven.example',
  }

  it('builds the .env block as the five HAVEN_* lines the SDK reads, values verbatim', () => {
    const env = buildManualCredentialEnv(input)
    expect(env.split('\n')).toEqual([
      'HAVEN_API_KEY=sk_agent_render_test',
      'HAVEN_DELEGATE_KEY=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'HAVEN_DELEGATE_ADDRESS=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'HAVEN_API_URL=https://api.haven.example',
      'HAVEN_MCP_URL=https://mcp.haven.example',
    ])
  })

  it('carries the SAME five values in the prose prompt — no information is dropped (#2482)', () => {
    const prompt = buildManualCredentialPrompt({
      agentName: 'Research Agent',
      havenWallet: 'Operating wallet on Gnosis',
      budgets: ['10 USDC every day'],
      ...input,
    })
    for (const line of buildManualCredentialEnv(input).split('\n')) {
      expect(prompt).toContain(line)
    }
    expect(prompt).toContain('Manual Haven credential for Research Agent')
  })
})

describe('useAgentConnectionSetup — rail awareness without rendering the modal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAuth.mockReturnValue({ user: { safes: [SAFE] }, activeSafe: SAFE })
    mockUseSafeDetails.mockReturnValue({
      details: { address: SAFE.safe_address, threshold: 1, owners: ['0x2222222222222222222222222222222222222222'] },
      loading: false,
      error: null,
    })
    mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
    mockUsePublicClient.mockReturnValue({})
    mockUseAccount.mockReturnValue({ address: undefined, chain: undefined })
    mockUseActiveSigner.mockReturnValue({ type: 'eoa', address: '0x2222222222222222222222222222222222222222', walletClient: {} })
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockApiPost.mockResolvedValue({
      setup_id: 'setup-1',
      status: 'awaiting_connection',
      setup_token: 'hv_setup_abc',
      expires_at: '2099-01-01T00:00:00.000Z',
      connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_abc',
      setup_prompt: 'prompt',
    })
  })

  function renderFlow() {
    return renderHook(() =>
      useAgentConnectionSetup({
        open: true,
        onClose: vi.fn(),
        safeAddress: SAFE.safe_address,
        safeId: SAFE.id,
      }),
    )
  }

  // #2413 removed `isDelegationAccount` from the flow: every account the API
  // returns is on the delegation rail, so the flag had one value. What this
  // case pins is the outcome it was a proxy for — setup reaches the in-modal
  // budget approval — which is still falsifiable.
  it('drives the delegation approval view (#1070)', async () => {
    mockUseAuth.mockReturnValue({
      user: { safes: [{ ...SAFE, account_type: 'delegator_hybrid' }] },
      activeSafe: { ...SAFE, account_type: 'delegator_hybrid' },
    })
    const { result } = renderFlow()

    await act(async () => {
      await result.current.handleCreateSetup()
    })

    expect(result.current.step).toBe('connect')
    expect(result.current.connectView).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
  })

  it('flags a connected-but-wrong-chain wallet instead of treating it as absent (#1070)', () => {
    // Connected to Base (8453) while the approval needs Gnosis (100):
    // useActiveSigner returns null, so without the explicit detection the gate
    // would read as "no wallet" and offer a dead connect button.
    mockUseAccount.mockReturnValue({ address: '0x2222222222222222222222222222222222222222', chain: { id: 8453 } })
    mockUseActiveSigner.mockReturnValue(null)
    const { result } = renderFlow()

    expect(result.current.isWrongChain).toBe(true)
    expect(result.current.approvalChainName).not.toBe('the required network')
  })

  it('a generated manual credential keeps the budget-approval step reachable when acknowledged (#2482/#2472/#2475)', async () => {
    // The #2472/#2475 wiring: registering with connector_version
    // 'browser-manual-fallback' is what the backend turns into
    // install_status.manual_credential_fallback — the marker that lets this
    // path reach the same owner-signed budget approval as every other.
    mockUseAgentConnectionSetupStatus.mockReturnValue({
      data: connectedSetupStatus({
        install_status: {
          ...CONFIGURED_INSTALL,
          hosted_mcp_configured: false,
          local_signer_configured: false,
          local_mcp_configured: false,
          local_mcp_acknowledged: false,
          manual_credential_fallback: true,
        },
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockApiPost.mockImplementation(async (path: string) => {
      if (path === '/agent-connection-setups/resolve') {
        return {
          agent: { name: 'Research Agent', description: null },
          haven_wallet: {
            id: SAFE.id,
            name: SAFE.name,
            address: SAFE.safe_address,
            chain_id: 100,
            network: 'Gnosis',
          },
          agent_budget: [],
          challenge: { id: 'challenge-1', message: 'Sign to prove control of this delegate address' },
          hosted_mcp_url: 'https://mcp.haven.example',
        }
      }
      if (path === '/agent-connection-setups/register') {
        return {
          setup_id: 'setup-1',
          agent_id: 'agent-1',
          status: 'connected_local',
          delegate_address: '0x3333333333333333333333333333333333333333',
          hosted_mcp_url: 'https://mcp.haven.example',
        }
      }
      return {
        setup_id: 'setup-1',
        status: 'awaiting_connection',
        setup_token: 'hv_setup_abc',
        expires_at: '2099-01-01T00:00:00.000Z',
        connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_abc',
        setup_prompt: 'prompt',
      }
    })
    const { result } = renderFlow()

    await act(async () => {
      await result.current.handleCreateSetup()
    })
    await act(async () => {
      await result.current.handleCreateManualCredential()
    })

    expect(result.current.manualCredential).not.toBeNull()
    // The generate action still registers with the fallback connector version —
    // removing this line would strand the path before budget approval.
    const registerCall = mockApiPost.mock.calls.find(
      ([path]) => path === '/agent-connection-setups/register',
    )
    expect(registerCall?.[1]).toMatchObject({
      connector_version: 'browser-manual-fallback',
    })
    // While the credential is unacknowledged the screen stays on the waiting
    // view so the user can copy it; acknowledging advances to budget approval.
    expect(result.current.connectView).toEqual({ kind: 'waiting_for_connector' })

    await act(async () => {
      await result.current.handleContinueAfterManualCredential()
    })
    expect(result.current.manualCredentialAcknowledged).toBe(true)
    expect(result.current.connectView).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
  })
})
