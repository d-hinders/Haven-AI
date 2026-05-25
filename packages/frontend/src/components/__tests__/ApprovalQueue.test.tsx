import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUseApprovals = vi.fn()
const mockUseSafeOperationGate = vi.fn()
const mockUseSafeDetails = vi.fn()
const mockUseActiveSigner = vi.fn()
const mockUsePublicClient = vi.fn()

const mockGetSafeNonce = vi.fn()
const mockBuildSafeTx = vi.fn()
const mockSignSafeTx = vi.fn()
const mockExecuteSafeTx = vi.fn()
const mockProposeSafeTx = vi.fn()
const mockGetSafeTxHash = vi.fn()
const mockGetChainTokens = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: () => mockUseApprovals(),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: (args: unknown) => mockUseSafeOperationGate(args),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (safeAddress: string | null) => mockUseSafeDetails(safeAddress),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
}))

vi.mock('wagmi', () => ({
  usePublicClient: (args: unknown) => mockUsePublicClient(args),
}))

vi.mock('@/lib/safe-tx', () => ({
  getSafeNonce: (...args: unknown[]) => mockGetSafeNonce(...args),
  buildSafeTx: (...args: unknown[]) => mockBuildSafeTx(...args),
  signSafeTx: (...args: unknown[]) => mockSignSafeTx(...args),
  executeSafeTx: (...args: unknown[]) => mockExecuteSafeTx(...args),
  proposeSafeTx: (...args: unknown[]) => mockProposeSafeTx(...args),
  getSafeTxHash: (...args: unknown[]) => mockGetSafeTxHash(...args),
  getChainTokens: (...args: unknown[]) => mockGetChainTokens(...args),
}))

vi.mock('@/lib/chains', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains')>('@/lib/chains')
  return {
    ...actual,
    getExplorerUrl: vi.fn().mockReturnValue('https://example.com/tx'),
  }
})

vi.mock('@/lib/format', async () => {
  const actual = await vi.importActual<typeof import('@/lib/format')>('@/lib/format')
  return {
    ...actual,
    timeAgo: vi.fn().mockReturnValue('just now'),
    timeUntil: vi.fn().mockReturnValue('in 1 hour'),
  }
})

vi.mock('@/components/NetworkGate', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import ApprovalQueue from '@/components/ApprovalQueue'

describe('ApprovalQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockUseAuth.mockReturnValue({
      user: {
        safes: [
          {
            id: 'safe-1',
            safe_address: '0x1111111111111111111111111111111111111111',
            chain_id: 100,
            name: 'Blocked Safe',
            is_default: true,
          },
          {
            id: 'safe-2',
            safe_address: '0x2222222222222222222222222222222222222222',
            chain_id: 8453,
            name: 'Accessible Safe',
            is_default: false,
          },
        ],
      },
    })

    mockUseApprovals.mockReturnValue({
      approvals: [
        {
          id: 'approval-1',
          agent_id: 'agent-1',
          agent_name: 'Blocked agent',
          safe_address: '0x1111111111111111111111111111111111111111',
          chain_id: 100,
          token_symbol: 'xDAI',
          token_address: '0x0000000000000000000000000000000000000000',
          to_address: '0x3333333333333333333333333333333333333333',
          amount_raw: '1000000000000000000',
          amount_human: '1',
          reason: null,
          source: 'direct',
          x402_resource_url: null,
          merchant_address: null,
          payment_rail: null,
          payment_resource_url: null,
          status: 'pending',
          tx_hash: null,
          reviewed_at: null,
          created_at: '2026-05-05T10:00:00.000Z',
          expires_at: '2026-05-05T11:00:00.000Z',
        },
        {
          id: 'approval-2',
          agent_id: 'agent-2',
          agent_name: 'Accessible agent',
          safe_address: '0x2222222222222222222222222222222222222222',
          chain_id: 8453,
          token_symbol: 'ETH',
          token_address: '0x0000000000000000000000000000000000000000',
          to_address: '0x4444444444444444444444444444444444444444',
          amount_raw: '2000000000000000000',
          amount_human: '2',
          reason: 'Payment',
          source: 'direct',
          x402_resource_url: null,
          merchant_address: null,
          payment_rail: null,
          payment_resource_url: null,
          status: 'pending',
          tx_hash: null,
          reviewed_at: null,
          created_at: '2026-05-05T10:05:00.000Z',
          expires_at: '2026-05-05T11:05:00.000Z',
        },
      ],
      actionableCount: 2,
      loading: false,
      error: null,
      approve: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue(undefined),
      markProposed: vi.fn().mockResolvedValue(undefined),
      markExecuted: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    })

    mockUseSafeOperationGate.mockImplementation(({ safeAddress }: { safeAddress?: string }) =>
      safeAddress?.toLowerCase() === '0x1111111111111111111111111111111111111111'
        ? { kind: 'passkey_on_other_device' }
        : { kind: 'ready' },
    )

    mockUseSafeDetails.mockReturnValue({
      details: {
        address: '0x2222222222222222222222222222222222222222',
        threshold: 1,
        owners: ['0xowner'],
        nonce: 1,
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    mockUseActiveSigner.mockImplementation(({ safeAddress }: { safeAddress?: string }) =>
      safeAddress?.toLowerCase() === '0x2222222222222222222222222222222222222222'
        ? { type: 'eoa', address: '0x5555555555555555555555555555555555555555', walletClient: {} }
        : null,
    )

    mockUsePublicClient.mockReturnValue({ transport: {} })
    mockGetChainTokens.mockImplementation((chainId: number) =>
      chainId === 8453
        ? { ETH: { address: null, decimals: 18 } }
        : { xDAI: { address: null, decimals: 18 } },
    )
    mockGetSafeNonce.mockResolvedValue(7n)
    mockBuildSafeTx.mockReturnValue({
      to: '0x4444444444444444444444444444444444444444',
      value: 2n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 7n,
    })
    mockSignSafeTx.mockResolvedValue('0xsig')
    mockExecuteSafeTx.mockResolvedValue({ txHash: '0xtx' })
    mockProposeSafeTx.mockResolvedValue(undefined)
    mockGetSafeTxHash.mockReturnValue('0xhash')
  })

  it('gates and executes approvals per approval safe instead of the active safe', async () => {
    render(<ApprovalQueue />)

    const approveButtons = screen.getAllByRole('button', { name: 'Approve payment' })
    expect(approveButtons).toHaveLength(2)
    expect(approveButtons[0]).toBeDisabled()
    expect(approveButtons[1]).not.toBeDisabled()

    expect(screen.getByText('This account uses a passkey on another device.')).toBeInTheDocument()

    fireEvent.click(approveButtons[1])

    await waitFor(() => {
      const { approve } = mockUseApprovals.mock.results[0].value
      expect(approve).toHaveBeenCalledWith('approval-2')
    })

    expect(mockGetSafeNonce).toHaveBeenCalledWith(
      expect.anything(),
      '0x2222222222222222222222222222222222222222',
    )
    expect(mockSignSafeTx).toHaveBeenCalledWith(
      expect.objectContaining({ address: '0x5555555555555555555555555555555555555555' }),
      '0x2222222222222222222222222222222222222222',
      expect.anything(),
      8453,
    )
  })

  it('submits multi-approval requests instead of marking them sent', async () => {
    mockUseSafeDetails.mockReturnValue({
      details: {
        address: '0x2222222222222222222222222222222222222222',
        threshold: 2,
        owners: ['0xowner', '0xother'],
        nonce: 1,
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<ApprovalQueue />)

    const submitButtons = screen.getAllByRole('button', { name: 'Approve and submit' })
    expect(submitButtons[0]).toBeDisabled()
    expect(submitButtons[1]).not.toBeDisabled()

    fireEvent.click(submitButtons[1])

    await waitFor(() => {
      const { approve, markProposed } = mockUseApprovals.mock.results[0].value
      expect(approve).toHaveBeenCalledWith('approval-2')
      expect(markProposed).toHaveBeenCalledWith('approval-2')
    })

    expect(mockProposeSafeTx).toHaveBeenCalledWith(
      '0x2222222222222222222222222222222222222222',
      expect.anything(),
      '0xhash',
      '0xsig',
      '0x5555555555555555555555555555555555555555',
      8453,
    )
    expect(mockExecuteSafeTx).not.toHaveBeenCalled()
  })

  it('completes an already-approved request without approving it again', async () => {
    const baseHookValue = mockUseApprovals()
    const approve = vi.fn().mockResolvedValue({})
    const markExecuted = vi.fn().mockResolvedValue(undefined)
    mockUseApprovals.mockReturnValue({
      ...baseHookValue,
      approvals: [
        {
          ...baseHookValue.approvals[1],
          status: 'approved',
        },
      ],
      actionableCount: 1,
      approve,
      markExecuted,
    })

    render(<ApprovalQueue />)

    fireEvent.click(screen.getByRole('button', { name: 'Complete payment' }))

    await waitFor(() => {
      expect(approve).not.toHaveBeenCalled()
      expect(markExecuted).toHaveBeenCalledWith('approval-2', '0xtx')
    })
    expect(mockExecuteSafeTx).toHaveBeenCalled()
  })

  it('uses x402 merchant labels without duplicating approval copy', () => {
    const baseHookValue = mockUseApprovals()
    mockUseApprovals.mockReturnValue({
      ...baseHookValue,
      approvals: [
        {
          ...baseHookValue.approvals[1],
          id: 'approval-x402-pending',
          agent_name: 'Soundside agent',
          source: 'x402',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          reason: 'x402 payment for https://mcp.soundside.ai/mcp',
          status: 'pending',
        },
        {
          ...baseHookValue.approvals[1],
          id: 'approval-x402-approved',
          agent_name: 'Soundside agent',
          source: 'x402',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          reason: 'x402 payment for https://mcp.soundside.ai/mcp',
          status: 'approved',
        },
      ],
      actionableCount: 2,
    })

    render(<ApprovalQueue />)

    expect(screen.queryByText('This payment is above the remaining agent budget. Nothing moves until you approve it.')).not.toBeInTheDocument()
    // New copy names the merchant (resolved from x402_resource_url hostname) in the pending state
    expect(screen.getByText('Soundside agent wants to pay mcp.soundside.ai 2 ETH. Nothing moves until you approve it.')).toBeInTheDocument()
    // Approved state names merchant and agent
    expect(screen.getByText('Approval saved. Complete the payment so Soundside agent can pay mcp.soundside.ai.')).toBeInTheDocument()
    expect(screen.getAllByText('mcp.soundside.ai').length).toBeGreaterThan(0)
    // Disclosure toggle MUST NOT render for x402 rows that lack a merchant_address —
    // the two-legs panel is only meaningful when we know the merchant's settlement
    // address. Regression guard against someone dropping the `merchant_address` gate
    // on `showDisclosure`.
    expect(
      screen.queryByRole('button', { name: /where does the money go/i }),
    ).not.toBeInTheDocument()
  })

  it('keeps executed x402 approvals user-facing as sent with retry guidance', () => {
    const baseHookValue = mockUseApprovals()
    mockUseApprovals.mockReturnValue({
      ...baseHookValue,
      approvals: [
        {
          ...baseHookValue.approvals[1],
          id: 'approval-x402-executed',
          agent_name: 'Soundside agent',
          source: 'x402',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          reason: 'x402 payment for https://mcp.soundside.ai/mcp',
          merchant_address: null,
          payment_rail: null,
          payment_resource_url: null,
          status: 'executed',
          tx_hash: `0x${'ab'.repeat(32)}`,
        },
      ],
      actionableCount: 0,
    })

    render(<ApprovalQueue />)

    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(screen.getByText('Return to your agent and ask it to retry the original x402 request.')).toBeInTheDocument()
  })

  it('x402 two-legs: shows merchant hostname as recipient, hides delegate address by default', () => {
    const baseHookValue = mockUseApprovals()
    mockUseApprovals.mockReturnValue({
      ...baseHookValue,
      approvals: [
        {
          ...baseHookValue.approvals[1],
          id: 'approval-x402-twoleg',
          agent_name: 'Payments agent',
          source: 'x402',
          // to_address is the delegate (agent spending wallet) — must NOT appear in default card view
          to_address: '0x1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa',
          // merchant_address is the actual destination — MUST appear in card
          merchant_address: '0x2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb',
          payment_rail: 'x402',
          payment_resource_url: 'https://api.example.com/resource',
          x402_resource_url: null,
          reason: null,
          status: 'pending',
        },
      ],
      actionableCount: 1,
    })

    render(<ApprovalQueue />)

    // The Merchant detail should resolve to the hostname of payment_resource_url
    expect(screen.getAllByText('api.example.com').length).toBeGreaterThan(0)

    // Delegate address must NOT be visible in the default (collapsed) card
    // (address text is split across nodes so we check textContent directly)
    expect(document.body.textContent).not.toMatch(/0x1111aaaa/i)

    // Headline copy names the merchant
    expect(
      screen.getByText('Payments agent wants to pay api.example.com 2 ETH. Nothing moves until you approve it.'),
    ).toBeInTheDocument()

    // Forbidden technical jargon must not appear anywhere
    expect(document.body.textContent).not.toMatch(/Safe(?:\s|$)/i)
    expect(document.body.textContent).not.toMatch(/AllowanceModule/i)
    expect(document.body.textContent).not.toMatch(/\bdelegate\b/i)
    expect(document.body.textContent).not.toMatch(/EIP-3009/i)
    expect(screen.queryByText(/Haven (will )?pay/i)).toBeNull()
  })

  it('x402 two-legs: disclosure reveals both addresses with explorer links', async () => {
    const baseHookValue = mockUseApprovals()
    mockUseApprovals.mockReturnValue({
      ...baseHookValue,
      approvals: [
        {
          ...baseHookValue.approvals[1],
          id: 'approval-x402-twoleg-disc',
          agent_name: 'Payments agent',
          source: 'x402',
          to_address: '0x1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa',
          merchant_address: '0x2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb',
          payment_rail: 'x402',
          payment_resource_url: 'https://api.example.com/resource',
          x402_resource_url: null,
          reason: null,
          status: 'pending',
        },
      ],
      actionableCount: 1,
    })

    render(<ApprovalQueue />)

    // "Where does the money go?" toggle must be present for two-legs x402
    const toggle = screen.getByRole('button', { name: /where does the money go/i })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Delegate address absent before expansion
    expect(document.body.textContent).not.toMatch(/0x1111aaaa/i)

    // Click to expand
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
    })

    // Both addresses visible in disclosure — address renders as split text nodes inside <a>
    // so we search the full body textContent for the prefix + suffix patterns
    expect(document.body.textContent).toMatch(/0x1111.*aaaa/i)
    expect(document.body.textContent).toMatch(/0x2222.*bbbb/i)

    // Explorer links present for each address (getExplorerUrl mock returns 'https://example.com/tx')
    const links = screen.getAllByRole('link')
    const explorerLinks = links.filter((l) => l.getAttribute('href')?.includes('example.com/tx'))
    expect(explorerLinks.length).toBeGreaterThanOrEqual(2)
  })

  it('x402 two-legs: approved state copy names merchant correctly', () => {
    const baseHookValue = mockUseApprovals()
    mockUseApprovals.mockReturnValue({
      ...baseHookValue,
      approvals: [
        {
          ...baseHookValue.approvals[1],
          id: 'approval-x402-twoleg-approved',
          agent_name: 'Payments agent',
          source: 'x402',
          to_address: '0x1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa',
          merchant_address: '0x2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb',
          payment_rail: 'x402',
          payment_resource_url: 'https://api.example.com/resource',
          x402_resource_url: null,
          reason: null,
          status: 'approved',
        },
      ],
      actionableCount: 1,
    })

    render(<ApprovalQueue />)

    expect(
      screen.getByText('Approval saved. Complete the payment so Payments agent can pay api.example.com.'),
    ).toBeInTheDocument()
  })

  it('non-x402 approval renders without the disclosure toggle', () => {
    // The base fixtures are both `source: 'direct'` — no "Where does the money go?" toggle
    render(<ApprovalQueue />)
    expect(screen.queryByRole('button', { name: /where does the money go/i })).not.toBeInTheDocument()
  })
})
