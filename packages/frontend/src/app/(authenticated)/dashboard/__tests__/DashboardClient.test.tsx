import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()
const mockUseAggregatedBalances = vi.fn()
const mockUseDashboardOverview = vi.fn()
const mockUseBalances = vi.fn()
const mockUseSafeDetails = vi.fn()
const mockUseSafeOperationGate = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
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

vi.mock('@/hooks/useAggregatedPortfolio', () => ({
  useAggregatedBalances: () => mockUseAggregatedBalances(),
}))

vi.mock('@/hooks/useDashboardOverview', () => ({
  useDashboardOverview: () => mockUseDashboardOverview(),
}))

vi.mock('@/hooks/useBalances', () => ({
  useBalances: () => mockUseBalances(),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: () => mockUseSafeDetails(),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: () => mockUseSafeOperationGate(),
}))


vi.mock('@/components/DashboardOnboardingGuide', () => ({
  default: ({ hasFirstAgentPayment }: { hasFirstAgentPayment: boolean }) => (
    <div>
      <span>Onboarding guide</span>
      <span>{hasFirstAgentPayment ? 'first-payment-complete' : 'first-payment-pending'}</span>
    </div>
  ),
}))

vi.mock('@/components/ConnectAgentModal', () => ({
  default: () => null,
}))

vi.mock('@/components/DashboardActionPickerModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ReceiveFundsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/AddFundsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/PasskeyOtherDeviceNotice', () => ({
  default: () => <div>Use another device</div>,
}))

const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()
const mockToastInfo = vi.fn()
vi.mock('@/components/ui/Toast', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/Toast')>(
    '@/components/ui/Toast',
  )
  return {
    ...actual,
    useToast: () => ({
      toast: Object.assign(vi.fn(), {
        success: mockToastSuccess,
        error: mockToastError,
        info: mockToastInfo,
      }),
      dismiss: vi.fn(),
      toasts: [],
    }),
  }
})

import DashboardClient from '../DashboardClient'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
  account_type: 'delegator_hybrid' as const,
}

function mockBaseState() {
  mockUseAuth.mockReturnValue({
    user: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      wallet_address: '0x5555555555555555555555555555555555555555',
      safes: [SAFE],
    },
    activeSafe: SAFE,
  })
  mockUsePreferences.mockReturnValue({ currency: 'USD' })
  mockUseContacts.mockReturnValue({
    contacts: [],
    error: null,
    resolveAddress: vi.fn(() => null),
  })
  mockUseAgents.mockReturnValue({
    agents: [{ id: 'agent-1', name: 'Research agent' }],
    loading: false,
    refetch: vi.fn(),
  })
  mockUseAggregatedBalances.mockReturnValue({
    balances: [{ balance: '1000000' }],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseDashboardOverview.mockReturnValue({
    data: {
      totals: { usd: 1234.56, eur: 1100 },
      change: {
        available: true,
        usdAmount: 12.34,
        eurAmount: 11,
        usdPercent: 1.23,
        eurPercent: 1,
      },
      metrics: {
        connectedAgents: 1,
        monthlyAgentSpendUsd: 42,
        monthlyAgentSpendEur: 38,
        successfulTransactions: 4,
        activeAccounts: 1,
      },
      actionableApprovals: 2,
      pendingApprovals: 2,
      onboardingProgress: {
        hasFirstAgentPayment: false,
      },
      agents: [],
      transactions: [],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseBalances.mockReturnValue({
    balances: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseSafeDetails.mockReturnValue({
    details: null,
    loading: false,
    error: null,
  })
  mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
}

describe('DashboardClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    mockBaseState()
  })

  it('leads with total balance, primary actions, attention, and metric cards', () => {
    render(<DashboardClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    // Send and the approvals attention row are DELETED (#1989) — asserted as
    // absences in their own dedicated test below, where the fixture is set up
    // to make a regression visible rather than merely unasserted.
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
    expect(screen.getByText('Agents connected')).toBeInTheDocument()
    expect(screen.getByText('Monthly agent spend')).toBeInTheDocument()
    expect(screen.getByText('$42.00')).toBeInTheDocument()
    expect(screen.getByText('Successful transactions')).toBeInTheDocument()
    expect(screen.getByText('Active accounts')).toBeInTheDocument()
  })

  it('keeps a legacy-only dashboard readable without a Connect agent CTA', () => {
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
    })
    mockUseAgents.mockReturnValue({ agents: [], loading: false, refetch: vi.fn() })

    render(<DashboardClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText(/agent connections are retired/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect agent' })).toBeNull()
    expect(screen.queryByText('Onboarding guide')).toBeNull()
  })

  /**
   * #1989 (epic #1440): the dashboard's two legacy-Safe spend/approval
   * affordances are GONE — the hero's Send button (it opened `SendModal`, which
   * is deleted with the rail) and the "Needs attention" approvals row with its
   * "Open approvals" link (`/approvals` no longer routes and
   * `POST /approvals/:id/approve` answers 410 since #1986).
   *
   * This replaces `uses singular copy for one agent payment that needs action`,
   * whose entire subject was the deleted row.
   *
   * The fixture is deliberately the WORST case for these absences rather than
   * the easiest: a legacy (non-`delegator_hybrid`) Safe account — the exact
   * account type both affordances used to render for — with a non-zero
   * `actionableApprovals`. On `dev` before this change every one of these
   * assertions fails. That is what stops it being a guard over the empty set:
   * put either affordance back and it goes red here.
   */
  it('offers neither a Send affordance nor an approvals route, even for a funded legacy Safe with pending approvals', () => {
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
    })
    mockUseDashboardOverview.mockReturnValue({
      data: {
        totals: { usd: 1234.56, eur: 1100 },
        change: {
          available: true,
          usdAmount: 12.34,
          eurAmount: 11,
          usdPercent: 1.23,
          eurPercent: 1,
        },
        metrics: {
          connectedAgents: 1,
          monthlyAgentSpendUsd: 42,
          monthlyAgentSpendEur: 38,
          successfulTransactions: 4,
          activeAccounts: 1,
        },
        actionableApprovals: 1,
        pendingApprovals: 1,
        onboardingProgress: {
          hasFirstAgentPayment: true,
        },
        agents: [],
        transactions: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    // Positive control FIRST: the dashboard really rendered its funded hero.
    // Without this the four absences below would all be satisfied by a blank
    // screen — the failure mode #1987 paid for.
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.queryByText('1 agent payment needs your action')).toBeNull()
    expect(screen.queryByRole('link', { name: /Open approvals/i })).toBeNull()
    expect(
      Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    ).not.toContain('/approvals')
  })

  it('does not show empty preview states while overview is loading', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.queryByText('No transactions yet')).not.toBeInTheDocument()
    expect(screen.queryByText('No connected agents right now')).not.toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('does not show the guide while first-payment progress is still loading', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('shows the first-payment step as pending after setup progress resolves incomplete', () => {
    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    expect(screen.getByText('first-payment-pending')).toBeInTheDocument()
  })

  it('does not flash the guide for completed setup after the completion banner was dismissed', () => {
    window.localStorage.setItem('haven-onboarding-complete-dismissed:user-1', '1')
    mockUseDashboardOverview.mockReturnValue({
      data: {
        totals: { usd: 1234.56, eur: 1100 },
        change: {
          available: true,
          usdAmount: 12.34,
          eurAmount: 11,
          usdPercent: 1.23,
          eurPercent: 1,
        },
        metrics: {
          connectedAgents: 1,
          monthlyAgentSpendUsd: 42,
          monthlyAgentSpendEur: 38,
          successfulTransactions: 4,
          activeAccounts: 1,
        },
        actionableApprovals: 0,
        pendingApprovals: 0,
        onboardingProgress: {
          hasFirstAgentPayment: true,
        },
        agents: [],
        transactions: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
    expect(screen.queryByText('first-payment-complete')).not.toBeInTheDocument()
  })

  it('does not show the unfunded receive CTA before balances finish loading', () => {
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive funds' })).not.toBeInTheDocument()
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('does not mark the account unfunded when aggregate balances fail to load', () => {
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: false,
      error: 'Failed to load balances',
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive funds' })).not.toBeInTheDocument()
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('shows a focused first-run guide instead of the full dashboard when the account needs funds', () => {
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    expect(screen.queryByText('Agents connected')).not.toBeInTheDocument()
    expect(screen.queryByText('Recent transactions')).not.toBeInTheDocument()
    expect(screen.queryByText('Monthly agent spend')).not.toBeInTheDocument()
  })

  it('does not persist first-run guide dismissal across browser sessions', () => {
    window.localStorage.setItem('haven_dashboard_onboarding_dismissed:user-1:fund', '1')
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
  })

  it('does not show the connect-agent guide before agents finish loading', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: true,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('does not show a zero balance when dashboard totals fail to load', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: null,
      loading: false,
      error: 'Dashboard is temporarily unavailable.',
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getByText('Dashboard data could not load')).toBeInTheDocument()
    expect(screen.getByText('Haven could not refresh balances, agents, and activity.')).toBeInTheDocument()
    expect(screen.queryByText('Dashboard is temporarily unavailable.')).not.toBeInTheDocument()
    expect(screen.getByText('Agent preview unavailable')).toBeInTheDocument()
    expect(screen.getByText('Activity preview unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No transactions yet')).not.toBeInTheDocument()
  })

  describe('backup-signer recovery nudge (#1153 funded-state trigger)', () => {
    const DELEGATOR_SAFE = { ...SAFE, account_type: 'delegator_hybrid' }

    /** The signer set AuthContext resolves on login, as the dashboard reads it. */
    const storeSigners = (passkeys: number, owner: string | null) => {
      window.localStorage.setItem(
        `haven_hybrid_signers_${DELEGATOR_SAFE.safe_address.toLowerCase()}_${DELEGATOR_SAFE.chain_id}`,
        JSON.stringify({
          account_address: DELEGATOR_SAFE.safe_address,
          chain_id: DELEGATOR_SAFE.chain_id,
          owner_address: owner,
          passkeys: Array.from({ length: passkeys }, (_, i) => ({ key_id: `0x0${i}`, x: '0x1', y: '0x2' })),
        }),
      )
    }

    const asDelegationUser = () =>
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [DELEGATOR_SAFE],
        },
        activeSafe: DELEGATOR_SAFE,
      })

    it('shows the nudge for a funded, single-signer delegation-rail account', () => {
      asDelegationUser()
      storeSigners(1, null) // one passkey, no owner → no recovery
      // mockBaseState() already sets a non-zero aggregated balance.

      render(<DashboardClient />)

      expect(screen.getByText('Add a backup soon')).toBeInTheDocument()
    })

    it('stays silent when the account ALREADY has a backup', () => {
      // Recommending a backup to someone who enrolled one teaches them to
      // ignore the banner — and it is the state the nudge is asking for.
      asDelegationUser()
      storeSigners(2, null)

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    it('counts an EOA owner as the second signer', () => {
      asDelegationUser()
      storeSigners(1, '0x5555555555555555555555555555555555555555')

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    /**
     * #1989 (epic #1440) removed the LEGACY-rail arm of this nudge, and this
     * test is the inversion of the four #1229/#1205 tests that used to live
     * here.
     *
     * Those four are deleted rather than kept, and the distinction matters:
     * three of them ('stays silent once the passkey Safe has a second
     * approver', 'keeps the safe-rail nudge off testnet chains', 'leaves an
     * imported wallet-owned Safe alone') all asserted that NO nudge renders
     * for some legacy configuration. Every one of them is now true by
     * CONSTRUCTION — no legacy configuration can produce a nudge at all — so
     * keeping them would have left three green tests guarding the empty set,
     * which is exactly the #1987 defect. They were removed and replaced by the
     * single assertion that actually still has content: the arm is gone for
     * the configuration it used to FIRE on.
     *
     * The positive control is in the same test on purpose. Without it, "no
     * nudge for a legacy Safe" is satisfied by breaking the nudge outright.
     */
    it('shows no backup nudge for a funded single-owner passkey Safe, while the delegation nudge still fires', () => {
      const asPasskeySafeUser = () => {
        mockUseAuth.mockReturnValue({
          user: {
            id: 'user-1',
            name: 'Ada',
            email: 'ada@example.com',
            wallet_address: null,
            safes: [{ ...SAFE, account_type: 'safe' as const }],
          },
          activeSafe: { ...SAFE, account_type: 'safe' as const },
          passkeys: [
            {
              id: 'passkey-1',
              credential_id: 'cred-primary',
              signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
              chain_id: SAFE.chain_id,
              safe_address: SAFE.safe_address,
              created_at: '2026-05-12T00:00:00Z',
            },
          ],
        })
      }

      // The exact fixture that used to render the nudge: funded, legacy
      // passkey-owned Safe, sole owner.
      asPasskeySafeUser()
      const { unmount } = render(<DashboardClient />)
      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
      // And it no longer points anywhere: 'Approvers' was the destination.
      expect(screen.queryByText('Approvers')).not.toBeInTheDocument()
      unmount()

      // POSITIVE CONTROL — the nudge itself is alive on the delegation rail.
      asDelegationUser()
      storeSigners(1, null)
      render(<DashboardClient />)
      expect(screen.getByText('Add a backup soon')).toBeInTheDocument()
      expect(screen.getByText('Backup & recovery')).toBeInTheDocument()
    })

    it('stays silent when the signer set is unknown — a failed read must not nag', () => {
      asDelegationUser()
      // Nothing stored: AuthContext skips per-safe failures silently, so an
      // absent set means "we do not know", not "no backup".

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    it('does not show the nudge for an unfunded delegation-rail account', () => {
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [DELEGATOR_SAFE],
        },
        activeSafe: DELEGATOR_SAFE,
      })
      mockUseAggregatedBalances.mockReturnValue({
        balances: [],
        loading: false,
        error: null,
        refetch: vi.fn(),
      })

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    it('does not show the nudge when a transient balance-fetch failure makes funded state unknown', () => {
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [DELEGATOR_SAFE],
        },
        activeSafe: DELEGATOR_SAFE,
      })
      mockUseAggregatedBalances.mockReturnValue({
        balances: [],
        loading: false,
        error: 'Failed to load balances',
        refetch: vi.fn(),
      })

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    it('does not show the nudge for a funded account that is not on the delegation rail', () => {
      // mockBaseState() defaults to the live delegation rail; legacy cases
      // supply an explicit `account_type: 'safe'` fixture.
      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })
  })

  describe('first-arrival welcome toast', () => {
    it('fires a welcome toast and clears the flag when arriving from onboarding', () => {
      window.sessionStorage.setItem('haven-just-onboarded', '1')

      render(<DashboardClient />)

      expect(mockToastSuccess).toHaveBeenCalledOnce()
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Welcome to Haven, Ada — your account is live.',
      )
      // Flag is consumed so a refresh later in the session does NOT re-fire.
      expect(window.sessionStorage.getItem('haven-just-onboarded')).toBeNull()
    })

    it('does not fire the welcome toast on a normal dashboard render', () => {
      // No session flag set.
      render(<DashboardClient />)

      expect(mockToastSuccess).not.toHaveBeenCalledWith(
        expect.stringContaining('Welcome to Haven'),
      )
    })

    it('falls back silently when sessionStorage is unavailable', () => {
      // Simulate private-browsing-style failure on read.
      const getSpy = vi
        .spyOn(window.sessionStorage.__proto__, 'getItem')
        .mockImplementation(() => {
          throw new Error('sessionStorage disabled')
        })

      expect(() => render(<DashboardClient />)).not.toThrow()
      expect(mockToastSuccess).not.toHaveBeenCalledWith(
        expect.stringContaining('Welcome to Haven'),
      )

      getSpy.mockRestore()
    })
  })
})
