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
  isDelegationRailAccount,
  railBudgetRules,
  resolveConnectStepView,
  useAgentConnectionSetup,
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

describe('isDelegationRailAccount (#1069/#1070)', () => {
  it('is true for a delegator_hybrid selected wallet', () => {
    expect(isDelegationRailAccount({ account_type: 'delegator_hybrid' }, null)).toBe(true)
  })

  it('falls back to the active wallet when the selected wallet has no account_type', () => {
    expect(isDelegationRailAccount({}, { account_type: 'delegator_hybrid' })).toBe(true)
    expect(isDelegationRailAccount(null, { account_type: 'delegator_hybrid' })).toBe(true)
  })

  it('a legacy account_type on the selected wallet wins over a delegation active wallet', () => {
    expect(isDelegationRailAccount({ account_type: 'safe' }, { account_type: 'delegator_hybrid' })).toBe(false)
  })

  it('is false for legacy/absent account types', () => {
    expect(isDelegationRailAccount(null, null)).toBe(false)
    expect(isDelegationRailAccount({}, {})).toBe(false)
    expect(isDelegationRailAccount({ account_type: null }, { account_type: null })).toBe(false)
  })
})

describe('railBudgetRules (#1073)', () => {
  it('delegation setup takes exactly ONE budget', () => {
    expect(railBudgetRules(true, 0).budgetSlotsFull).toBe(false)
    expect(railBudgetRules(true, 1).budgetSlotsFull).toBe(true)
  })

  it('the legacy rail never fills its budget slots', () => {
    expect(railBudgetRules(false, 3).budgetSlotsFull).toBe(false)
  })

  it('the delegation rail does not offer a One-time (0) reset period', () => {
    const { resetPeriodOptions } = railBudgetRules(true, 0)
    expect(resetPeriodOptions.some((period) => period.value === 0)).toBe(false)
    expect(resetPeriodOptions.length).toBeGreaterThan(0)
  })

  it('the legacy rail keeps the full reset-period list including One-time', () => {
    const { resetPeriodOptions } = railBudgetRules(false, 0)
    expect(resetPeriodOptions.some((period) => period.value === 0)).toBe(true)
  })
})

describe('resolveConnectStepView (#1069/#1070 rail branch)', () => {
  const readyStatuses = ['connected_local', 'awaiting_wallet_approval'] as const

  it.each(readyStatuses)(
    'a DELEGATION account gets the in-modal budget approval on %s — never the legacy wallet step',
    (status) => {
      const view = resolveConnectStepView({
        visibleStatus: status,
        installStatus: CONFIGURED_INSTALL,
        isDelegationAccount: true,
        agentId: 'agent-1',
      })
      expect(view).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
    },
  )

  it.each(readyStatuses)('a LEGACY account gets the Safe wallet approval on %s', (status) => {
    const view = resolveConnectStepView({
      visibleStatus: status,
      installStatus: CONFIGURED_INSTALL,
      isDelegationAccount: false,
      agentId: 'agent-1',
    })
    expect(view).toEqual({ kind: 'legacy_approval' })
  })

  it('a delegation account without agent_id yet keeps finalizing — never routed away (#1073)', () => {
    const view = resolveConnectStepView({
      visibleStatus: 'connected_local',
      installStatus: CONFIGURED_INSTALL,
      isDelegationAccount: true,
      agentId: null,
    })
    expect(view).toEqual({ kind: 'finalizing_local' })
  })

  it('an install error still reaches the approval step, on the right rail', () => {
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
        isDelegationAccount: true,
        agentId: 'agent-1',
      }),
    ).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
    expect(
      resolveConnectStepView({
        visibleStatus: 'connected_local',
        installStatus: erroredInstall,
        isDelegationAccount: false,
        agentId: 'agent-1',
      }),
    ).toEqual({ kind: 'legacy_approval' })
  })

  it('connected_local without a configured runtime or error stays finalizing', () => {
    const view = resolveConnectStepView({
      visibleStatus: 'connected_local',
      installStatus: { ...CONFIGURED_INSTALL, local_mcp_configured: false, local_mcp_acknowledged: false },
      isDelegationAccount: false,
      agentId: 'agent-1',
    })
    expect(view).toEqual({ kind: 'finalizing_local' })
  })

  it('maps the simple statuses one-to-one', () => {
    const base = {
      installStatus: CONFIGURED_INSTALL,
      isDelegationAccount: false,
      agentId: 'agent-1',
    }
    expect(resolveConnectStepView({ ...base, visibleStatus: 'awaiting_connection' })).toEqual({ kind: 'waiting_for_connector' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'approval_in_progress' })).toEqual({ kind: 'approval_in_progress' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'proposed' })).toEqual({ kind: 'proposed' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'active' })).toEqual({ kind: 'active' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'expired' })).toEqual({ kind: 'expired' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'cancelled' })).toEqual({ kind: 'cancelled' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'failed' })).toEqual({ kind: 'failed' })
    expect(resolveConnectStepView({ ...base, visibleStatus: 'something_new' })).toEqual({ kind: 'unknown_status' })
    expect(resolveConnectStepView({ ...base, visibleStatus: undefined })).toBeNull()
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

  it('a delegator_hybrid wallet drives the delegation approval view (#1070)', async () => {
    mockUseAuth.mockReturnValue({
      user: { safes: [{ ...SAFE, account_type: 'delegator_hybrid' }] },
      activeSafe: { ...SAFE, account_type: 'delegator_hybrid' },
    })
    const { result } = renderFlow()

    expect(result.current.isDelegationAccount).toBe(true)
    await act(async () => {
      await result.current.handleCreateSetup()
    })

    expect(result.current.step).toBe('connect')
    expect(result.current.connectView).toEqual({ kind: 'delegation_approval', agentId: 'agent-1' })
  })

  it('a legacy wallet keeps the Safe wallet-approval view', async () => {
    const { result } = renderFlow()

    expect(result.current.isDelegationAccount).toBe(false)
    await act(async () => {
      await result.current.handleCreateSetup()
    })

    expect(result.current.step).toBe('connect')
    expect(result.current.connectView).toEqual({ kind: 'legacy_approval' })
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
})
