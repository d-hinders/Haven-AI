import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const mockUseAuth = vi.fn()
const mockUseOwnerDirectory = vi.fn()
const mockUseUserSafes = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()
const mockUseSafeDetails = vi.fn()
const mockUseRetiredRailOwnerAccess = vi.fn()
const mockUsePortfolio = vi.fn()
const mockUseBalances = vi.fn()
const mockUseTransactionsFeed = vi.fn()

const mockRouterPush = vi.fn()

vi.mock('next/navigation', () => ({
  useParams: () => ({ safeId: 'safe-1' }),
  useRouter: () => ({ push: mockRouterPush }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/context/OwnerDirectoryContext', () => ({
  useOwnerDirectory: () => mockUseOwnerDirectory(),
}))

vi.mock('@/hooks/useUserSafes', () => ({
  useUserSafes: () => mockUseUserSafes(),
}))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => mockUseContacts(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: () => mockUseSafeDetails(),
}))

vi.mock('@/hooks/useRetiredRailOwnerAccess', () => ({
  useRetiredRailOwnerAccess: () => mockUseRetiredRailOwnerAccess(),
}))

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: () => mockUsePortfolio(),
}))

vi.mock('@/hooks/useBalances', () => ({
  useBalances: () => mockUseBalances(),
}))

vi.mock('@/hooks/useTransactionsFeed', () => ({
  useTransactionsFeed: () => mockUseTransactionsFeed(),
}))

vi.mock('@/components/transactions/TransactionsTable', () => ({
  default: () => <div>Transactions table</div>,
}))

vi.mock('@/components/ReceiveFundsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ConfirmDialog', () => ({
  // Renders only while open, so every case that never opens it sees exactly
  // what the previous `() => null` stub gave them.
  default: ({ open, title, body, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel }: {
    open: boolean
    title: string
    body: ReactNode
    confirmLabel: string
    cancelLabel?: string
    onConfirm: () => void | Promise<void>
    onCancel: () => void
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <h2>{title}</h2>
        {body}
        <button onClick={() => void onConfirm()}>{confirmLabel}</button>
        {/* The real ConfirmDialog routes backdrop-click and Escape through this
            same `onCancel`, so exercising it covers every close path. */}
        <button onClick={onCancel}>{cancelLabel}</button>
      </div>
    ) : null,
}))

vi.mock('@/components/AccountSignersCard', () => ({
  default: (props: { safeAddress?: string; agentId?: string }) => (
    <div data-testid="account-signers-card" data-safe-address={props.safeAddress} data-agent-id={props.agentId}>
      Backup &amp; recovery
    </div>
  ),
}))

import AccountDetailClient from '../AccountDetailClient'
import { ApiRequestError } from '@/lib/api'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
  account_type: 'delegator_hybrid' as const,
}

describe('AccountDetailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        wallet_address: '0x5555555555555555555555555555555555555555',
        safes: [SAFE],
      },
      activeSafe: SAFE,
      setActiveSafe: vi.fn(),
      loading: false,
      passkeys: [],
    })
    mockUseOwnerDirectory.mockReturnValue({
      getOwnerAlias: (address: string) =>
        address.toLowerCase() === '0x5555555555555555555555555555555555555555'
          ? 'Personal wallet'
          : null,
    })
    mockUseUserSafes.mockReturnValue({
      renameSafe: vi.fn(),
      removeSafe: vi.fn(),
      loading: false,
    })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseContacts.mockReturnValue({
      contacts: [],
      error: null,
      resolveAddress: vi.fn(),
    })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          safe_id: 'safe-1',
          status: 'active',
          account_type: 'delegator_hybrid',
          allowances: [
            {
              id: 'allowance-1',
              agent_id: 'agent-1',
              token_address: '0x0000000000000000000000000000000000000000',
              // USDC.e on Gnosis has 6 decimals — raw 100_000_000 = 100.
              // This exercises the decimals formatter we extracted into
              // lib/allowance-format.ts; the old code dumped the raw bigint
              // straight into the label, which is the bug the PR fixes.
              token_symbol: 'USDC.e',
              allowance_amount: '100000000',
              reset_period_min: 1440,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockUseSafeDetails.mockReturnValue({
      details: {
        address: SAFE.safe_address,
        owners: ['0x5555555555555555555555555555555555555555'],
        threshold: 1,
        nonce: 1,
      },
      loading: false,
      error: null,
    })
    mockUseRetiredRailOwnerAccess.mockReturnValue({
      ...mockUseSafeDetails(),
      ownerAccess: 'unknown',
    })
    mockUsePortfolio.mockReturnValue({
      totalUsd: 42,
      totalEur: 39,
      breakdown: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockUseBalances.mockReturnValue({
      balances: [],
      error: null,
      refetch: vi.fn(),
    })
    mockUseTransactionsFeed.mockReturnValue({
      transactions: [],
      loadingInitial: false,
      error: null,
      total: 0,
      hasMore: false,
      refresh: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leads with wallet control, agent access, and advanced account details', () => {
    render(<AccountDetailClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Main account' })).toBeInTheDocument()
    expect(screen.getByText('Control the funds, agent access, and recent activity for this Haven wallet.')).toBeInTheDocument()
    expect(screen.getByText('$42.00')).toBeInTheDocument()
    // #2413: the "Required approvals" line went with the Safe-details read
    // that fed it — and it was already inert here, because that read was gated
    // to the retired rail. Delegation signers are shown by AccountSignersCard.
    expect(screen.queryByText(/approver required/)).not.toBeInTheDocument()
    expect(screen.getByTestId('account-signers-card')).toBeInTheDocument()
    expect(screen.getByText('Agent access')).toBeInTheDocument()
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('100.00 USDC.e per day · No activity yet')).toBeInTheDocument()
    expect(screen.getByText('Advanced account details')).toBeInTheDocument()
    // The Safe-owner "Approvers" list went with the same read (#2413).
    expect(screen.queryByText('Approvers')).not.toBeInTheDocument()
  })

  it('does not show a zero balance when portfolio data fails', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 0,
      totalEur: 0,
      breakdown: [],
      loading: false,
      error: 'Balances are temporarily unavailable.',
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getByText('Balances could not load')).toBeInTheDocument()
  })

  it('does not claim there are no agents while agent access is loading', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.queryByText('No agents connected')).not.toBeInTheDocument()
  })

  it('shows a retry state when agent access cannot be verified', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      error: 'Could not load agents',
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText('Agent access could not load')).toBeInTheDocument()
    expect(screen.queryByText('No agents connected')).not.toBeInTheDocument()
  })

  it('keeps readable agent records visible when a refresh fails', () => {
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'legacy-agent-1',
          name: 'Historical agent',
          safe_id: 'safe-1',
          status: 'revoked',
          account_type: 'safe',
          allowances: [],
        },
      ],
      loading: false,
      error: 'Could not refresh agents',
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText('Historical agent')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('last successful agent records')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByText('No agents connected')).not.toBeInTheDocument()
  })

  it('shows last-activity metadata for agents', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          safe_id: 'safe-1',
          status: 'active',
          account_type: 'delegator_hybrid',
          mcp_last_seen_at: '2026-06-01T10:00:00Z',
          allowances: [
            {
              id: 'allowance-1',
              agent_id: 'agent-1',
              token_address: '0x0000000000000000000000000000000000000000',
              token_symbol: 'USDC.e',
              allowance_amount: '100000000',
              reset_period_min: 1440,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText('100.00 USDC.e per day · Last activity 2h ago')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  // #1089: backup & recovery is an account capability — it must work before
  // any agent exists, not gate on one.
  /**
   * #2413 deleted the #1989 fork this comment used to describe: the legacy
   * branch had no account left to render, so the paired legacy-absence /
   * delegation-presence test went with it. Its POSITIVE half is restored
   * below rather than dropped — without it nothing in this file asserts the
   * account's spend affordances render at all, which is exactly the coverage
   * hole a fork-deletion is prone to leaving. Scoped to what the fixture can
   * evidence: Connect agent is not asserted here, because this fixture's
   * account has agents and the button belongs to the empty state.
   */
  it('offers the account spend affordances it renders', () => {
    render(<AccountDetailClient />)

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByTestId('account-signers-card')).toBeInTheDocument()
  })

  // #2414: the unlink route answers 409 while an agent still holds spending
  // authority or a recovery is mid-flight. Before the fix the rejection escaped
  // as an unhandled promise rejection — the spinner stopped and nothing else
  // changed, so a refusal was indistinguishable from a dead button.
  it('keeps the account and says why when unlinking is refused', async () => {
    const removeSafe = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError(
          'Cannot unlink this Haven wallet while an agent has a pending or active budget delegation or recovery is in progress',
          409,
        ),
      )
    mockUseUserSafes.mockReturnValue({ renameSafe: vi.fn(), removeSafe, loading: false })

    render(<AccountDetailClient />)

    fireEvent.click(screen.getByLabelText('Account options'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }))
    expect(screen.getByRole('heading', { name: 'Remove Main account?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent(/still has a budget/i)
    // Pending grants block the unlink too, so the copy must not say "active".
    expect(refusal).not.toHaveTextContent(/active budget/i)
    // "Backup & recovery" on this same page is signer replacement, not the sweep
    // this refusal is about — the copy must not borrow that word as a noun.
    expect(refusal).not.toHaveTextContent(/a recovery/i)
    expect(refusal).toHaveTextContent(/Agents page/i)

    // The refusal is not a navigation and not a dismissal: the account is still
    // linked, the dialog is still open, and the primary action offers a retry.
    expect(mockRouterPush).not.toHaveBeenCalled()
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()
    // The remedy is on another page and the modal backdrop blocks it, so the
    // primary action must NOT invite a second press that can only re-refuse.
    // Same line RemoveAgentDialog draws between `filing_failed` and `too_many`.
    expect(screen.getByRole('button', { name: 'Remove account' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  // The reset lives on `onCancel`, which the real ConfirmDialog also fires for
  // backdrop-click and Escape. Untested, a future edit could drop
  // `setRemoveError(null)` from it and strand a stale refusal in the next
  // dialog session with nothing failing.
  it('does not carry a refusal into the next time the dialog is opened', async () => {
    const removeSafe = vi.fn().mockRejectedValue(new ApiRequestError('nope', 409))
    mockUseUserSafes.mockReturnValue({ renameSafe: vi.fn(), removeSafe, loading: false })

    render(<AccountDetailClient />)

    const openDialog = () => {
      fireEvent.click(screen.getByLabelText('Account options'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }))
    }

    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()

    openDialog()
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a non-refusal unlink failure without blaming a budget', async () => {
    const removeSafe = vi.fn().mockRejectedValue(new ApiRequestError('boom', 500))
    mockUseUserSafes.mockReturnValue({ renameSafe: vi.fn(), removeSafe, loading: false })

    render(<AccountDetailClient />)

    fireEvent.click(screen.getByLabelText('Account options'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent(/could not be removed/i)
    expect(refusal).not.toHaveTextContent(/still has a budget/i)
    // api.ts throws the backend's raw string; a destructive-flow dialog must
    // never render it (the RemoveAgentDialog convention).
    expect(refusal).not.toHaveTextContent(/boom/)
    expect(mockRouterPush).not.toHaveBeenCalled()
    // A transient failure IS retryable in place, so this branch keeps the relabel.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('navigates away when unlinking succeeds', async () => {
    const removeSafe = vi.fn().mockResolvedValue(undefined)
    mockUseUserSafes.mockReturnValue({ renameSafe: vi.fn(), removeSafe, loading: false })

    render(<AccountDetailClient />)

    fireEvent.click(screen.getByLabelText('Account options'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/accounts'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders backup & recovery for a delegation account with zero agents', () => {
    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        wallet_address: '0x5555555555555555555555555555555555555555',
        safes: [{ ...SAFE, account_type: 'delegator_hybrid' }],
      },
      activeSafe: { ...SAFE, account_type: 'delegator_hybrid' },
      setActiveSafe: vi.fn(),
      loading: false,
      passkeys: [],
    })
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    const card = screen.getByTestId('account-signers-card')
    expect(card).toHaveAttribute('data-safe-address', SAFE.safe_address)
    expect(card).not.toHaveAttribute('data-agent-id')
  })
})
