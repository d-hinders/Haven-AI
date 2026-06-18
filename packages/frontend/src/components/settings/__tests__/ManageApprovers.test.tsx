import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUseSafeApprovers = vi.fn()
const mockUseKnownApprovers = vi.fn()
const mockUseSafeOperationGate = vi.fn()
const mockUseActiveSigner = vi.fn()
const mockUsePublicClient = vi.fn()
const mockApplyApproverChange = vi.fn()

vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockUseAuth() }))
vi.mock('@/hooks/useSafeApprovers', () => ({
  useSafeApprovers: (...args: unknown[]) => mockUseSafeApprovers(...args),
  useKnownApprovers: (...args: unknown[]) => mockUseKnownApprovers(...args),
}))
vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: (...args: unknown[]) => mockUseSafeOperationGate(...args),
}))
vi.mock('@/lib/signer', () => ({ useActiveSigner: (...a: unknown[]) => mockUseActiveSigner(...a) }))
vi.mock('wagmi', () => ({ usePublicClient: (...a: unknown[]) => mockUsePublicClient(...a) }))
vi.mock('@/lib/approver-tx', () => ({
  applyApproverChange: (...a: unknown[]) => mockApplyApproverChange(...a),
}))

import ManageApprovers from '@/components/settings/ManageApprovers'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
}
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function setApprovers(approvers: unknown[], over: Record<string, unknown> = {}) {
  mockUseSafeApprovers.mockReturnValue({
    approvers,
    threshold: 1,
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    ...over,
  })
}

describe('ManageApprovers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAuth.mockReturnValue({ user: { safes: [SAFE] } })
    mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
    mockUseActiveSigner.mockReturnValue({ type: 'eoa', address: A })
    mockUsePublicClient.mockReturnValue({})
    mockApplyApproverChange.mockResolvedValue({ txHash: '0xtx' })
    mockUseKnownApprovers.mockReturnValue({ known: [], loading: false, refetch: vi.fn() })
  })

  it('prompts to link an account when there are no safes', () => {
    mockUseAuth.mockReturnValue({ user: { safes: [] } })
    setApprovers([])
    render(<ManageApprovers />)
    expect(screen.getByText(/Link a Haven account/i)).toBeInTheDocument()
  })

  it('disables removing the only approver and explains why', () => {
    setApprovers([{ address: A, type: 'eoa', label: 'My wallet' }])
    render(<ManageApprovers />)

    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
    expect(screen.getByText(/only approver/i)).toBeInTheDocument()
  })

  it('allows removing one of several approvers and applies the change', async () => {
    const user = userEvent.setup()
    setApprovers([
      { address: A, type: 'eoa', label: 'Wallet A' },
      { address: B, type: 'passkey', label: 'Passkey B' },
    ])
    render(<ManageApprovers />)

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons).toHaveLength(2)
    await user.click(removeButtons[1])

    // Confirm dialog
    await user.click(screen.getByRole('button', { name: 'Remove approver' }))

    await waitFor(() =>
      expect(mockApplyApproverChange).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'remove', address: B, safeId: 'safe-1' }),
      ),
    )
  })

  it('validates the address before adding', async () => {
    const user = userEvent.setup()
    setApprovers([{ address: A, type: 'eoa', label: 'Wallet A' }, { address: B, type: 'eoa', label: null }])
    render(<ManageApprovers />)

    await user.click(screen.getByRole('button', { name: 'Add approver' }))
    await user.type(screen.getByLabelText('Approver address'), 'not-an-address')
    await user.click(screen.getByRole('button', { name: 'Add approver' }))

    expect(await screen.findByText(/valid wallet address/i)).toBeInTheDocument()
    expect(mockApplyApproverChange).not.toHaveBeenCalled()
  })

  it('adds a valid new approver with its label and type', async () => {
    const user = userEvent.setup()
    setApprovers([{ address: A, type: 'eoa', label: 'Wallet A' }])
    render(<ManageApprovers />)

    await user.click(screen.getByRole('button', { name: 'Add approver' }))
    await user.type(screen.getByLabelText('Approver address'), B)
    await user.type(screen.getByLabelText('Approver label'), 'Co-founder')
    // The form's own submit button (second "Add approver")
    const submits = screen.getAllByRole('button', { name: 'Add approver' })
    await user.click(submits[submits.length - 1])

    await waitFor(() =>
      expect(mockApplyApproverChange).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'add', address: B, label: 'Co-founder', type: 'eoa' }),
      ),
    )
  })

  it('offers known approvers from other Safes for reuse, excluding current owners', async () => {
    const user = userEvent.setup()
    setApprovers([{ address: A, type: 'eoa', label: 'Wallet A' }, { address: B, type: 'eoa', label: null }])
    // C is known from another Safe; A is already an owner here and must be excluded.
    const C = '0xcccccccccccccccccccccccccccccccccccccccc'
    mockUseKnownApprovers.mockReturnValue({
      known: [
        { address: A, type: 'eoa', label: 'Wallet A', safe_ids: ['safe-1'] },
        { address: C, type: 'passkey', label: 'Shared passkey', safe_ids: ['safe-2'] },
      ],
      loading: false,
      refetch: vi.fn(),
    })
    render(<ManageApprovers />)

    await user.click(screen.getByRole('button', { name: 'Add approver' }))

    expect(screen.getByText('Shared passkey')).toBeInTheDocument()
    expect(screen.queryByText('Wallet A')).toBeInTheDocument() // present in the owner list…
    // …but A is not offered for reuse (no second "Add to" button for it)
    const reuseButtons = screen.getAllByRole('button', { name: /Add to/i })
    expect(reuseButtons).toHaveLength(1)

    await user.click(reuseButtons[0])

    await waitFor(() =>
      expect(mockApplyApproverChange).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'add', address: C, type: 'passkey', label: 'Shared passkey' }),
      ),
    )
  })

  it('blocks management and explains when no signer is available', () => {
    mockUseSafeOperationGate.mockReturnValue({ kind: 'no_signer' })
    mockUseActiveSigner.mockReturnValue(null)
    setApprovers([{ address: A, type: 'eoa', label: 'Wallet A' }, { address: B, type: 'eoa', label: null }])
    render(<ManageApprovers />)

    expect(screen.getByText(/Connect the wallet that owns this account/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add approver' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('shows the per-account scope (name + chain) for clarity', () => {
    setApprovers([{ address: A, type: 'eoa', label: 'Wallet A' }, { address: B, type: 'eoa', label: null }])
    mockUseAuth.mockReturnValue({ user: { safes: [SAFE, { ...SAFE, id: 'safe-2', name: 'Trading' }] } })
    render(<ManageApprovers />)

    expect(screen.getByText('Main account')).toBeInTheDocument()
    expect(screen.getByText('Trading')).toBeInTheDocument()
  })
})
