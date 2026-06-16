import { render, screen } from '@testing-library/react'
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
}))

vi.mock('wagmi', () => ({
  usePublicClient: (...args: unknown[]) => mockUsePublicClient(...args),
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

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (...args: unknown[]) => mockUseSafeDetails(...args),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: (...args: unknown[]) => mockUseSafeOperationGate(...args),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (...args: unknown[]) => mockUseActiveSigner(...args),
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
  default: () => null,
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

    expect(screen.getAllByText('Haven wallet 0x4444...4444').length).toBeGreaterThan(0)
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
})
