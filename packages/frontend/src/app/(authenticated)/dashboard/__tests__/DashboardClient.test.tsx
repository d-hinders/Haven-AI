import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()
const mockUseAggregatedBalances = vi.fn()
const mockUseDashboardOverview = vi.fn()
const mockUseBalances = vi.fn()
const mockUseSafeDetails = vi.fn()
const mockUseAccountOperationGate = vi.fn()

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

vi.mock('@/hooks/useAccountOperationGate', () => ({
  useAccountOperationGate: () => mockUseAccountOperationGate(),
}))

// #3808: the rules read the budget-remaining poll for the ≥90% arm; the
// dashboard tests here exercise the wiring, not the poll (its contract has
// its own suite).
vi.mock('@/hooks/useBudgetRemaining', () => ({
  useBudgetRemaining: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}))

// #3813: server-saved dismissals are a hook with its own suite — here the
// dashboard tests pin the WIRING (a dismissed id hides its item; a dismiss
// on a dismissible kind writes through to the hook).
const mockUseAttentionDismissals = vi.fn()
const mockDismissOnServer = vi.fn()
vi.mock('@/hooks/useAttentionDismissals', () => ({
  useAttentionDismissals: () => mockUseAttentionDismissals(),
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
import type { DashboardAgentPreview } from '@/types/dashboard'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
  account_type: 'delegator_hybrid' as const,
}

function mockBaseState(
  overviewAgents: DashboardAgentPreview[] = [],
  // #3808: the rules read the #3803 wire fields (accounts, spend) that the
  // base shape predates; tests that exercise them pass them here.
  overviewExtras: Record<string, unknown> = {},
) {
  mockUseAuth.mockReturnValue({
    user: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      wallet_address: '0x5555555555555555555555555555555555555555',
      accounts: [SAFE],
    },
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
      totals: { usd: 1234.56, eur: 1100, sek: 13000.5 },
      change: {
        available: true,
        usdAmount: 12.34,
        eurAmount: 11,
        sekAmount: null,
        usdPercent: 1.23,
        eurPercent: 1,
        sekPercent: 0,
      },
      // #3807: the metrics block is gone with the KPI tiles.
      actionableApprovals: 2,
      pendingApprovals: 2,
      onboardingProgress: {
        hasFirstAgentPayment: false,
      },
      agents: overviewAgents,
      transactions: [],
      ...overviewExtras,
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
  mockUseAccountOperationGate.mockReturnValue({ kind: 'ready' })
}

describe('DashboardClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    mockUseAttentionDismissals.mockReturnValue({
      dismissedIds: new Set<string>(),
      dismiss: mockDismissOnServer,
    })
    mockBaseState()
  })

  describe('agents section wiring (#3809)', () => {
    /** `useAgents` knows an agent exists; the overview supplies the preview rows. */
    const previewAgent = (budgets: DashboardAgentPreview['budgets'] = []): DashboardAgentPreview => ({
      id: 'agent-1',
      name: 'Research agent',
      status: 'active',
      accountId: null,
      accountName: null,
      accountChainId: 8453,
      allowances: [],
      budgets,
      receivedSubBudgets: [],
      stats: {
        d7: {
          gross: { usd: 0, eur: 0, sek: 0 },
          net: { usd: 0, eur: 0, sek: 0 },
          approx: false,
          payments: 0,
          refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
        },
        d30: {
          gross: { usd: 0, eur: 0, sek: 0 },
          net: { usd: 0, eur: 0, sek: 0 },
          approx: false,
          payments: 0,
          refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
        },
        lastPaymentAt: null,
        lastCounterparty: null,
      },
    })

    it('reads "No budget" for an agent with zero live budgets — not "No spend limits"', () => {
      // #3802: the overview's budgets array carries only live (unexpired,
      // started) budgets, so an empty array means the agent cannot spend at
      // all. "No spend limits" said the opposite of the truth.
      mockBaseState([previewAgent([])])

      render(<DashboardClient />)

      expect(screen.getByText('No budget')).toBeInTheDocument()
      expect(screen.queryByText('No spend limits')).not.toBeInTheDocument()
    })

    it('renders the overview agents through the shared section (badge from the rules, never "Connected")', () => {
      // The budget-remaining poll is mocked to null at the top of this file,
      // so the row's budget read is UNKNOWN — an em dash, never a 0% bar.
      // The old per-status "Connected" badge is gone with #3809.
      mockBaseState([
        previewAgent([
          {
            id: 'budget-1',
            delegationHash: `0x${'11'.repeat(32)}`,
            chainId: 8453,
            tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            tokenSymbol: 'USDC',
            decimals: 6,
            budgetAtomic: '250000000',
            periodSeconds: 86_400,
            startDate: '2026-10-01T00:00:00.000Z',
            expiresAt: '2027-01-01T00:00:00.000Z',
            periodEnd: '2026-10-11T00:00:00.000Z',
          },
        ]),
      ])

      render(<DashboardClient />)

      expect(screen.getByRole('heading', { level: 2, name: 'Agents' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /Research agent/ })).toBeInTheDocument()
      // The page's money-panel tiles also render em dashes for zero windows —
      // scope to the agent row's own caption.
      expect(within(screen.getByRole('link', { name: /Research agent/ })).getByText('—')).toBeInTheDocument()
      expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    })
  })

  it('leads with total balance, the money panel, and its two actions', () => {
    render(<DashboardClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    // #3807: the four KPI tiles are gone; the money panel renders the
    // templated 7-day summary and the 30-day spending block in their place.
    expect(screen.getByRole('button', { name: 'Deposit address' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
    expect(screen.getByText('Spending, last 30 days')).toBeInTheDocument()
    expect(screen.getByText('Payments')).toBeInTheDocument()
    expect(screen.getByText('Merchants')).toBeInTheDocument()
    expect(screen.getByText('Stopped by budget')).toBeInTheDocument()
  })

  /**
   * #3127 direction A: SEK is a first-class display currency on the
   * dashboard. Every figure comes from the SEK keys the overview route
   * serves — the pre-#3127 frontend had no SEK branch at all, so a SEK user
   * got `totals.usd` run through a SEK-labelled formatter. The exact strings
   * are this repo's Node (v24, full ICU, pinned via .nvmrc) output for
   * sv-SE, read off the real formatter rather than guessed: NBSP group
   * separators, decimal comma, the symbol suffix behind an NBSP.
   */
  describe('SEK display currency (#3127)', () => {
    function mockSekOverview(overrides: { sekAmount?: number | null; sekPercent?: number } = {}) {
      mockUsePreferences.mockReturnValue({ currency: 'SEK' })
      mockUseDashboardOverview.mockReturnValue({
        data: {
          totals: { usd: 1234.56, eur: 1100, sek: 13000.5 },
          change: {
            available: true,
            usdAmount: 12.34,
            eurAmount: 11,
            usdPercent: 1.23,
            eurPercent: 1,
            sekAmount: null,
            sekPercent: 0,
            ...overrides,
          },
      // #3807: the metrics block is gone with the KPI tiles.
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
    }

    it('renders the SEK total and its change line from the SEK keys', () => {
      mockSekOverview({ sekAmount: 130, sekPercent: 1 })
      render(<DashboardClient />)

      // The needles are written in the post-normalization form: getByText
      // collapses the sv-SE NBSPs to plain spaces on the node side. The exact
      // NBSP/decimal-comma voice is pinned byte-for-byte on the formatter in
      // `lib/__tests__/analytics-format.test.ts`; the accounts card's compact
      // voice is pinned in AccountsOverviewClient.test.tsx.
      expect(screen.getByText('13 000,50 kr')).toBeInTheDocument()
      // #3195 (round-2 finding b): the percent renders in the currency's
      // locale — sv-SE under SEK: decimal comma, NBSP before `%` (normalized
      // to a plain space by getByText). The kr half was already sv-SE; the
      // line no longer mixes a hand-rolled English percent scaffold into it.
      expect(screen.getByText('+130,00 kr (+1,00 %) since yesterday')).toBeInTheDocument()
      // #3807: the monthly-spend SEK figure lives in the spending block now,
      // read from `spend.d30` — this fixture carries no spend block, so the
      // block renders its quiet placeholder instead of a number.
      expect(screen.getAllByText('—').length).toBeGreaterThan(0)
      // The USD total must not leak onto a SEK hero under any label.
      expect(screen.queryByText('$1,234.56')).toBeNull()
    })

    it('reports the change as unavailable while the SEK baseline predates migration 090', () => {
      // `sekAmount: null` is what the wire sends when yesterday's snapshot has
      // no SEK total to diff against. Reading the null as 0 would paint a
      // flat-day swing the data does not support, so the hero falls to the
      // quiet caption instead — the same treatment a missing change value
      // already gets.
      mockSekOverview({ sekAmount: null })
      render(<DashboardClient />)

      expect(screen.getByText('13 000,50 kr')).toBeInTheDocument()
      expect(screen.queryByText(/since yesterday/)).toBeNull()
      expect(screen.getByText('Across all linked Haven accounts.')).toBeInTheDocument()
    })

    it('keeps the USD hero for a USD preference', () => {
      render(<DashboardClient />)

      expect(screen.getByText('$1,234.56')).toBeInTheDocument()
      expect(screen.queryByText(/kr/)).toBeNull()
    })
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
   * #2459 — fixture decision, DELETED not kept: this test used to drive a
   * legacy account (the retired `account_type` value, renamed to
   * `legacy_safe` by #2912). #2413 filtered every account
   * list query to `delegator_hybrid`
   * (`infra/repositories/{user-safes,agents,dashboard}.ts`), so that payload
   * can no longer occur on the wire, and DashboardClient no longer reads
   * `account_type` at all — it is rail-blind by construction and leans on the
   * backend funnel (`delegationAccount` is just `accounts[0]`). There is no
   * defensive branch left for a legacy input to exercise, so keeping one
   * would pin an unreachable state; the test is converted to the worst case
   * that still exists: the same funded account, with pending approvals, on
   * the live rail. On `dev` before #2413 every assertion below failed, which
   * is what keeps this from guarding the empty set — put either affordance
   * back and it goes red here.
   */
  it('offers neither a Send affordance nor an approvals route, even for a funded account with pending approvals', () => {
    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        wallet_address: '0x5555555555555555555555555555555555555555',
        accounts: [SAFE],
      },
    })
    mockUseDashboardOverview.mockReturnValue({
      data: {
        totals: { usd: 1234.56, eur: 1100, sek: 13000.5 },
        change: {
          available: true,
          usdAmount: 12.34,
          eurAmount: 11,
          sekAmount: null,
          usdPercent: 1.23,
          eurPercent: 1,
          sekPercent: 0,
        },
      // #3807: the metrics block is gone with the KPI tiles.
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
    expect(screen.getByRole('button', { name: 'Deposit address' })).toBeInTheDocument()

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
        totals: { usd: 1234.56, eur: 1100, sek: 13000.5 },
        change: {
          available: true,
          usdAmount: 12.34,
          eurAmount: 11,
          sekAmount: null,
          usdPercent: 1.23,
          eurPercent: 1,
          sekPercent: 0,
        },
      // #3807: the metrics block is gone with the KPI tiles.
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

    expect(screen.getByRole('button', { name: 'Deposit address' })).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: 'Deposit address' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
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
    expect(screen.queryByText('Spending, last 30 days')).not.toBeInTheDocument()
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

  // ── The backup item lives in the NeedsYou card now (#3808) ────────────────
  // The RecoveryNudge component is deleted; its per-account rule reads the
  // overview's `needs_backup_recommendation` (#1205) through the shared rules
  // in `lib/dashboard-attention.ts`. Rule-level truth (per-account items,
  // testnet silence, unknown reads) is pinned there; these tests pin the
  // DASHBOARD WIRING — the legacy global dismissal key and the render path.
  describe('backup item wiring (#3808)', () => {
    const RECOMMENDED_ACCOUNT = {
      accountId: 'safe-1',
      chainId: 8453,
      isTestnet: false,
      usdcBalanceAtomic: '1250000000',
      usdcDecimals: 6,
      funded: true,
      needs_backup_recommendation: true,
      usdcPace7dAtomic: '6250000',
    }

    it('shows the backup item for a funded account the server recommends a backup for', () => {
      mockBaseState([], { accounts: [RECOMMENDED_ACCOUNT], spend: { failedIntents7d: 0 } })

      render(<DashboardClient />)

      expect(screen.getByText('Main account has one way to approve payments')).toBeInTheDocument()
    })

    it('never shows the backup item for a test-network account', () => {
      mockBaseState([], {
        accounts: [{ ...RECOMMENDED_ACCOUNT, accountId: 'acct-testnet', isTestnet: true }],
        spend: { failedIntents7d: 0 },
      })

      render(<DashboardClient />)

      expect(screen.queryByText(/has one way to approve payments/)).not.toBeInTheDocument()
    })

    it('hides the backup item when its id is in the server-saved dismissals (#3813)', () => {
      mockUseAttentionDismissals.mockReturnValue({
        dismissedIds: new Set([`no-backup:${RECOMMENDED_ACCOUNT.accountId}`]),
        dismiss: mockDismissOnServer,
      })
      mockBaseState([], { accounts: [RECOMMENDED_ACCOUNT], spend: { failedIntents7d: 0 } })

      render(<DashboardClient />)

      expect(screen.queryByText(/has one way to approve payments/)).not.toBeInTheDocument()
    })

    it('writes a server-saved dismissal through the hook when the backup item is dismissed', async () => {
      const user = userEvent.setup()
      mockBaseState([], { accounts: [RECOMMENDED_ACCOUNT], spend: { failedIntents7d: 0 } })

      render(<DashboardClient />)
      await user.click(screen.getByTestId(`attention-dismiss-no-backup:${RECOMMENDED_ACCOUNT.accountId}`))

      expect(mockDismissOnServer).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'no-backup', accountId: RECOMMENDED_ACCOUNT.accountId }),
      )
      // The legacy key is no longer written — the server owns persistence now.
      expect(window.localStorage.getItem('haven.recovery-nudge.dismissed')).toBeNull()
    })

    it('writes a needs-setup dismissal through the hook when a setup item is dismissed', async () => {
      const user = userEvent.setup()
      // An active agent with no usable budget raises "Needs setup"
      // (dashboard-attention rule 1) — the agent a user keeps without a
      // budget on purpose.
      const budgetlessAgent: DashboardAgentPreview = {
        id: 'agent-9',
        name: 'Kept agent',
        status: 'active',
        accountId: null,
        accountName: null,
        accountChainId: 8453,
        allowances: [],
        budgets: [],
        receivedSubBudgets: [],
        stats: {
          d7: {
            gross: { usd: 0, eur: 0, sek: 0 },
            net: { usd: 0, eur: 0, sek: 0 },
            approx: false,
            payments: 0,
            refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
          },
          d30: {
            gross: { usd: 0, eur: 0, sek: 0 },
            net: { usd: 0, eur: 0, sek: 0 },
            approx: false,
            payments: 0,
            refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
          },
          lastPaymentAt: null,
          lastCounterparty: null,
        },
      }
      mockBaseState([budgetlessAgent])

      render(<DashboardClient />)
      await user.click(screen.getByTestId('attention-dismiss-needs-setup:agent-9'))

      expect(mockDismissOnServer).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'needs-setup', agentId: 'agent-9' }),
      )
    })
  })

  describe('money panel (#3807)', () => {
    /** The full wire shape the panel's spending block and summary read. */
    const baseSpend = {
      scope: 'mainnet' as 'mainnet' | 'testnet',
      d7: {
        gross: { usd: 18.5, eur: 16.84, sek: 199.1 },
        net: { usd: 11.1, eur: 10.1, sek: 119.46 },
        approx: false,
        payments: 6,
        distinctMerchants: 3,
        budgetStops: 1,
      },
      d30: {
        gross: { usd: 74, eur: 67.34, sek: 796.4 },
        net: { usd: 48.1, eur: 43.77, sek: 517.66 },
        approx: true,
        payments: 21,
        distinctMerchants: 5,
        budgetStops: 3,
      },
      topMerchant7d: {
        key: 'research.example',
        x402ResourceUrl: 'https://research.example/report',
        to: '0x3333333333333333333333333333333333333333',
        merchantName: null,
      },
      failedIntents7d: 1,
      balance_by_day: Array.from({ length: 30 }, (_, i) => {
        // Real calendar days (Sep 10 + i, rolling into October) — a naive
        // string pad produces '2026-09-39' and the sparkline's Date.parse
        // goes NaN.
        const day = new Date(Date.UTC(2026, 8, 10 + i))
        return {
          snapshotDate: day.toISOString().slice(0, 10),
          totalUsd: 1200 + i,
          totalEur: 1100 + i,
          totalSek: null as number | null,
        }
      }),
    }

    function mockOverviewWithSpend(spend: typeof baseSpend) {
      mockUseDashboardOverview.mockReturnValue({
        data: {
          totals: { usd: 1234.56, eur: 1100, sek: 13000.5 },
          change: {
            available: true,
            usdAmount: 12.34,
            eurAmount: 11,
            sekAmount: null,
            usdPercent: 1.23,
            eurPercent: 1,
            sekPercent: 0,
          },
          actionableApprovals: 0,
          pendingApprovals: 0,
          onboardingProgress: { hasFirstAgentPayment: true },
          agents: [],
          transactions: [],
          spend,
        },
        loading: false,
        error: null,
        refetch: vi.fn(),
      })
    }

    it('renders the templated 7-day summary under the heading', () => {
      mockOverviewWithSpend(baseSpend)
      render(<DashboardClient />)

      // d7: the fixture has no agents, so the spread-out count form renders
      // off the totals — and the fixture's 1 budget stop rides along as its
      // own neutral sentence.
      expect(
        screen.getByText(
          'Agents spent $11.10 in the last 7 days. 1 payment attempt was stopped by a budget limit.',
        ),
      ).toBeInTheDocument()
    })

    it('labels a test-network-only overview "Test network"', () => {
      mockOverviewWithSpend({ ...baseSpend, scope: 'testnet' as const })
      render(<DashboardClient />)

      expect(screen.getByText('Test network')).toBeInTheDocument()
    })

    it('marks a re-priced 30-day total with ≈ and never presents it as booked', () => {
      mockOverviewWithSpend(baseSpend)
      render(<DashboardClient />)

      // d30.approx is true in the fixture, and the Amount primitive's
      // title carries the reason (owner decision 1). The title sits on the
      // inner ≈ mark; the figure is its sibling inside the Amount root, so
      // read the enclosing span's text.
      const marks = screen.getAllByTitle("Converted at today's rate")
      expect(marks.length).toBeGreaterThan(0)
      const amounts = marks.map((mark) => mark.parentElement?.textContent ?? '')
      expect(amounts.join(' ')).toContain('48.10')
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
