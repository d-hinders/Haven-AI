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
})
