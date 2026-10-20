import { fireEvent, render, screen, within } from '@testing-library/react'
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
// #3902: per-test state — the "still loading" hand-off to the empty state is
// tested through the real component. Reset in beforeEach.
const mockBudgetRemainingState: { data: unknown; loading: boolean } = { data: null, loading: false }
vi.mock('@/hooks/useBudgetRemaining', () => ({
  useBudgetRemaining: () => ({ ...mockBudgetRemainingState, error: null, refetch: vi.fn() }),
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
  // #3818: the mock prints the inputs the dashboard derives, so the wiring
  // (USDC state, set-up agent, the named pending agent, hide) is assertable
  // here; the component's own rendering is tested in its suite.
  default: ({
    hasFirstAgentPayment,
    usdcFunded,
    hasSetUpAgent,
    pendingAgent,
  }: {
    hasFirstAgentPayment: boolean
    usdcFunded: boolean | null
    hasSetUpAgent: boolean
    pendingAgent?: { name: string; moreCount: number } | null
  }) => (
    <div>
      <span>Onboarding guide</span>
      <span>{hasFirstAgentPayment ? 'first-payment-complete' : 'first-payment-pending'}</span>
      <span>{`usdc-${String(usdcFunded)}`}</span>
      <span>{hasSetUpAgent ? 'agent-set-up' : 'agent-not-set-up'}</span>
      {pendingAgent ? <span>{`pending-${pendingAgent.name}-${pendingAgent.moreCount}`}</span> : null}
    </div>
  ),
  SetupCompleteLine: () => <span>Setup complete line</span>,
}))

vi.mock('@/components/ConnectAgentModal', () => ({
  default: () => null,
}))

// #4094: the picker mock prints its action and account count and offers a
// one-click pick, so the dashboard's ASK-FIRST wiring (multi-account) is
// assertable here without importing the real picker.
vi.mock('@/components/DashboardActionPickerModal', () => ({
  default: ({
    open,
    action,
    accounts,
    onSelect,
  }: {
    open: boolean
    action: 'receive' | 'send'
    accounts: { id: string; name: string }[]
    onSelect: (accountId: string) => void
  }) =>
    open ? (
      <div data-testid="action-picker">
        <span>{`picker-${action}-${accounts.length}`}</span>
        <button onClick={() => onSelect(accounts[0].id)}>Pick {accounts[0].name}</button>
      </div>
    ) : null,
}))

// The one Receive dialog (#4094): a marker, so the wiring tests can tell
// "opened for the chosen account" from "not mounted".
vi.mock('@/components/ReceiveDialog', () => ({
  default: ({ open, account }: { open: boolean; account: { name?: string } | null }) =>
    open ? <div data-testid="receive-dialog">{account?.name ?? ''}</div> : null,
}))

// The dashboard's Send is the delegation rail's owner-send (#4094): a marker
// carrying the account it would sign for, so the tests can pin WHICH account
// reaches the rail — and that none does without a resolved chain (#1844).
vi.mock('@/components/DelegationSendModal', () => ({
  default: ({ accountAddress, chainId }: { accountAddress?: string; chainId?: number }) => (
    <div data-testid="delegation-send-modal">{`${accountAddress ?? ''}|${chainId ?? ''}`}</div>
  ),
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
    mockBudgetRemainingState.data = null
    mockBudgetRemainingState.loading = false
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

  it('leads with the balance, the money panel, and its two actions', () => {
    // A user whose agents have paid: the spending block shows its figures
    // (before the first payment it explains itself instead, #3818).
    mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
    render(<DashboardClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    // #3807: the four KPI tiles are gone; the money panel renders the
    // templated 7-day summary and the 30-day spending block in their place.
    // #4094: the money card's actions are Send / Receive.
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    // #3902 (changed on purpose): the mockup's muted label, still the heading.
    expect(screen.getByRole('heading', { level: 2, name: 'Agent spending, last 30 days' })).toBeInTheDocument()
    expect(screen.getByText('Payments')).toBeInTheDocument()
    expect(screen.getByText('Merchants')).toBeInTheDocument()
    expect(screen.getByText('Stopped by budget')).toBeInTheDocument()
  })

  it('makes "Receive" the primary action, ahead of "Send" (#3897, #4094)', () => {
    mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
    render(<DashboardClient />)

    const balance = screen.getByRole('region', { name: 'Balance' })
    const actions = within(balance)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(actions).toEqual(['Receive', 'Send'])
    // Primary is the brand fill; the secondary is the ghost outline.
    expect(within(balance).getByRole('button', { name: 'Receive' }).className).toContain('bg-[var(--v2-brand)]')
    expect(within(balance).getByRole('button', { name: 'Send' }).className).not.toContain(
      'bg-[var(--v2-brand)]',
    )
  })

  it('renders "Needs attention" below the money card at full width, never in a side column (#3897, #3902)', () => {
    mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
    const { container } = render(<DashboardClient />)

    const balance = screen.getByRole('region', { name: 'Balance' })
    const needsYou = screen.getByRole('article')
    // DOM order: the money card, then "Needs attention", then the agents/activity grid.
    expect(balance.compareDocumentPosition(needsYou) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The old hero-plus-aside row is gone, and "Needs attention" sits in the page's
    // single column — its parent lays children out vertically, not in a grid.
    expect(container.innerHTML).not.toContain('minmax(320px,0.42fr)')
    expect(needsYou.parentElement?.className).toContain('space-y-6')
    expect(needsYou.parentElement?.className).not.toMatch(/grid-cols/)
    // Balance and spending share ONE raised card (#3897), spending a divided section.
    const card = balance.closest('.shadow-card-raised')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByRole('region', { name: 'Spending' })).toBeInTheDocument()
    expect(screen.queryByText('Total balance')).toBeNull()
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
      expect(screen.getByText('+130,00 kr (+1,00 %) since yesterday (UTC)')).toBeInTheDocument()
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
      // #3897: no filler caption takes the change line's place.
      expect(within(screen.getByRole('region', { name: 'Balance' })).getByText('13 000,50 kr')).toBeInTheDocument()
    })

    it('keeps the USD hero for a USD preference', () => {
      render(<DashboardClient />)

      expect(screen.getByText('$1,234.56')).toBeInTheDocument()
      expect(screen.queryByText(/kr/)).toBeNull()
    })
  })

  /**
   * #1989 (epic #1440) → #4094: the dashboard's LEGACY-Safe spend/approval
   * affordances are GONE — the old hero Send opened `SendModal`, which is
   * deleted with the rail, and the "Needs attention" approvals row with its
   * "Open approvals" link (`/approvals` no longer routes and
   * `POST /approvals/:id/approve` answers 410 since #1986).
   *
   * #4094 REWRITES the Send half rather than deleting it: Send is back on the
   * money card as the DELEGATION rail's owner-send (`DelegationSendModal`),
   * so the assertion flips from absence to PRESENCE — while the retired-rail
   * absences from #1987 keep their teeth below, on the same funded fixture
   * that used to guard them.
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
   * the live rail. On `dev` before #2413 every absence below failed, which
   * is what keeps this from guarding the empty set — put either retired
   * affordance back and it goes red here.
   */
  it('offers the delegation Send but neither an approvals row nor an approvals route, even for a funded account with pending approvals', () => {
    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        wallet_address: '0x5555555555555555555555555555555555555555555',
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
    // Without this the absences below would all be satisfied by a blank
    // screen — the failure mode #1987 paid for.
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()

    // #4094: the money card's Send is the delegation rail's owner-send —
    // PRESENT, where the pre-#4094 guard asserted the legacy Send's absence.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()

    // …and the retired-rail absences (#1987) still hold.
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

  // #3818: a finished setup — USDC on the account, an agent with a budget,
  // the first payment made.
  const FUNDED_ACCOUNT = {
    accountId: 'safe-1',
    chainId: 8453,
    isTestnet: false,
    usdcBalanceAtomic: '5000000',
    usdcDecimals: 6,
    funded: true,
    needs_backup_recommendation: false,
    usdcPace7dAtomic: '0',
  }
  function setUpAgentPreview(): DashboardAgentPreview {
    return {
      id: 'agent-1',
      name: 'Research agent',
      status: 'active',
      accountId: null,
      accountName: null,
      accountChainId: 8453,
      allowances: [],
      budgets: [{ id: 'budget-1' }] as never,
      receivedSubBudgets: [],
      stats: {
        d7: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, refusals: { budget: 0, scope: 0, failed: 0, haven: 0 } },
        d30: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, refusals: { budget: 0, scope: 0, failed: 0, haven: 0 } },
        lastPaymentAt: null,
        lastCounterparty: null,
      },
    }
  }
  /** A `pending_approval` agent (no budget): waits for setup, never completes step 2. */
  function pendingPreview(id: string, name: string): DashboardAgentPreview {
    return {
      ...setUpAgentPreview(),
      id,
      name,
      status: 'pending_approval',
      budgets: [],
    }
  }
  function mockCompletedSetup() {
    mockBaseState([setUpAgentPreview()], {
      accounts: [FUNDED_ACCOUNT],
      onboardingProgress: { hasFirstAgentPayment: true },
    })
  }

  it('holds the empty card back while budget reads load, then shows the achievement once they are known (#3902)', () => {
    // Every fact holds except that the budget read has not settled yet.
    window.localStorage.setItem('haven-onboarding-complete-dismissed:user-1', '1')
    mockCompletedSetup()
    mockBudgetRemainingState.loading = true
    const first = render(<DashboardClient />)
    expect(screen.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeInTheDocument()
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument()
    expect(screen.queryByText('No items to review right now.')).not.toBeInTheDocument()
    first.unmount()

    // Positive control: the same data once the read settles at 10% used.
    mockBudgetRemainingState.loading = false
    mockBudgetRemainingState.data = {
      budgets: [{
        agent_id: 'agent-1', chain_id: 8453, delegation_hash: '0xhash', token_address: '0xtoken',
        token_symbol: 'USDC', token_decimals: 6, budget_atomic: '10000000', used_atomic: '1000000',
        read_at: '2026-10-09T00:00:00Z', period_end: '2026-10-16T00:00:00Z',
        remaining_atomic: '9000000', remaining_from_chain: true, sub_budget_spend: [],
      }],
    }
    render(<DashboardClient />)
    expect(screen.getByRole('heading', { level: 3, name: "You're all caught up" })).toBeInTheDocument()
  })

  it('shows one "You\'re set up" line, not the steps, once all three are done', () => {
    mockCompletedSetup()
    render(<DashboardClient />)
    expect(screen.getByText('Setup complete line')).toBeInTheDocument()
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('does not flash the guide for completed setup after the completion banner was dismissed', () => {
    // The pre-#3818 banner's key is read as is: an owner who dismissed the
    // old banner does not see the new line either.
    window.localStorage.setItem('haven-onboarding-complete-dismissed:user-1', '1')
    mockCompletedSetup()
    render(<DashboardClient />)
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
    expect(screen.queryByText('Setup complete line')).not.toBeInTheDocument()
  })

  it('does not show the guide before first-payment progress is known', () => {
    // The overview arrived but without onboarding progress (an old cached
    // shape): the gate, not a missing card, keeps the guide out.
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, funded: false, usdcBalanceAtomic: '0' }], onboardingProgress: undefined })
    render(<DashboardClient />)
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument()
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('after the first agent payment the steps never return — a regression is the rules\' job (#3818 review)', () => {
    // A veteran whose USDC read is unavailable, whose budget expired, who
    // has paid before: before this rule they got "Get started" again.
    mockBaseState([], {
      accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: null, funded: null }],
      onboardingProgress: { hasFirstAgentPayment: true },
    })
    render(<DashboardClient />)
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
    expect(screen.getByText('Setup complete line')).toBeInTheDocument()
  })

  it('a balance-read error mid-setup does not collapse the page into the focused view (#3818 review)', () => {
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: null, funded: null }] })
    mockUseAggregatedBalances.mockReturnValue({ balances: [], loading: false, error: 'boom', refetch: vi.fn() })
    render(<DashboardClient />)
    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    // The full layout keeps the activity section.
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument()
  })

  it('before the first agent payment the spending block says what will appear there, not three zeros (#3818)', () => {
    mockBaseState([], { accounts: [FUNDED_ACCOUNT] })
    render(<DashboardClient />)
    expect(screen.getByText(/After your agents’ first payment, this shows what they spent/)).toBeInTheDocument()
    expect(screen.queryByText('Stopped by budget')).not.toBeInTheDocument()
  })

  it('a revoked agent with a budget does not complete step 2 — GET /agents lists it, the overview does not', () => {
    // The original bug: step 2 completed on `agents.length > 0`, and GET
    // /agents returns every status.
    mockBaseState([], { accounts: [FUNDED_ACCOUNT] })
    mockUseAgents.mockReturnValue({
      agents: [{ id: 'agent-r', name: 'Gone', status: 'revoked', allowances: [{ id: 'x' }], created_at: '2026-10-01T00:00:00Z' }],
      loading: false,
      refetch: vi.fn(),
    })
    render(<DashboardClient />)
    expect(screen.getByText('agent-not-set-up')).toBeInTheDocument()
  })

  it('keeps the guide visible when the USDC read is unavailable — step 1 unknown, never "unfunded" (#3818)', () => {
    // Before #3818 a balance-read error hid the guide entirely.
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: null, funded: null }] })
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: false,
      error: 'Failed to load balances',
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    expect(screen.getByText('usdc-null')).toBeInTheDocument()
    // The money card's own actions are unaffected.
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('ETH or other-token dust does not complete step 1 — only USDC on the account does (#3818)', () => {
    // The aggregate read shows a balance (ETH); the account's own USDC is zero.
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }] })
    render(<DashboardClient />)
    expect(screen.getByText('usdc-false')).toBeInTheDocument()
  })

  it('a pending_approval agent leaves step 2 open and is named, not listed twice (#3818)', () => {
    const pending = (id: string, name: string): DashboardAgentPreview => ({
      ...setUpAgentPreview(),
      id,
      name,
      status: 'pending_approval',
      budgets: [],
    })
    mockBaseState([pending('agent-a', 'Alpha'), pending('agent-b', 'Beta')], {
      accounts: [FUNDED_ACCOUNT],
    })
    mockUseAgents.mockReturnValue({
      agents: [
        { id: 'agent-a', name: 'Alpha', created_at: '2026-10-01T00:00:00Z' },
        { id: 'agent-b', name: 'Beta', created_at: '2026-10-08T00:00:00Z' },
      ],
      loading: false,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('agent-not-set-up')).toBeInTheDocument()
    // The newest waiting agent is the one step 2 names…
    expect(screen.getByText('pending-Beta-1')).toBeInTheDocument()
    // …so its "Needs setup" row is not repeated; the other agent keeps its row.
    expect(screen.queryByText('Beta is waiting to be set up')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha is waiting to be set up')).toBeInTheDocument()
  })

  it('a completed step 2 names nobody; the waiting agent keeps its row — funded (#3976)', () => {
    // One set-up agent (completes step 2) plus one pending_approval agent:
    // the ticked step 2 used to read "Finish setting up Sdf" while the de-dup
    // filter dropped the agent's only other mention. Now the guide names
    // nobody and the row renders again.
    mockBaseState([setUpAgentPreview(), pendingPreview('agent-sdf', 'Sdf')], {
      accounts: [FUNDED_ACCOUNT],
    })
    mockUseAgents.mockReturnValue({
      agents: [
        { id: 'agent-1', name: 'Research agent', created_at: '2026-10-01T00:00:00Z' },
        { id: 'agent-sdf', name: 'Sdf', created_at: '2026-10-08T00:00:00Z' },
      ],
      loading: false,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    // Step 2 is complete — the guide names no pending agent…
    expect(screen.getByText('agent-set-up')).toBeInTheDocument()
    expect(screen.queryByText('pending-Sdf-0')).not.toBeInTheDocument()
    // …and the agent's own row is back (not swallowed by the de-dup filter).
    expect(screen.getByText('Sdf is waiting to be set up')).toBeInTheDocument()
  })

  it('a completed step 2 names nobody; the waiting agent keeps its row — unfunded focused view (#3976)', () => {
    // The issue's measured case: an unfunded account renders the focused
    // view, where the Agents card is held back — so before the fix the wrong
    // "Finish setting up Sdf" title was the ONLY place the pending agent
    // appeared at all.
    mockBaseState([setUpAgentPreview(), pendingPreview('agent-sdf', 'Sdf')], {
      accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }],
    })
    mockUseAgents.mockReturnValue({
      agents: [
        { id: 'agent-1', name: 'Research agent', created_at: '2026-10-01T00:00:00Z' },
        { id: 'agent-sdf', name: 'Sdf', created_at: '2026-10-08T00:00:00Z' },
      ],
      loading: false,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    // Step 2 is complete and names nobody in the focused view…
    expect(screen.getByText('agent-set-up')).toBeInTheDocument()
    expect(screen.queryByText('pending-Sdf-0')).not.toBeInTheDocument()
    // …so the row below the steps is where the agent is named.
    expect(screen.getByText('Sdf is waiting to be set up')).toBeInTheDocument()
  })

  it('shows a focused first-run guide instead of the full dashboard when the account needs funds', () => {
    // #3818: focused only when the account is KNOWN to hold no USDC.
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }] })
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    // The agents and activity sections wait until the account is funded.
    expect(screen.queryByRole('heading', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Activity' })).not.toBeInTheDocument()
    // #3897 (changed on purpose, the mockup's new-user card): the spending
    // half stays, explaining what it will show — never zero tiles.
    const spending = screen.getByRole('region', { name: 'Spending' })
    expect(within(spending).getByText(/After your agents’ first payment/)).toBeInTheDocument()
    expect(within(spending).queryByText('Payments')).not.toBeInTheDocument()
  })

  it('shows exactly one primary money action while step 1 is the active step: the money card\'s "Receive" steps back (#3902, #4094)', () => {
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }] })
    render(<DashboardClient />)
    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    // Step 1's own "Add funds" is the guide's primary (DashboardOnboardingGuide.test);
    // the money card's "Receive" renders ghost beside it.
    const balance = screen.getByRole('region', { name: 'Balance' })
    const receive = within(balance).getByRole('button', { name: 'Receive' })
    expect(receive.className).not.toContain('bg-[var(--v2-brand)]')
    expect(receive.className).toContain('border-[var(--v2-border-strong)]')
  })

  it('makes the money card\'s "Receive" primary again once step 1 is done or the guide is hidden (#3902, #4094)', () => {
    // Funded: step 1 is done, so the guide (still showing) no longer asks for funds.
    mockBaseState([], { accounts: [FUNDED_ACCOUNT] })
    const funded = render(<DashboardClient />)
    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Balance' })).getByRole('button', { name: 'Receive' }).className,
    ).toContain('bg-[var(--v2-brand)]')
    funded.unmount()

    // Unfunded but the guide hidden: the money card's button is the only one.
    window.localStorage.setItem('haven-setup-guide-hidden:user-1', '0')
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }] })
    render(<DashboardClient />)
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Balance' })).getByRole('button', { name: 'Receive' }).className,
    ).toContain('bg-[var(--v2-brand)]')
  })

  /**
   * #4094: the money card's Send / Receive wiring — which dialog each verb
   * opens, and through which path. Single vs multi-account is the axis:
   * with ONE account both verbs open their dialog directly (the picker is a
   * multi-account affordance only, per the issue's dialog spec); with TWO
   * the account is asked for first, and the chosen account is the one the
   * dialog serves.
   *
   * The dialogs are mocked with markers (see the mock block): the picker
   * prints its action and account count, the Receive dialog its account
   * name, and the delegation send the account it would sign for.
   */
  describe('money card Send / Receive wiring (#4094)', () => {
    it('with one account, Receive opens the Receive dialog for that account directly — no picker', () => {
      mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
      render(<DashboardClient />)

      fireEvent.click(screen.getByRole('button', { name: 'Receive' }))

      expect(screen.getByTestId('receive-dialog')).toBeInTheDocument()
      expect(screen.getByTestId('receive-dialog')).toHaveTextContent('Main account')
      // Single account: the picker never enters it.
      expect(screen.queryByTestId('action-picker')).not.toBeInTheDocument()
    })

    it('with one account, Send opens the delegation rail for that account directly — no picker', () => {
      mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
      render(<DashboardClient />)

      fireEvent.click(screen.getByRole('button', { name: 'Send' }))

      const send = screen.getByTestId('delegation-send-modal')
      expect(send).toBeInTheDocument()
      expect(send).toHaveTextContent(`${SAFE.account_address}|${SAFE.chain_id}`)
      expect(screen.queryByTestId('action-picker')).not.toBeInTheDocument()
    })

    it('with more than one account, Receive asks through the picker, then serves the chosen account', () => {
      mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
      const SECOND = { ...SAFE, id: 'safe-2', name: 'Second account', account_address: '0x2222222222222222222222222222222222222222', chain_id: 84532, is_default: false }
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', name: 'Ada', email: 'ada@example.com', wallet_address: '0x5555555555555555555555555555555555555555', accounts: [SAFE, SECOND] },
      })
      render(<DashboardClient />)

      fireEvent.click(screen.getByRole('button', { name: 'Receive' }))

      // The picker asks first; neither dialog is open yet.
      const picker = screen.getByTestId('action-picker')
      expect(picker).toHaveTextContent('picker-receive-2')
      expect(screen.queryByTestId('receive-dialog')).not.toBeInTheDocument()

      fireEvent.click(within(picker).getByRole('button', { name: 'Pick Main account' }))

      expect(screen.queryByTestId('action-picker')).not.toBeInTheDocument()
      expect(screen.getByTestId('receive-dialog')).toHaveTextContent('Main account')
    })

    it('with more than one account, Send asks through the picker, then opens the delegation rail for the chosen account', () => {
      mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
      const SECOND = { ...SAFE, id: 'safe-2', name: 'Second account', account_address: '0x2222222222222222222222222222222222222222', chain_id: 84532, is_default: false }
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', name: 'Ada', email: 'ada@example.com', wallet_address: '0x555555555555555555555555555555555555555555555555555555555555555555555', accounts: [SAFE, SECOND] },
      })
      render(<DashboardClient />)

      fireEvent.click(screen.getByRole('button', { name: 'Send' }))

      const picker = screen.getByTestId('action-picker')
      expect(picker).toHaveTextContent('picker-send-2')
      expect(screen.queryByTestId('delegation-send-modal')).not.toBeInTheDocument()

      fireEvent.click(within(picker).getByRole('button', { name: 'Pick Main account' }))

      expect(screen.queryByTestId('action-picker')).not.toBeInTheDocument()
      const send = screen.getByTestId('delegation-send-modal')
      expect(send).toHaveTextContent(`${SAFE.account_address}|${SAFE.chain_id}`)
    })

    it('mounts no Send modal for an account without a resolved chain (#1844)', () => {
      // A chain the wire cannot name is never defaulted into a signing
      // surface: the delegation rail mounts only for an account with BOTH
      // an address and a chain — the same #1844 rule the Receive dialog
      // renders its refusal under.
      mockBaseState([], { onboardingProgress: { hasFirstAgentPayment: true } })
      mockUseAuth.mockReturnValue({
        user: {
          id: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          wallet_address: '0x5555555555555555555555555555555555555555555',
          accounts: [{ ...SAFE, chain_id: undefined as unknown as number }],
        },
      })
      render(<DashboardClient />)

      fireEvent.click(screen.getByRole('button', { name: 'Send' }))

      expect(screen.queryByTestId('delegation-send-modal')).not.toBeInTheDocument()
      // The Send button itself still renders — hidden, not disabled (#1079)
      // never applied here: nothing dead-ends, the account is simply not
      // signable until its chain resolves.
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    })
  })

  it('puts "Hide for now" and the progress in the card header, beside "Get started" (#3897)', () => {
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }] })
    render(<DashboardClient />)
    const heading = screen.getByRole('heading', { name: 'Get started' })
    // The progress sits beside the title; the header row holds both.
    expect(within(heading.parentElement as HTMLElement).getByText('0 of 3 done')).toBeInTheDocument()
    const header = (heading.parentElement as HTMLElement).parentElement as HTMLElement
    expect(within(header).getByRole('button', { name: 'Hide for now' })).toBeInTheDocument()
    expect(within(header).getByText('0 of 3 done')).toBeInTheDocument()
  })

  it('moves focus to the card heading after "Hide for now" — the button unmounts itself (#3910)', async () => {
    const user = userEvent.setup()
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }] })
    render(<DashboardClient />)
    await user.click(screen.getByRole('button', { name: 'Hide for now' }))
    // The hand-off runs in a requestAnimationFrame; flush it.
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)))
    const heading = document.getElementById('needs-attention-heading')
    expect(heading).not.toBeNull()
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toBe(heading)
  })

  it('"Hide for now" survives a reload and comes back when a step completes (#3818)', async () => {
    const user = userEvent.setup()
    mockBaseState([], { accounts: [{ ...FUNDED_ACCOUNT, usdcBalanceAtomic: '0', funded: false }] })
    const first = render(<DashboardClient />)
    await user.click(screen.getByRole('button', { name: 'Hide for now' }))
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
    first.unmount()

    // A reload: still hidden — it was session-only before #3818.
    const second = render(<DashboardClient />)
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
    second.unmount()

    // USDC arrives: step 1 completes, so the guide comes back.
    mockBaseState([], { accounts: [FUNDED_ACCOUNT] })
    render(<DashboardClient />)
    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    expect(screen.getByText('usdc-true')).toBeInTheDocument()
  })

  it('does not wait on GET /agents — the overview carries the agents, so a refetch never flips the card (#3818)', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: true,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
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
      // #3818: with the first-run steps showing, the agent step 2 names has
      // no row of its own; this test is about the card's dismissal wiring, so
      // the steps are hidden ("Hide for now" at 0 completed steps).
      window.localStorage.setItem('haven-setup-guide-hidden:user-1', '0')
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

    it('a re-priced USDC total in USD carries no ≈ — USDC is dollars (#4165)', () => {
      mockOverviewWithSpend({
        ...baseSpend,
        d30: { ...baseSpend.d30, approxByCurrency: { usd: false, eur: true, sek: true } },
      })
      render(<DashboardClient />)

      // The server's per-currency decision says the USD figure is exact.
      expect(screen.queryByTitle("Converted at today's rate")).not.toBeInTheDocument()
    })

    it('marks a re-priced 30-day total with ≈ in SEK and never presents it as booked', () => {
      mockUsePreferences.mockReturnValue({ currency: 'SEK' })
      mockOverviewWithSpend({
        ...baseSpend,
        d30: { ...baseSpend.d30, approxByCurrency: { usd: false, eur: true, sek: true } },
      })
      render(<DashboardClient />)

      // `approxByCurrency.sek` is true in the fixture, and the Amount
      // primitive's title carries the reason (owner decision 1). The title
      // sits on the inner ≈ mark; the figure is its sibling inside the Amount
      // root, so read the enclosing span's text.
      const marks = screen.getAllByTitle("Converted at today's rate")
      expect(marks.length).toBeGreaterThan(0)
      const amounts = marks.map((mark) => (mark.parentElement?.textContent ?? '').replace(/\u00a0/g, ' '))
      expect(amounts.join(' ')).toContain('517,66')
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
