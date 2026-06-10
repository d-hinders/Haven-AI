import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseAuth,
  mockUseAgents,
  mockUseOnChainAllowances,
  mockUsePublicClient,
  mockUseSafeDetails,
  mockUseActiveSigner,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseOnChainAllowances: vi.fn(),
  mockUsePublicClient: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseActiveSigner: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: () => mockUsePublicClient(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useOnChainAllowances', () => ({
  useOnChainAllowances: (...args: unknown[]) => mockUseOnChainAllowances(...args),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (...args: unknown[]) => mockUseSafeDetails(...args),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => mockUseActiveSigner(),
}))

vi.mock('../ConnectAgent2Modal', () => ({
  default: () => null,
}))

vi.mock('../EditAgentModal', () => ({
  default: ({
    agent,
    safeAddress,
    chainId,
  }: {
    agent: { name: string }
    safeAddress: string
    chainId: number
  }) => (
    <div data-testid="edit-agent-modal">
      {agent.name}|{safeAddress}|{chainId}
    </div>
  ),
}))

vi.mock('../ConfirmDialog', () => ({
  default: () => null,
}))

import AgentPanel from '../AgentPanel'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
}

function baseAgent(overrides = {}) {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x2222222222222222222222222222222222222222',
    safe_id: 'safe-1',
    safe_address: SAFE.safe_address,
    safe_name: 'Main account',
    safe_chain_id: 100,
    status: 'active',
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    ...overrides,
  }
}

describe('AgentPanel last-activity metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    mockUseAuth.mockReturnValue({ activeSafe: SAFE })
    mockUseAgents.mockReturnValue({
      agents: [
        baseAgent({
          id: 'agent-1',
          name: 'Research agent',
          mcp_last_seen_at: '2026-06-01T10:00:00Z',
        }),
        baseAgent({
          id: 'agent-2',
          name: 'Travel agent',
          delegate_address: '0x3333333333333333333333333333333333333333',
          mcp_last_seen_at: null,
        }),
      ],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      deleteAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseSafeDetails.mockReturnValue({ details: null })
    mockUsePublicClient.mockReturnValue({})
    mockUseActiveSigner.mockReturnValue(null)
    mockUseOnChainAllowances.mockReturnValue({
      data: new Map(),
      loading: false,
      onChainDelegates: [],
      refetch: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows populated and empty last-activity states without a default active badge', () => {
    render(<AgentPanel />)

    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('Travel agent')).toBeInTheDocument()
    expect(screen.getByText('Last activity 2h ago')).toBeInTheDocument()
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
    expect(screen.queryByText('active')).not.toBeInTheDocument()
  })

  it('only exposes inline budget edit and revoke for agents on the active Haven wallet', () => {
    const activeDelegate = '0x2222222222222222222222222222222222222222'
    const baseDelegate = '0x4444444444444444444444444444444444444444'
    const addressOnlyDelegate = '0x5555555555555555555555555555555555555555'
    mockUseAgents.mockReturnValue({
      agents: [
        baseAgent({
          id: 'agent-active',
          name: 'Gnosis agent',
          delegate_address: activeDelegate,
          safe_id: 'safe-1',
          safe_name: 'Main account',
          safe_chain_id: 100,
        }),
        baseAgent({
          id: 'agent-base',
          name: 'Base agent',
          delegate_address: baseDelegate,
          safe_id: 'safe-base',
          safe_address: '0x3333333333333333333333333333333333333333',
          safe_name: 'Base account',
          safe_chain_id: 8453,
          allowances: [{
            id: 'allowance-base-usdc',
            agent_id: 'agent-base',
            token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            token_symbol: 'USDC',
            allowance_amount: '1000000',
            reset_period_min: 1440,
          }],
        }),
        baseAgent({
          id: 'agent-address-only',
          name: 'Address-only Base agent',
          delegate_address: addressOnlyDelegate,
          safe_id: null,
          safe_address: '0x3333333333333333333333333333333333333333',
          safe_name: 'Base account',
          safe_chain_id: 8453,
        }),
      ],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      deleteAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseOnChainAllowances.mockReturnValue({
      data: new Map(),
      loading: true,
      onChainDelegates: [],
      refetch: vi.fn(),
    })

    const { rerender } = render(<AgentPanel />)

    expect(mockUseOnChainAllowances).toHaveBeenCalledWith(
      SAFE.safe_address,
      [activeDelegate],
      SAFE.chain_id,
    )
    expect(screen.getByRole('button', { name: 'Edit Gnosis agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke Gnosis agent' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Base agent' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke Base agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open details for Base agent' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Address-only Base agent' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke Address-only Base agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open details for Address-only Base agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause Base agent' })).toBeInTheDocument()
    expect(
      screen.getAllByText((_, node) => node?.textContent === '1.00 USDC per day').length,
    ).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Gnosis agent' }))
    expect(screen.getByTestId('edit-agent-modal')).toHaveTextContent(
      `Gnosis agent|${SAFE.safe_address}|${SAFE.chain_id}`,
    )

    mockUseAuth.mockReturnValue({
      activeSafe: {
        ...SAFE,
        id: 'safe-other',
      },
    })
    rerender(<AgentPanel />)
    expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument()
  })
})

describe('AgentPanel unmanaged-delegate suppression', () => {
  const NEW_DELEGATE = '0x9999999999999999999999999999999999999999'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    vi.resetModules()
    mockUseAuth.mockReturnValue({ activeSafe: SAFE })
    // No DB agents yet — mirrors the race window after wallet approval has
    // landed on-chain but before the backend flips the agent from
    // `pending_approval` → `active`.
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      deleteAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseSafeDetails.mockReturnValue({ details: null })
    mockUsePublicClient.mockReturnValue({})
    mockUseActiveSigner.mockReturnValue(null)
    // The delegate IS on-chain (its allowance just landed). Without the
    // suppression, AgentPanel would tag it as "Unmanaged Delegate / network
    // only" because it's not in `managedDelegates`.
    mockUseOnChainAllowances.mockReturnValue({
      data: new Map([
        [NEW_DELEGATE.toLowerCase(), {
          // Shape matches AllowanceInfo in lib/allowance-module.ts so the
          // UnmanagedDelegateCard's <AllowanceBar> renders without crashing
          // — `token` is the address, `amount` and `spent` are bigints.
          allowances: [{
            token: '0xddAfbb505ad214D7b80b1f830fcCc89B60fb7A83', // Gnosis USDC.e
            amount: 1_000_000n,
            spent: 0n,
            resetTimeMin: 1440,
            lastResetMin: 0,
            nonce: 0,
          }],
        }],
      ]),
      loading: false,
      onChainDelegates: [NEW_DELEGATE],
      refetch: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not classify a freshly-approved delegate as Unmanaged Delegate', async () => {
    // Re-mock ConnectAgent2Modal to give the test a trigger for the
    // onSetupUpdated callback — the real modal fires this after wallet
    // approval lands on-chain.
    vi.doMock('../ConnectAgent2Modal', () => ({
      default: (props: { onSetupUpdated?: (info?: { delegateAddress?: string | null }) => void }) => (
        <button
          type="button"
          data-testid="fake-setup-updated"
          onClick={() => props.onSetupUpdated?.({ delegateAddress: NEW_DELEGATE })}
        >
          fire onSetupUpdated
        </button>
      ),
    }))
    const { default: AgentPanelFresh } = await import('../AgentPanel')
    render(<AgentPanelFresh />)

    // Sanity: with no suppression and no managed agent, the delegate would
    // render as Unmanaged before the click. After firing onSetupUpdated with
    // the matching delegate, the Unmanaged card must disappear.
    expect(screen.getByText('Unmanaged Delegate')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('fake-setup-updated'))
    expect(screen.queryByText('Unmanaged Delegate')).not.toBeInTheDocument()
  })

  it('still classifies genuinely external delegates as Unmanaged', async () => {
    // No onSetupUpdated fires — this is a delegate someone set up outside
    // Haven, not a freshly-approved one. The yellow card SHOULD render.
    vi.doMock('../ConnectAgent2Modal', () => ({ default: () => null }))
    const { default: AgentPanelFresh } = await import('../AgentPanel')
    render(<AgentPanelFresh />)
    expect(screen.getByText('Unmanaged Delegate')).toBeInTheDocument()
  })
})
