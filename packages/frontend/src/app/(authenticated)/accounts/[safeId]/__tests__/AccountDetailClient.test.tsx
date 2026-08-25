import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUseOwnerDirectory = vi.fn()
const mockUseUserSafes = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()
const mockUseSafeDetails = vi.fn()
const mockUsePortfolio = vi.fn()
const mockUseBalances = vi.fn()
const mockUseTransactionsFeed = vi.fn()

vi.mock('next/navigation', () => ({
  useParams: () => ({ safeId: 'safe-1' }),
  useRouter: () => ({ push: vi.fn() }),
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
  default: () => null,
}))

vi.mock('@/components/AccountSignersCard', () => ({
  default: (props: { safeAddress?: string; agentId?: string }) => (
    <div data-testid="account-signers-card" data-safe-address={props.safeAddress} data-agent-id={props.agentId}>
      Backup &amp; recovery
    </div>
  ),
}))

import AccountDetailClient from '../AccountDetailClient'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
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

    const withOwners = (owners: string[]) =>
      mockUseSafeDetails.mockReturnValue({
        details: { address: SAFE.safe_address, owners, threshold: owners.length, nonce: 1 },
        loading: false,
        error: null,
      })

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
    it('offers no Send affordance on a legacy Safe account, and says why', () => {
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
      const withOwners = (owners: string[] | null) =>
        mockUseSafeDetails.mockReturnValue({
          details: owners
            ? { address: SAFE.safe_address, owners, threshold: 1, nonce: 1 }
            : null,
          loading: owners === null,
          error: null,
        })
      const asPasskeyUser = (walletAddress: string | null = null) =>
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
      expect(screen.getByText(/move them at any time/i)).toBeInTheDocument()
      expect(screen.queryByText(/no self-serve way to move them out/i)).toBeNull()
      wallet.unmount()

      // ── passkey-only: it is not, and the notice must not pretend ─────────
      asPasskeyUser()
      withOwners([PASSKEY_SIGNER])
      const passkeyOnly = render(<AccountDetailClient />)
      expect(screen.getByText(/no self-serve way to move them out/i)).toBeInTheDocument()
      expect(screen.queryByText(/move them at any time/i)).toBeNull()
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
