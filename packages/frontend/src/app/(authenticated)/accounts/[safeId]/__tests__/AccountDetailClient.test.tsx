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
  default: ({ open, body, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel }: {
    open: boolean
    body: ReactNode
    confirmLabel: string
    cancelLabel?: string
    onConfirm: () => void | Promise<void>
    onCancel: () => void
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
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
    expect(screen.getByText('1 of 1 approver required')).toBeInTheDocument()
    expect(screen.getByText('Agent access')).toBeInTheDocument()
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('100.00 USDC.e per day · No activity yet')).toBeInTheDocument()
    expect(screen.getByText('Advanced account details')).toBeInTheDocument()
    expect(screen.getByText('Approvers')).toBeInTheDocument()
    expect(screen.getByText('Wallet')).toBeInTheDocument()
    expect(screen.getByText('Personal wallet')).toBeInTheDocument()
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
   * #1989 (epic #1440). Both halves in one test on purpose: the deletion is a
   * FORK, and #1984's lesson is that a guard against a fork must name its
   * branch. Asserting only the legacy absence would be satisfied by removing
   * Send from every account; asserting only the delegation presence would be
   * satisfied by leaving the legacy path in place.
   */
  describe('approver type badge (#2017)', () => {
    const PASSKEY_SIGNER = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2'
    const WALLET_OWNER = '0x5555555555555555555555555555555555555555'
    const STRANGER = '0x9999999999999999999999999999999999999999'

    const withOwners = (owners: string[]) => {
      const state = {
        details: { address: SAFE.safe_address, owners, threshold: owners.length, nonce: 1 },
        loading: false,
        error: null,
      }
      mockUseSafeDetails.mockReturnValue(state)
      mockUseRetiredRailOwnerAccess.mockReturnValue({ ...state, ownerAccess: 'unknown' })
    }

    const asUser = (walletAddress: string | null, enrolledPasskeys: string[]) =>
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: walletAddress,
          safes: [SAFE],
        },
        activeSafe: SAFE,
        setActiveSafe: vi.fn(),
        loading: false,
        passkeys: enrolledPasskeys.map((signer, i) => ({
          id: `passkey-${i}`,
          credential_id: `cred-${i}`,
          signer_address: signer,
          chain_id: SAFE.chain_id,
          safe_address: SAFE.safe_address,
          created_at: '2026-05-12T00:00:00Z',
        })),
      })

    /**
     * The badge used to read `passkeyAddresses.has(owner) ? 'Passkey' :
     * 'Wallet'` — a positive claim inferred from an ABSENCE. `passkeyAddresses`
     * is Haven's live enrolment record for this Safe on this chain, not ground
     * truth about the on-chain owner set, so an owner missing from it proves
     * nothing. This is the case that predicate got wrong, and it is asserted
     * first because it is the only one that distinguishes the two versions:
     * both label a known passkey 'Passkey' and both label the user's own wallet
     * 'Wallet'.
     */
    it('labels an approver Haven cannot identify Unknown, never Wallet', () => {
      asUser(WALLET_OWNER, [PASSKEY_SIGNER])
      withOwners([STRANGER])

      render(<AccountDetailClient />)

      // Positive control: the Approvers section rendered at all, so the
      // absence asserted below is a real absence and not a blank card.
      expect(screen.getByText('Approvers')).toBeInTheDocument()

      expect(screen.getByText('Unknown')).toBeInTheDocument()
      expect(screen.queryByText('Wallet')).toBeNull()
      expect(screen.queryByText('Passkey')).toBeNull()
    })

    it('still labels a known passkey Passkey and the user own wallet Wallet', () => {
      asUser(WALLET_OWNER, [PASSKEY_SIGNER])
      withOwners([PASSKEY_SIGNER, WALLET_OWNER])

      render(<AccountDetailClient />)

      expect(screen.getByText('Passkey')).toBeInTheDocument()
      expect(screen.getByText('Wallet')).toBeInTheDocument()
      expect(screen.queryByText('Unknown')).toBeNull()
    })

    /**
     * `haven-design-reviewer` blocked the first version of this, which put the
     * explanation in a `Tooltip`: the bubble is `whitespace-nowrap` with no
     * max-width, and its `onFocus` never fires because both the wrapper and
     * `StatusBadge` are non-focusable spans — so the copy was unreachable by
     * touch AND keyboard, on a list a user may be auditing to decide whether
     * they still control the account. It is visible text now, and these two
     * assertions are what stop it regressing back behind a hover.
     */
    it('explains Unknown in visible text, not behind a hover', () => {
      asUser(WALLET_OWNER, [PASSKEY_SIGNER])
      withOwners([STRANGER])

      render(<AccountDetailClient />)

      // No hover, no focus, no click — it is simply on the page.
      expect(
        screen.getByText(/Haven holds no record identifying that approver/i),
      ).toBeInTheDocument()
    })

    it('does not show the Unknown explanation when every approver is identified', () => {
      asUser(WALLET_OWNER, [PASSKEY_SIGNER])
      withOwners([PASSKEY_SIGNER, WALLET_OWNER])

      render(<AccountDetailClient />)

      // Positive control: the list rendered, so the absence below is real.
      expect(screen.getByText('Approvers')).toBeInTheDocument()
      expect(screen.getByText('Passkey')).toBeInTheDocument()

      expect(
        screen.queryByText(/Haven holds no record identifying that approver/i),
      ).toBeNull()
    })

    /**
     * A user with no connected wallet at all. Under the old predicate EVERY
     * owner outside the passkey record read 'Wallet', including for an account
     * where Haven knows of no wallet whatsoever.
     */
    it('does not invent a Wallet for a user who has no wallet address', () => {
      asUser(null, [PASSKEY_SIGNER])
      withOwners([PASSKEY_SIGNER, STRANGER])

      render(<AccountDetailClient />)

      expect(screen.getByText('Passkey')).toBeInTheDocument()
      expect(screen.getByText('Unknown')).toBeInTheDocument()
      expect(screen.queryByText('Wallet')).toBeNull()
    })

    /**
     * The passkey record is chain- and Safe-scoped. A passkey enrolled on a
     * DIFFERENT chain is exactly the "stale or incomplete record" case, and it
     * must not silently become a Wallet.
     */
    it('does not call an owner a Wallet because their passkey is recorded on another chain', () => {
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: null,
          safes: [SAFE],
        },
        activeSafe: SAFE,
        setActiveSafe: vi.fn(),
        loading: false,
        passkeys: [
          {
            id: 'passkey-other-chain',
            credential_id: 'cred-other-chain',
            signer_address: PASSKEY_SIGNER,
            chain_id: SAFE.chain_id + 1,
            safe_address: SAFE.safe_address,
            created_at: '2026-05-12T00:00:00Z',
          },
        ],
      })
      withOwners([PASSKEY_SIGNER])

      render(<AccountDetailClient />)

      expect(screen.getByText('Unknown')).toBeInTheDocument()
      expect(screen.queryByText('Wallet')).toBeNull()
    })
  })

  describe('owner send after the Safe-rail retirement (#1989)', () => {
    it('offers no Send affordance on a wallet-owned legacy Safe account, and says why', () => {
      const legacySafe = { ...SAFE, account_type: 'safe' as const }
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [legacySafe],
        },
        activeSafe: legacySafe,
        setActiveSafe: vi.fn(),
        loading: false,
        passkeys: [],
      })
      mockUseRetiredRailOwnerAccess.mockReturnValue({
        ...mockUseSafeDetails(),
        ownerAccess: 'wallet',
      })
      render(<AccountDetailClient />)

      // Positive control: the page rendered, and rendered READABLY — the
      // epic's hard boundary. Without this the absence below is satisfied by a
      // blank screen.
      expect(screen.getByRole('heading', { name: 'Main account' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()

      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      expect(
        screen.getByText(/Haven no longer sends payments from this account/i),
      ).toBeInTheDocument()
    })

    it('does not offer Connect agent for a legacy Safe with no existing agents', () => {
      const legacySafe = { ...SAFE, account_type: 'safe' as const }
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [legacySafe],
        },
        activeSafe: legacySafe,
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

      expect(screen.getByText(/connections are retired for this older Safe account/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Connect agent' })).toBeNull()
    })

    /**
     * The notice's second paragraph is branched on owner type, and this is the
     * guard for it. `haven-reviewer` caught the first version telling EVERY
     * legacy account its funds were "reachable with your own Safe tooling" —
     * false for a passkey-only Safe, and contradicting `account-recovery.md`
     * and `CLAUDE.md` in the same pull request.
     *
     * All three branches are asserted, and the `unknown` one matters most: it
     * is the state where claiming either answer would be a guess, so the
     * notice must claim NEITHER. A test that only checked the two confident
     * branches would pass against a component that guessed while loading.
     */
    it('tells a wallet-owned Safe it can exit via Safe, and a passkey-only Safe that it cannot', () => {
      const PASSKEY_SIGNER = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2'
      const withOwners = (owners: string[] | null) => {
        const state = {
          details: owners
            ? { address: SAFE.safe_address, owners, threshold: 1, nonce: 1 }
            : null,
          loading: owners === null,
          error: null,
        }
        mockUseSafeDetails.mockReturnValue(state)
        mockUseRetiredRailOwnerAccess.mockReturnValue({
          ...state,
          ownerAccess:
            owners?.includes('0x5555555555555555555555555555555555555555')
              ? 'wallet'
              : owners?.length === 1 && owners[0] === PASSKEY_SIGNER
                ? 'passkey-only'
                : 'unknown',
        })
      }
      const asPasskeyUser = (walletAddress: string | null = null) =>
        mockUseAuth.mockReturnValue({
          user: {
            id: 'user-1',
            name: 'Ada',
            email: 'ada@example.com',
            wallet_address: walletAddress,
            safes: [{ ...SAFE, account_type: 'safe' as const }],
          },
          activeSafe: { ...SAFE, account_type: 'safe' as const },
          setActiveSafe: vi.fn(),
          loading: false,
          passkeys: [
            {
              id: 'passkey-1',
              credential_id: 'cred-primary',
              signer_address: PASSKEY_SIGNER,
              chain_id: SAFE.chain_id,
              safe_address: SAFE.safe_address,
              created_at: '2026-05-12T00:00:00Z',
            },
          ],
        })

      // ── wallet owner: Safe's own interface is a real answer ──────────────
      // The user's OWN wallet is on the owner list — positive evidence, not
      // "this owner isn't a passkey we recognise".
      asPasskeyUser('0x5555555555555555555555555555555555555555')
      withOwners(['0x5555555555555555555555555555555555555555'])
      const wallet = render(<AccountDetailClient />)
      expect(screen.getByText(/may be able to move them/i)).toBeInTheDocument()
      expect(screen.queryByText(/no self-serve way to move them out/i)).toBeNull()
      wallet.unmount()

      // ── passkey-only: it is not, and the notice must not pretend ─────────
      asPasskeyUser()
      withOwners([PASSKEY_SIGNER])
      const passkeyOnly = render(<AccountDetailClient />)
      expect(screen.getByText(/no self-serve way to move them out/i)).toBeInTheDocument()
      expect(screen.queryByText(/move them at any time/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull()
      expect(screen.queryByText(/Receive funds to see tokens/i)).toBeNull()
      passkeyOnly.unmount()

      // ── an UNRECOGNISED owner: claim nothing ─────────────────────────────
      // This is the case the first version of the predicate got dangerously
      // wrong. An owner Haven holds no passkey row for is NOT proof of a
      // wallet — `POST /safe/exec` authorises exactly such an unbound backup
      // passkey against the on-chain owner list. Reasoning from absence here
      // would send a passkey-only owner to an interface that cannot sign for
      // them.
      asPasskeyUser()
      withOwners(['0x9999999999999999999999999999999999999999'])
      const unrecognised = render(<AccountDetailClient />)
      expect(
        screen.getByText(/Haven no longer sends payments from this account/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/move them at any time/i)).toBeNull()
      expect(screen.queryByText(/no self-serve way to move them out/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull()
      expect(screen.queryByText(/Receive funds to see tokens/i)).toBeNull()
      unrecognised.unmount()

      // ── unknown: claim NOTHING, while still rendering the notice ─────────
      asPasskeyUser()
      withOwners(null)
      render(<AccountDetailClient />)
      expect(
        screen.getByText(/Haven no longer sends payments from this account/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/move them at any time/i)).toBeNull()
      expect(screen.queryByText(/no self-serve way to move them out/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull()
      expect(screen.queryByText(/Receive funds to see tokens/i)).toBeNull()
    })

    it('keeps Send on a delegation account and shows it no retirement note', () => {
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

      render(<AccountDetailClient />)

      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
      expect(
        screen.queryByText(/Haven no longer sends payments from this account/i),
      ).toBeNull()
    })
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))

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
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))

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
