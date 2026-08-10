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
const mockUseSafeApprovers = vi.fn()

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

vi.mock('@/hooks/useSafeApprovers', () => ({
  useSafeApprovers: (...args: unknown[]) => mockUseSafeApprovers(...args),
}))

vi.mock('@/components/DashboardOnboardingGuide', () => ({
  default: ({ hasFirstAgentPayment }: { hasFirstAgentPayment: boolean }) => (
    <div>
      <span>Onboarding guide</span>
      <span>{hasFirstAgentPayment ? 'first-payment-complete' : 'first-payment-pending'}</span>
    </div>
  ),
}))

vi.mock('@/components/ConnectAgent2Modal', () => ({
  default: () => null,
}))

vi.mock('@/components/SendModal', () => ({
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
  // Default: nothing to ask about (no passkey Safe), which is what the real
  // hook does with a null id — it never stops loading, so the nudge stays off.
  mockUseSafeApprovers.mockReturnValue({
    approvers: [],
    threshold: 1,
    loading: true,
    error: null,
    refetch: vi.fn(),
  })
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
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('2 agent payments need your action')).toBeInTheDocument()
    expect(screen.getByText('Agents connected')).toBeInTheDocument()
    expect(screen.getByText('Monthly agent spend')).toBeInTheDocument()
    expect(screen.getByText('$42.00')).toBeInTheDocument()
    expect(screen.getByText('Successful transactions')).toBeInTheDocument()
    expect(screen.getByText('Active accounts')).toBeInTheDocument()
  })

  it('uses singular copy for one agent payment that needs action', () => {
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
          hasFirstAgentPayment: false,
        },
        agents: [],
        transactions: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('1 agent payment needs your action')).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
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
     * #1229: the same exposure on the legacy rail — a Safe whose sole owner
     * (threshold 1) is a passkey signer. It never got this prompt because
     * there was nothing to prompt FOR: enrolling a backup passkey 409'd on the
     * one-per-chain constraint that migration 056 removes.
     */
    const asPasskeySafeUser = (approverCount: number) => {
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: null,
          safes: [SAFE],
        },
        activeSafe: SAFE,
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
      mockUseSafeApprovers.mockReturnValue({
        approvers: Array.from({ length: approverCount }, (_, i) => ({
          address: `0x${String(i).repeat(40)}`,
          type: 'passkey' as const,
          label: null,
        })),
        threshold: 1,
        loading: false,
        error: null,
        refetch: vi.fn(),
      })
    }

    it('shows the nudge for a funded single-owner passkey Safe (#1229)', () => {
      asPasskeySafeUser(1)

      render(<DashboardClient />)

      expect(screen.getByText('Add a backup soon')).toBeInTheDocument()
      // Legacy rail has no "Backup & recovery" screen — it must point at
      // Approvers instead.
      expect(screen.getByText('Approvers')).toBeInTheDocument()
    })

    it('stays silent once the passkey Safe has a second approver (#1229)', () => {
      asPasskeySafeUser(2)

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    // #1205: the recommendation's production origin is now the SERVER —
    // needsBackupSignerRecommendation computed next to the chain
    // classification and delivered on the session safes payload. The
    // device-local read survives only as the older-backend fallback (which is
    // what every test above exercises, since their fixtures omit the field).
    it('trusts a server true — no device-local signer read required (#1205)', () => {
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [{ ...DELEGATOR_SAFE, needs_backup_recommendation: true }],
        },
        activeSafe: DELEGATOR_SAFE,
      })
      // Nothing in localStorage — the server answer must carry alone.

      render(<DashboardClient />)

      expect(screen.getByText('Add a backup soon')).toBeInTheDocument()
    })

    it('trusts a server false even when the stale local read says otherwise (#1205)', () => {
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [{ ...DELEGATOR_SAFE, needs_backup_recommendation: false }],
        },
        activeSafe: DELEGATOR_SAFE,
      })
      storeSigners(1, null) // stale local state claims a missing backup

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    it('keeps the safe-rail nudge off testnet chains via the server classification (#1205)', () => {
      asPasskeySafeUser(1)
      const current = mockUseAuth.mock.results[mockUseAuth.mock.results.length - 1]
      void current
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: null,
          safes: [{ ...SAFE, value_bearing_chain: false }],
        },
        activeSafe: SAFE,
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

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
    })

    it('leaves an imported wallet-owned Safe alone (#1229)', () => {
      // No passkey row points at this Safe, so its owner holds their own key
      // and needs no advice from us.
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555',
          safes: [SAFE],
        },
        activeSafe: SAFE,
        passkeys: [],
      })
      mockUseSafeApprovers.mockReturnValue({
        approvers: [{ address: '0x5555', type: 'eoa' as const, label: null }],
        threshold: 1,
        loading: false,
        error: null,
        refetch: vi.fn(),
      })

      render(<DashboardClient />)

      expect(screen.queryByText('Add a backup soon')).not.toBeInTheDocument()
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
      // mockBaseState() default SAFE has no account_type (legacy rail) and a
      // non-zero balance.
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
