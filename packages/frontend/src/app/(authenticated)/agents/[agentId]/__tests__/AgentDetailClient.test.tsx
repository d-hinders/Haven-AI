import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseAuth,
  mockUseAgents,
  mockUseAgentActivity,
  mockUseOnChainAllowances,
  mockUsePublicClient,
  mockUseSafeDetails,
  mockUseSafeOperationGate,
  mockUseActiveSigner,
  mockUseDelegateBalance,
  mockUseAgentPassport,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseAgentActivity: vi.fn(),
  mockUseOnChainAllowances: vi.fn(),
  mockUsePublicClient: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseSafeOperationGate: vi.fn(),
  mockUseActiveSigner: vi.fn(),
  mockUseDelegateBalance: vi.fn(),
  mockUseAgentPassport: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: (...args: unknown[]) => mockUsePublicClient(...args),
}))

// #1402: the component navigates to /agents after a completed remove.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useAgentActivity', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAgentActivity')>('@/hooks/useAgentActivity')
  return {
    ...actual,
    useAgentActivity: () => mockUseAgentActivity(),
  }
})

vi.mock('@/hooks/useOnChainAllowances', () => ({
  useOnChainAllowances: (...args: unknown[]) => mockUseOnChainAllowances(...args),
}))

vi.mock('@/hooks/useDelegateBalance', () => ({
  useDelegateBalance: (...args: unknown[]) => mockUseDelegateBalance(...args),
}))

vi.mock('@/hooks/useAgentPassport', () => ({
  useAgentPassport: (...args: unknown[]) => mockUseAgentPassport(...args),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (...args: unknown[]) => mockUseSafeDetails(...args),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: (...args: unknown[]) => mockUseSafeOperationGate(...args),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (...args: unknown[]) => mockUseActiveSigner(...args),
  // Real predicate shape (#1079): narrows away the delegator_passkey variant.
  isSafeCapableSigner: (s: { type?: string } | null) => s !== null && s.type !== 'delegator_passkey',
}))

vi.mock('@/components/OnchainActionGate', () => ({
  default: ({ children }: { children: ReactNode | (() => ReactNode) }) => (
    <>{typeof children === 'function' ? children() : children}</>
  ),
  OnchainActionNotice: () => null,
  isOnchainActionBlocked: () => false,
}))

vi.mock('@/components/PasskeyOtherDeviceNotice', () => ({
  default: () => null,
}))

vi.mock('@/components/EditAgentModal', () => ({
  // Renders a marker when open so routing tests can assert the modal did /
  // did not open (#1079).
  default: ({ open, mode }: { open: boolean; mode?: string }) =>
    open ? <div data-testid="edit-agent-modal">{mode}</div> : null,
}))

vi.mock('@/components/DelegationBudgetCard', () => ({
  default: () => <div>DelegationBudgetCard</div>,
  DELEGATION_BUDGET_CARD_ID: 'delegation-budget-card',
}))

vi.mock('@/components/PaymentCredentialsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ConfirmDialog', () => ({
  default: () => null,
}))

vi.mock('@/components/transactions/TransactionsTable', () => ({
  default: ({
    transactions = [],
  }: {
    transactions?: Array<{
      hash: string
      safeName?: string
      movementOverride?: ReactNode
    }>
  }) => (
    <div>
      <div>Transactions table</div>
      {transactions.map((tx) => (
        <div key={tx.hash}>
          <span>{tx.safeName}</span>
          {tx.movementOverride}
        </div>
      ))}
    </div>
  ),
}))

import AgentDetailClient from '../AgentDetailClient'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
}

describe('AgentDetailClient last-activity metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    mockUseAuth.mockReturnValue({
      user: {
        safes: [SAFE],
      },
    })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          safe_id: 'safe-1',
          safe_address: SAFE.safe_address,
          safe_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: '2026-06-01T10:00:00Z',
          allowances: [],
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseAgentActivity.mockReturnValue({
      activity: [],
      stats: null,
      loading: false,
    })
    mockUseOnChainAllowances.mockReturnValue({
      data: new Map(),
      refetch: vi.fn(),
    })
    mockUsePublicClient.mockReturnValue({})
    mockUseSafeDetails.mockReturnValue({
      details: {
        address: SAFE.safe_address,
        owners: ['0x5555555555555555555555555555555555555555'],
        threshold: 1,
        nonce: 1,
      },
    })
    mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
    mockUseActiveSigner.mockReturnValue(null)
    // Default: delegate wallet is empty, so recovery UI stays hidden.
    mockUseDelegateBalance.mockReturnValue({
      balance: null,
      hasStranded: false,
      hasRecoverableUsdc: false,
      loading: false,
      refetch: vi.fn(),
    })
    mockUseAgentPassport.mockReturnValue({
      passport: null,
      standing: null,
      loading: false,
      issuing: false,
      issueError: null,
      issuePassport: vi.fn(),
      refetch: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the compact last-activity field without a default connected badge', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByRole('heading', { level: 1, name: 'Research agent' })).toBeInTheDocument()
    expect(screen.getByText('Last activity')).toBeInTheDocument()
    expect(screen.getByText('2h ago')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  it('hides the recover-funds prompt when the delegate wallet is empty', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    expect(
      screen.queryByRole('link', { name: 'Recover funds to your Haven wallet' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Recoverable funds in agent wallet')).not.toBeInTheDocument()
  })

  it('shows the recover-funds prompt with the amount when the delegate holds USDC', () => {
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        safe_address: SAFE.safe_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc: '0.04',
        usdc_atomic: '40000',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
      hasStranded: true,
      hasRecoverableUsdc: true,
      loading: false,
      refetch: vi.fn(),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText('Recoverable funds in agent wallet')).toBeInTheDocument()
    expect(screen.getByText(/Recover 0\.04 USDC to your Haven wallet\./)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Recover funds to your Haven wallet' }),
    ).toHaveAttribute('href', '/agents/agent-1/sweep')
  })

  it('hides the recover-funds prompt for an ETH-only delegate (gasless path is USDC-only)', () => {
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        safe_address: SAFE.safe_address,
        chain_id: 8453,
        eth: '0.01',
        eth_atomic: '10000000000000000',
        usdc: '0',
        usdc_atomic: '0',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
      hasStranded: true,
      hasRecoverableUsdc: false,
      loading: false,
      refetch: vi.fn(),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByText('Recoverable funds in agent wallet')).not.toBeInTheDocument()
  })

  it('uses the activity row wallet name for historical payment movement', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [
        {
          type: 'payment',
          id: 'payment-1',
          agent_id: 'agent-1',
          token: 'USDC',
          token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount_raw: '10000',
          amount: '0.01',
          to: '0x2222222222222222222222222222222222222222',
          status: 'confirmed',
          tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
          source: 'x402',
          x402_resource_url: 'https://api.example.com/data',
          x402_merchant_address: '0x2222222222222222222222222222222222222222',
          chain_id: 8453,
          safe_id: 'safe-old',
          safe_address: '0x4444444444444444444444444444444444444444',
          safe_name: 'Previous wallet',
          explorer_url: null,
          confirmed_at: '2026-05-08T11:49:59Z',
          created_at: '2026-05-08T11:49:00Z',
        },
      ],
      stats: null,
      loading: false,
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getAllByText('Previous wallet').length).toBeGreaterThan(0)
    expect(screen.getByText('api.example.com')).toBeInTheDocument()
  })

  it('does not fall back to the current wallet name when historical activity has only an address', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [
        {
          type: 'payment',
          id: 'payment-1',
          agent_id: 'agent-1',
          token: 'USDC',
          token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount_raw: '10000',
          amount: '0.01',
          to: '0x2222222222222222222222222222222222222222',
          status: 'confirmed',
          tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
          source: 'x402',
          x402_resource_url: 'https://api.example.com/data',
          x402_merchant_address: '0x2222222222222222222222222222222222222222',
          chain_id: 8453,
          safe_id: null,
          safe_address: '0x4444444444444444444444444444444444444444',
          safe_name: null,
          explorer_url: null,
          confirmed_at: '2026-05-08T11:49:59Z',
          created_at: '2026-05-08T11:49:00Z',
        },
      ],
      stats: null,
      loading: false,
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getAllByText('Haven wallet 0x4444…4444').length).toBeGreaterThan(0)
  })

  it('uses stored agent wallet chain when the wallet is missing from auth state', () => {
    const baseSafeAddress = '0x3333333333333333333333333333333333333333'
    const delegateAddress = '0x4444444444444444444444444444444444444444'
    mockUseAuth.mockReturnValue({
      user: {
        safes: [],
      },
    })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Base agent',
          description: null,
          delegate_address: delegateAddress,
          safe_id: 'safe-base',
          safe_address: baseSafeAddress,
          safe_name: 'Base account',
          safe_chain_id: 8453,
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [{
            id: 'allowance-base-usdc',
            agent_id: 'agent-1',
            token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            token_symbol: 'USDC',
            allowance_amount: '1000000',
            reset_period_min: 1440,
          }],
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(mockUseSafeDetails).toHaveBeenCalledWith(baseSafeAddress, { chainId: 8453 })
    expect(mockUseOnChainAllowances).toHaveBeenCalledWith(baseSafeAddress, [delegateAddress], 8453)
    expect(mockUsePublicClient).toHaveBeenCalledWith({ chainId: 8453 })
    expect(mockUseActiveSigner).toHaveBeenCalledWith({
      safeAddress: baseSafeAddress,
      chainId: 8453,
    })
    expect(mockUseSafeOperationGate).toHaveBeenCalledWith({
      safeAddress: baseSafeAddress,
      chainId: 8453,
    })
    expect(screen.getByText('Base')).toBeInTheDocument()
    expect(screen.getByText('1.00 USDC per day')).toBeInTheDocument()
  })

  // ── Budget-affordance routing (#1079) ──────────────────────────────────

  function mockDelegationAgent() {
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Delegation agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          safe_id: 'safe-1',
          safe_address: SAFE.safe_address,
          safe_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
          account_type: 'delegator_hybrid',
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
  }

  it('routes Update budget to the budget card — NOT EditAgentModal — on a delegation agent', () => {
    mockDelegationAgent()
    const scrollIntoView = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView

    render(<AgentDetailClient agentId="agent-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Update budget' }))

    expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalled()

    // The empty-state "Add budget" affordance takes the same route.
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument()
  })

  // ── Backup & recovery pointer, not a second copy (#1089) ────────────────

  it('points a delegation agent at the account page instead of rendering signer controls', () => {
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)

    const link = screen.getByRole('link', { name: /Backup & recovery/ })
    expect(link).toHaveAttribute('href', '/accounts/safe-1')
    // No enrollment controls on the agent page — those live only on the account page now.
    expect(screen.queryByRole('button', { name: /Add a backup/ })).not.toBeInTheDocument()
  })

  it('hides the backup & recovery pointer on a legacy agent', () => {
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('link', { name: /Backup & recovery/ })).not.toBeInTheDocument()
  })

  it('still opens EditAgentModal in budget mode on a legacy agent', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Update budget' }))

    expect(screen.getByTestId('edit-agent-modal')).toHaveTextContent('budget')
  })

  it('reads the delegate balance for REVOKED agents too — the recovery banner must reach them (#1403)', () => {
    // The old gate skipped the read for revoked agents ("the endpoint 404s
    // anyway") — false since #1403, and exactly backwards: the sequence that
    // strands delegate funds is revoke-mid-x402. The hook must be called with
    // the agentId regardless of status.
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((a: { id: string }) =>
        a.id === 'agent-1' ? { ...a, status: 'revoked' } : a,
      ),
    })
    render(<AgentDetailClient agentId="agent-1" />)
    const calls = mockUseDelegateBalance.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][0]).toBe('agent-1')
  })

  it('hides the Safe revoke control on a delegation agent, keeps it on a legacy agent', () => {
    mockDelegationAgent()
    const { unmount } = render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('button', { name: 'Revoke agent budget' })).not.toBeInTheDocument()
    unmount()

    // Legacy fixture from beforeEach.
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          safe_id: 'safe-1',
          safe_address: SAFE.safe_address,
          safe_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('button', { name: 'Revoke agent budget' })).toBeInTheDocument()
  })
})
