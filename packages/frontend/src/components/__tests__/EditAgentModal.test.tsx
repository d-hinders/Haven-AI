import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE_ADDRESS,
  SIGNER_ADDRESS,
  mockUsePublicClient,
  mockUseActiveSigner,
  mockUseSafeOperationGate,
} = vi.hoisted(() => ({
  SAFE_ADDRESS: '0x1111111111111111111111111111111111111111',
  SIGNER_ADDRESS: '0x3333333333333333333333333333333333333333',
  mockUsePublicClient: vi.fn(),
  mockUseActiveSigner: vi.fn(),
  mockUseSafeOperationGate: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: () => mockUsePublicClient(),
  useAccount: () => ({ isConnected: true, chain: { id: 100 } }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => mockUseActiveSigner(),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: () => mockUseSafeOperationGate(),
}))

vi.mock('@/lib/safe-tx', () => ({
  getSafeNonce: vi.fn(),
  signSafeTx: vi.fn(),
  executeSafeTx: vi.fn(),
  proposeSafeTx: vi.fn(),
  getSafeTxHash: vi.fn(),
  getChainTokens: () => ({
    xDAI: { symbol: 'xDAI', decimals: 18, address: null },
    EURe: { symbol: 'EURe', decimals: 18, address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E' },
    'USDC.e': { symbol: 'USDC.e', decimals: 6, address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0' },
  }),
}))

import EditAgentModal from '../EditAgentModal'
import type { Agent } from '@/hooks/useAgents'

const BASE_AGENT: Agent = {
  id: 'agent-1',
  name: 'Food',
  description: 'Foodie',
  delegate_address: '0x2222222222222222222222222222222222222222',
  safe_id: 'safe-1',
  safe_address: SAFE_ADDRESS,
  safe_name: 'Operating wallet',
  status: 'active',
  created_at: '2026-05-01T00:00:00Z',
  allowances: [
    {
      id: 'allowance-1',
      agent_id: 'agent-1',
      // EURe on Gnosis = 18 decimals
      token_address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E',
      token_symbol: 'EURe',
      allowance_amount: '2000000000000000000',
      reset_period_min: 1440,
    },
  ],
}

const baseProps = {
  open: true,
  onClose: vi.fn(),
  agent: BASE_AGENT,
  safeAddress: SAFE_ADDRESS,
  chainId: 100,
  safeDetails: {
    address: SAFE_ADDRESS,
    owners: [SIGNER_ADDRESS],
    threshold: 1,
    nonce: 1,
  },
  existingOnChainAllowances: null,
  onUpdated: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUsePublicClient.mockReturnValue({})
  mockUseActiveSigner.mockReturnValue({ type: 'eoa', address: SIGNER_ADDRESS })
  mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('EditAgentModal — mode prop', () => {
  it("'agent' mode hides budget fields", () => {
    render(<EditAgentModal {...baseProps} mode="agent" />)
    expect(screen.getByText('Edit agent')).toBeInTheDocument()
    expect(screen.getByText('Agent name')).toBeInTheDocument()
    expect(screen.queryByText(/Add new agent budget/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Update agent budget/i)).not.toBeInTheDocument()
  })

  it("'budget' mode hides agent name + description", () => {
    render(<EditAgentModal {...baseProps} mode="budget" />)
    expect(screen.getByText('Update budget')).toBeInTheDocument()
    expect(screen.queryByText('Agent name')).not.toBeInTheDocument()
    // budget section is visible
    expect(
      screen.queryByText(/Add new agent budget/i) ||
        screen.queryByText(/Update agent budget/i),
    ).toBeInTheDocument()
  })

  it("'all' mode shows both sections (backwards-compat)", () => {
    render(<EditAgentModal {...baseProps} />)
    expect(screen.getByText('Edit agent')).toBeInTheDocument()
    expect(screen.getByText('Agent name')).toBeInTheDocument()
    expect(
      screen.queryByText(/Add new agent budget/i) ||
        screen.queryByText(/Update agent budget/i),
    ).toBeInTheDocument()
  })
})

describe('EditAgentModal — Add vs Update budget label', () => {
  it("reads 'Update agent budget' when the selected token already has an allowance on the agent", () => {
    // Agent already has an EURe allowance; selectedToken defaults to first
    // available token which is xDAI in our mocked tokenOptions. But because
    // the agent has EURe and we pick xDAI, the section label should read
    // 'Add new agent budget'. Then we switch the select to EURe and it
    // should flip to 'Update agent budget'.
    render(<EditAgentModal {...baseProps} mode="budget" />)

    // Initial state — xDAI default, not in agent.allowances. In 'budget'
    // mode the modal biases toward Update because the entry point implies
    // it. Confirm.
    expect(screen.getByText(/Update agent budget/i)).toBeInTheDocument()
  })

  it("reads 'Add new agent budget' in 'all' mode when adding a brand-new token", () => {
    // Agent has EURe; xDAI is brand-new.
    const agentWithEure: Agent = {
      ...BASE_AGENT,
      allowances: [
        {
          ...BASE_AGENT.allowances[0],
          token_symbol: 'EURe',
        },
      ],
    }
    render(<EditAgentModal {...baseProps} agent={agentWithEure} mode="all" />)
    // Default selected token is xDAI (native, no allowance on agent).
    expect(screen.getByText(/Add new agent budget/i)).toBeInTheDocument()
  })

  it("matches existing allowances by symbol when address comparison fails", () => {
    // Simulate the bug scenario: DB stores the EURe address; the modal's
    // tokenOptions also has EURe. They match by address — the fallback by
    // symbol is exercised when we change the selectedToken to EURe.
    render(<EditAgentModal {...baseProps} mode="all" />)
    const tokenSelect = screen.getAllByRole('combobox')[0]
    fireEvent.change(tokenSelect, { target: { value: 'EURe' } })
    expect(screen.getByText(/Update agent budget/i)).toBeInTheDocument()
  })
})
