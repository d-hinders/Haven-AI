/**
 * #4097 — the account page as the full record of one account: header (badges
 * in `meta`, Send/Receive primacy), the three-column summary card (Balance /
 * Holdings / Last 30 days), the tab row (?tab= owned here), the Agents tab
 * (active agents, hidden revoked count), and the Security & details tab
 * (AccountSignersCard + Account details). The removals are asserted too: no
 * off-ramp panel, no "Agent access" card, no "Token balances" table, no
 * "Advanced account details", no transactions table (deleted with #4266).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const mockUseAuth = vi.fn()
const mockUseAccounts = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()
const mockUsePortfolio = vi.fn()
const mockUseBalances = vi.fn()
const mockUseTransactionsFeed = vi.fn()
const mockUseDashboardOverview = vi.fn()
const mockUseBudgetRemaining = vi.fn()
const mockUseAttentionDismissals = vi.fn()
const mockUseAccountSigners = vi.fn()
const mockUseAccountMoneyFlow = vi.fn()

const mockRouterPush = vi.fn()
const mockRouterReplace = vi.fn()

/** The ?tab= value useSearchParams hands the page; set per test. */
let tabParam: string | null = null

vi.mock('next/navigation', () => ({
  useParams: () => ({ accountId: 'safe-1' }),
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
  useSearchParams: () => new URLSearchParams(tabParam ? { tab: tabParam } : {}),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => mockUseAccounts(),
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

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: () => mockUsePortfolio(),
}))

vi.mock('@/hooks/useBalances', () => ({
  useBalances: () => mockUseBalances(),
}))

vi.mock('@/hooks/useTransactionsFeed', () => ({
  useTransactionsFeed: () => mockUseTransactionsFeed(),
}))

vi.mock('@/hooks/useDashboardOverview', () => ({
  useDashboardOverview: () => mockUseDashboardOverview(),
}))

vi.mock('@/hooks/useBudgetRemaining', () => ({
  useBudgetRemaining: () => mockUseBudgetRemaining(),
}))

vi.mock('@/hooks/useAttentionDismissals', () => ({
  useAttentionDismissals: () => mockUseAttentionDismissals(),
}))

vi.mock('@/hooks/useAccountSigners', () => ({
  useAccountSigners: () => mockUseAccountSigners(),
}))

vi.mock('@/hooks/useAccountMoneyFlow', () => ({
  useAccountMoneyFlow: () => mockUseAccountMoneyFlow(),
}))

// The Activity tab is its own component with its own suite
// (AccountActivityTab.test.tsx). The shell tests stub it and assert only the
// shell's side: it mounts on the active tab and the page keeps no feed of
// its own.
vi.mock('../AccountActivityTab', () => ({
  default: () => <div data-testid="account-activity-tab" />,
}))

vi.mock('@/components/ReceiveDialog', () => ({
  default: () => null,
}))

vi.mock('@/components/DelegationSendModal', () => ({
  default: () => null,
}))

vi.mock('@/components/transactions/TransactionDetailPanel', () => ({
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
  default: (props: { accountAddress?: string }) => (
    <div data-testid="account-signers-card" data-safe-address={props.accountAddress}>
      Who can approve
    </div>
  ),
}))

import AccountDetailClient from '../AccountDetailClient'
import { ApiRequestError } from '@/lib/api'
import type { DashboardOverviewResponse } from '@/types/dashboard'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
  account_type: 'delegator_hybrid' as const,
}

/** A zeroed dashboard overview with `agents` and `agentCount` overridable. */
function overview(
  overrides: Partial<Pick<DashboardOverviewResponse, 'agents' | 'agentCount'>> = {},
): DashboardOverviewResponse {
  const zeroWindow = {
    gross: { usd: 0, eur: 0, sek: 0 },
    net: { usd: 0, eur: 0, sek: 0 },
    approx: false,
    payments: 0,
    distinctMerchants: 0,
    budgetStops: 0,
  }
  return {
    totals: { usd: 0, eur: 0 },
    change: { available: false, usdAmount: 0, eurAmount: 0, usdPercent: 0, eurPercent: 0 },
    actionableApprovals: 0,
    pendingApprovals: 0,
    onboardingProgress: { hasFirstAgentPayment: false },
    agents: [],
    agentCount: { active: 0, paused: 0, pending_approval: 0 },
    accounts: [],
    spend: {
      scope: 'mainnet',
      d7: { ...zeroWindow, refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 } },
      d30: { ...zeroWindow, refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 } },
      topMerchant7d: null,
      failedIntents7d: 0,
      balance_by_day: [],
    },
    spotRates: {},
    ...overrides,
  } as DashboardOverviewResponse
}

describe('AccountDetailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tabParam = null

    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        wallet_address: '0x5555555555555555555555555555555555555555',
        accounts: [SAFE],
      },
      loading: false,
      passkeys: [],
    })
    mockUseAccounts.mockReturnValue({
      renameAccount: vi.fn(),
      removeAccount: vi.fn(),
      setDefault: vi.fn(),
      loading: false,
    })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseContacts.mockReturnValue({
      contacts: [],
      error: null,
      resolveAddress: vi.fn(),
    })
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockUsePortfolio.mockReturnValue({
      totalUsd: 42,
      totalEur: 39,
      breakdown: [
        { symbol: 'USDC', balance: '42000000', formatted: '42.00', usdValue: 42, eurValue: 39, sekValue: 400 },
      ],
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
      loadingMore: false,
      error: null,
      total: 0,
      hasMore: false,
      truncated: false,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })
    mockUseDashboardOverview.mockReturnValue({
      data: overview(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockUseBudgetRemaining.mockReturnValue({ data: null, loading: false })
    mockUseAttentionDismissals.mockReturnValue({ acknowledgements: new Map(), dismiss: vi.fn() })
    mockUseAccountSigners.mockReturnValue({
      signers: { account_address: SAFE.account_address, passkeys: [{ key_id: 'k1', created_at: '2026-05-12T00:00:00Z' }], owner_address: null },
      loadError: false,
      busy: false,
      ready: true,
      passkeyElsewhere: false,
      enrollBackupPasskey: vi.fn(),
      enrollOwnerWallet: vi.fn(),
      removePasskey: vi.fn(),
      removeOwner: vi.fn(),
      reload: vi.fn(),
    })
    mockUseAccountMoneyFlow.mockReturnValue({
      moneyIn: 120,
      moneyOut: 45,
      approxIn: false,
      approxOut: false,
      unpriced: false,
      loading: false,
      error: null,
      partial: false,
      refresh: vi.fn(),
    })
  })

  afterEach(() => {
    tabParam = null
  })

  // #4028 — the way back to the accounts list exists in every state of the
  // page, now that the top bar no longer supplies it.
  describe('back link to the accounts list (#4028)', () => {
    function expectBackToAccounts() {
      const link = screen.getByRole('link', { name: 'Accounts' })
      expect(link.getAttribute('href')).toBe('/accounts')
    }

    it('renders above the title in the loaded page', () => {
      render(<AccountDetailClient />)
      expectBackToAccounts()
      const title = screen.getByRole('heading', { level: 1, name: 'Main account' })
      expect(
        screen.getByRole('link', { name: 'Accounts' }).compareDocumentPosition(title) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it('renders while auth is still loading, outside the live region', () => {
      mockUseAuth.mockReturnValue({ ...mockUseAuth(), user: null, loading: true })
      render(<AccountDetailClient />)
      expectBackToAccounts()
      const status = screen.getByRole('status', { name: 'Loading account' })
      expect(status.contains(screen.getByRole('link', { name: 'Accounts' }))).toBe(false)
    })

    it('renders when the account is not found', () => {
      mockUseAuth.mockReturnValue({ ...mockUseAuth(), user: { ...mockUseAuth().user, accounts: [] } })
      render(<AccountDetailClient />)
      expect(screen.getByText('Account not found')).toBeInTheDocument()
      expectBackToAccounts()
    })
  })

  it('renders header, summary card, and tabs, and no other cards', () => {
    render(<AccountDetailClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Main account' })).toBeInTheDocument()
    // The summary card's three columns.
    expect(screen.getByText('$42.00')).toBeInTheDocument()
    expect(screen.getByText('Holdings')).toBeInTheDocument()
    expect(screen.getByText('Last 30 days')).toBeInTheDocument()
    expect(screen.getByText('Money in')).toBeInTheDocument()
    expect(screen.getByText('Money out')).toBeInTheDocument()
    // The tab row.
    expect(screen.getByRole('tab', { name: /Activity/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Agents/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Security & details/ })).toBeInTheDocument()
    // #4097 removals: none of the old cards render.
    expect(screen.queryByText('Agent access')).not.toBeInTheDocument()
    expect(screen.queryByText('Token balances')).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced account details')).not.toBeInTheDocument()
    expect(screen.queryByText('Transaction history')).not.toBeInTheDocument()
    expect(screen.queryByText('Receiving USDC')).not.toBeInTheDocument()
  })

  describe('the summary card to mockup v9 (#4166)', () => {
    it('Holdings renders a header row — column label left, "Amount" label right — and right-aligned amounts', () => {
      render(<AccountDetailClient />)
      // The header row: "Holdings" and the small "Amount" column label share
      // one justified row — "Amount" is no longer a second line under the
      // title.
      const section = screen.getByRole('region', { name: 'Holdings' })
      const headerRow = within(section).getByText('Holdings').closest('div')
      expect(headerRow).toHaveClass('justify-between')
      expect(within(headerRow as HTMLElement).getByText('Amount')).toBeInTheDocument()
      // The token amount is its own right-aligned cell in a justified row —
      // not inline text after the symbol ("USDC 8.225255", the old shape).
      // #4197: it renders at most 4 decimals (string truncation) and carries
      // the served amount in its title. #4307: the cell is tabular SANS —
      // `font-mono` is gone (it set the freshness marker too, beside
      // proportional fiat).
      const amount = within(section).getByText('42.00')
      expect(amount).toHaveAttribute('title', '42.00')
      expect(amount.parentElement).not.toHaveClass('font-mono')
      expect(amount.parentElement).toHaveClass('v2-tabular')
      const row = amount.closest('div')
      expect(row).toHaveClass('justify-between')
      expect(within(row as HTMLElement).getByText('USDC')).toBeInTheDocument()
    })

    it('the header lists Send, then Receive (#4307 owner decision a)', () => {
      render(<AccountDetailClient />)
      // DOM order, not styling: Send precedes Receive everywhere.
      const send = screen.getByRole('button', { name: 'Send' })
      const receive = screen.getByRole('button', { name: 'Receive' })
      expect(
        send.compareDocumentPosition(receive) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it('Money in and Money out sit on ONE row beside their direction icons (#4197)', () => {
      render(<AccountDetailClient />)
      const section = screen.getByRole('region', { name: 'Last 30 days' })
      // The two pairs share a single wrapping row — #4166's two-column grid
      // and its label row are gone. The sr-only name's PARENT is its pair.
      const inPair = within(section).getByText('Money in').parentElement
      const outPair = within(section).getByText('Money out').parentElement
      expect(inPair).not.toBeNull()
      expect(outPair).not.toBeNull()
      expect(inPair!.parentElement).toBe(outPair!.parentElement)
      expect(inPair!.parentElement).toHaveClass('flex-wrap')
    })

    describe('the summary card follow-up (#4197)', () => {
      it('each Last 30 days figure is named by sr-only text before the amount, beside a VISIBLE arrow', () => {
        render(<AccountDetailClient />)
        const section = screen.getByRole('region', { name: 'Last 30 days' })
        // The name is sr-only text — asserting `getByText('Money in')` alone
        // would pass on it without proving anything is visible.
        const inName = within(section).getByText('Money in')
        expect(inName).toHaveClass('sr-only')
        const outName = within(section).getByText('Money out')
        expect(outName).toHaveClass('sr-only')
        // The visible affordance is the inline direction mark itself.
        const inArrow = section.querySelector('svg.lucide-arrow-down')
        const outArrow = section.querySelector('svg.lucide-arrow-up')
        expect(inArrow).toBeVisible()
        expect(outArrow).toBeVisible()
        // The figures follow the "≈" rule unchanged, one per direction.
        const inPair = inName.parentElement
        const outPair = outName.parentElement
        expect(within(inPair as HTMLElement).getByText('$120.00')).toBeInTheDocument()
        expect(within(outPair as HTMLElement).getByText('$45.00')).toBeInTheDocument()
      })

      it('the arrow icon carries the tooltip; Amount is not wrapped in one', () => {
        render(<AccountDetailClient />)
        const section = screen.getByRole('region', { name: 'Last 30 days' })
        // The trigger is the tooltip wrapper around the mark — focusable, per
        // the accepted tab stops.
        const inTrigger = section.querySelector('svg.lucide-arrow-down')!.closest('span[tabindex="0"]')
        expect(inTrigger).not.toBeNull()
        fireEvent.mouseEnter(inTrigger as Element)
        expect(screen.getByRole('tooltip')).toHaveTextContent('Money in')
        fireEvent.mouseLeave(inTrigger as Element)
        const outTrigger = section.querySelector('svg.lucide-arrow-up')!.closest('span[tabindex="0"]')
        expect(outTrigger).not.toBeNull()
        fireEvent.mouseEnter(outTrigger as Element)
        expect(screen.getByRole('tooltip')).toHaveTextContent('Money out')
        // The figures carry no second tooltip: `Amount`'s own "≈" title would
        // stack with the icon's. The pair spans hold no title.
        const inPair = within(section).getByText('Money in').closest('span')
        expect(inPair).not.toHaveAttribute('title')
      })

      it('Holdings renders at most 4 decimals, rounded down, with the served amount in the tooltip', () => {
        mockUsePortfolio.mockReturnValue({
          totalUsd: 8.23,
          totalEur: 7.6,
          totalSek: 80,
          breakdown: [
            {
              symbol: 'USDC',
              balance: '8225255',
              formatted: '8.225255',
              usdValue: 8.23,
              eurValue: 7.6,
              sekValue: 80,
            },
          ],
          loading: false,
          error: null,
          refetch: vi.fn(),
        })
        render(<AccountDetailClient />)
        const section = screen.getByRole('region', { name: 'Holdings' })
        // 8.225255 renders as 8.2252 — truncated, never 8.2253 — and the title
        // carries the amount AS SERVED (up to 6 decimals).
        expect(within(section).getByText('8.2252')).toHaveAttribute('title', '8.225255')
        expect(within(section).queryByText('8.225255')).toBeNull()
      })

      it('a two-token account truncates each figure, "<0.0001" for a dust read', () => {
        mockUsePortfolio.mockReturnValue({
          totalUsd: 8.23,
          totalEur: 7.6,
          totalSek: 80,
          breakdown: [
            {
              symbol: 'USDC',
              balance: '8225255',
              formatted: '8.225255',
              usdValue: 8.23,
              eurValue: 7.6,
              sekValue: 80,
            },
            {
              symbol: 'DAI',
              balance: '50',
              formatted: '0.00005',
              usdValue: 0,
              eurValue: 0,
              sekValue: 0,
            },
          ],
          loading: false,
          error: null,
          refetch: vi.fn(),
        })
        render(<AccountDetailClient />)
        const section = screen.getByRole('region', { name: 'Holdings' })
        expect(within(section).getByText('8.2252')).toHaveAttribute('title', '8.225255')
        // A non-zero amount under 0.0001 reads "<0.0001", not "0.00"; the
        // served amount is still the tooltip.
        expect(within(section).getByText('<0.0001')).toHaveAttribute('title', '0.00005')
      })
    })

    it('the Security & details tab carries ONE heading and ONE intro sentence', () => {
      tabParam = 'security'
      render(<AccountDetailClient />)
      // The section's only heading is the page's; the card's repeated
      // "Backup & recovery" heading and its duplicate intro are gone
      // (the mocked card here renders neither).
      const headings = screen.getAllByRole('heading').map((h) => h.textContent)
      expect(headings).toContain('Who can approve')
      expect(headings).not.toContain('Backup & recovery')
      // The intro sentence renders exactly once.
      expect(screen.getAllByText(/Keep at least two, so a lost device never/).length).toBe(1)
    })
  })

  describe('header badges and button primacy (#4097)', () => {
    it('shows no badges on Base mainnet with one account', () => {
      render(<AccountDetailClient />)
      expect(screen.queryByText('Test network')).not.toBeInTheDocument()
      expect(screen.queryByText('Default account')).not.toBeInTheDocument()
    })

    it('shows the test network badge on a testnet chain, and the default badge only with two accounts', () => {
      mockUseAuth.mockReturnValue({
        ...mockUseAuth(),
        user: {
          ...mockUseAuth().user,
          accounts: [
            { ...SAFE, chain_id: 84532 },
            { ...SAFE, id: 'safe-2', name: 'Second', chain_id: 8453, is_default: false },
          ],
        },
      })
      render(<AccountDetailClient />)
      expect(screen.getByText('Test network')).toBeInTheDocument()
      expect(screen.getByText('Default account')).toBeInTheDocument()
    })

    it('Send is primary once the account holds money', () => {
      render(<AccountDetailClient />)
      const send = screen.getByRole('button', { name: 'Send' })
      expect(send).not.toBeDisabled()
    })

    it('an empty account makes Receive primary and disables Send', () => {
      mockUsePortfolio.mockReturnValue({
        totalUsd: 0,
        totalEur: 0,
        breakdown: [
          { symbol: 'USDC', balance: '0', formatted: '0.00', usdValue: 0, eurValue: 0, sekValue: 0 },
        ],
        loading: false,
        error: null,
        refetch: vi.fn(),
      })
      render(<AccountDetailClient />)

      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Receive' })).not.toBeDisabled()
      // The empty account renders its empty holdings and zero figures.
      expect(screen.getByText('No tokens yet')).toBeInTheDocument()
      expect(screen.getByText('$0.00')).toBeInTheDocument()
    })
  })

  describe('the tab row owns ?tab= (#4097)', () => {
    it('Activity is the default tab', () => {
      render(<AccountDetailClient />)
      expect(screen.getByRole('tab', { name: /Activity/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('account-activity-tab')).toBeInTheDocument()
    })

    it('?tab=agents selects the Agents tab', () => {
      tabParam = 'agents'
      render(<AccountDetailClient />)
      expect(screen.getByRole('tab', { name: /Agents/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByTestId('account-activity-tab')).not.toBeInTheDocument()
    })

    it('?tab=security selects the Security & details tab', () => {
      tabParam = 'security'
      render(<AccountDetailClient />)
      expect(screen.getByRole('tab', { name: /Security & details/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('heading', { name: 'Who can approve' })).toBeInTheDocument()
    })

    it('an unknown tab value falls back to Activity', () => {
      tabParam = 'bogus'
      render(<AccountDetailClient />)
      expect(screen.getByRole('tab', { name: /Activity/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('account-activity-tab')).toBeInTheDocument()
    })

    it('clicking a tab writes ?tab= to the URL; the default tab has no parameter', async () => {
      render(<AccountDetailClient />)
      fireEvent.click(screen.getByRole('tab', { name: /Security & details/ }))
      await waitFor(() =>
        expect(mockRouterReplace).toHaveBeenCalledWith('/accounts/safe-1?tab=security', { scroll: false }),
      )
      fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
      await waitFor(() =>
        expect(mockRouterReplace).toHaveBeenCalledWith('/accounts/safe-1?tab=agents', { scroll: false }),
      )
    })

    it('returning to Activity from another tab writes the bare account URL', async () => {
      // The URL says security; clicking Activity then owns the canonical
      // default address (no ?tab= parameter).
      tabParam = 'security'
      render(<AccountDetailClient />)
      fireEvent.click(screen.getByRole('tab', { name: /^Activity/ }))
      await waitFor(() =>
        expect(mockRouterReplace).toHaveBeenCalledWith('/accounts/safe-1', { scroll: false }),
      )
    })
  })

  describe('the Agents tab (#4097)', () => {
    function agentOverview() {
      return overview({
        agents: [
          {
            id: 'agent-1',
            name: 'Research agent',
            status: 'active',
            avatarTint: 1,
            accountId: 'safe-1',
            accountName: 'Main account',
            accountChainId: 8453, budgetEndedAt: null,
            allowances: [],
            budgets: [
              {
                id: 'budget-1',
                delegationHash: '0xabc',
                chainId: 8453,
                tokenAddress: '0x' + 'aa'.repeat(20),
                tokenSymbol: 'USDC',
                decimals: 6,
                budgetAtomic: '5000000',
                periodSeconds: 86_400,
                startDate: '2026-10-01T00:00:00Z',
                expiresAt: '2026-11-01T00:00:00Z',
                periodEnd: '2026-10-20T00:00:00Z',
              },
            ],
            receivedSubBudgets: [],
            stats: {
              d7: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 } },
              d30: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 } },
              lastPaymentAt: null,
              lastCounterparty: null,
            },
          },
        ],
        agentCount: { active: 1, paused: 0, pending_approval: 0 },
      })
    }

    it('lists the account agents and carries the count on the tab', () => {
      mockUseDashboardOverview.mockReturnValue({
        data: agentOverview(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      })
      tabParam = 'agents'
      render(<AccountDetailClient />)

      expect(screen.getByText('Research agent')).toBeInTheDocument()
      const agentRow = screen.getByRole('link', { name: /Research agent/ })
      expect(agentRow.firstElementChild).toHaveAttribute('aria-hidden', 'true')
      expect(agentRow.firstElementChild).toHaveTextContent('RA')
      // The tab count: 1 agent, rendered beside the tab label.
      const tab = screen.getByRole('tab', { name: /Agents/ })
      expect(within(tab).getByText('1')).toBeInTheDocument()
      // The budget snapshot line.
      expect(
        screen.getByText('1 agent can spend up to 5.00 USDC per day from this account.'),
      ).toBeInTheDocument()
    })

    it('empty Agents tab offers Connect agent', () => {
      tabParam = 'agents'
      render(<AccountDetailClient />)

      // `Button href` renders a link — the empty tab's action routes to the
      // Agents page, where the connect flow lives.
      expect(screen.getByRole('link', { name: 'Connect agent' })).toHaveAttribute('href', '/agents')
    })

    it('revoked agents are not listed; the hidden count links to the revoked facet', () => {
      mockUseDashboardOverview.mockReturnValue({
        data: agentOverview(),
        loading: false,
        error: null,
        refetch: vi.fn(),
      })
      mockUseAgents.mockReturnValue({
        agents: [
          {
            id: 'agent-2',
            name: 'Old agent',
            account_id: 'safe-1',
            status: 'revoked',
            account_type: 'delegator_hybrid',
            allowances: [],
          },
        ],
        loading: false,
        error: null,
        refetch: vi.fn(),
      })
      tabParam = 'agents'
      render(<AccountDetailClient />)

      expect(screen.queryByText('Old agent')).not.toBeInTheDocument()
      expect(screen.getByText(/1 revoked agent not listed/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/agents?status=revoked')
    })

    it('with two or more accounts the revoked link narrows by account', () => {
      mockUseAuth.mockReturnValue({
        ...mockUseAuth(),
        user: {
          ...mockUseAuth().user,
          accounts: [SAFE, { ...SAFE, id: 'safe-2', name: 'Second' }],
        },
      })
      mockUseAgents.mockReturnValue({
        agents: [
          {
            id: 'agent-2',
            name: 'Old agent',
            account_id: 'safe-1',
            status: 'revoked',
            account_type: 'delegator_hybrid',
            allowances: [],
          },
        ],
        loading: false,
        error: null,
        refetch: vi.fn(),
      })
      tabParam = 'agents'
      render(<AccountDetailClient />)

      expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute(
        'href',
        '/agents?status=revoked&account=safe-1',
      )
    })

    it('does not claim agents are gone while the overview is loading', () => {
      mockUseDashboardOverview.mockReturnValue({ data: null, loading: true, error: null, refetch: vi.fn() })
      tabParam = 'agents'
      render(<AccountDetailClient />)

      expect(screen.queryByText('No agents connected')).not.toBeInTheDocument()
      expect(screen.getByRole('status', { name: 'Loading agents' })).toBeInTheDocument()
    })
  })

  describe('Security & details tab (#4097)', () => {
    it('hosts AccountSignersCard and the account details', () => {
      tabParam = 'security'
      render(<AccountDetailClient />)

      expect(screen.getByRole('heading', { name: 'Who can approve' })).toBeInTheDocument()
      const card = screen.getByTestId('account-signers-card')
      expect(card).toHaveAttribute('data-safe-address', SAFE.account_address)
      expect(screen.getByRole('heading', { name: 'Account details' })).toBeInTheDocument()
      expect(screen.getByText('0x1111…1111')).toBeInTheDocument()
      expect(screen.getByText('Base')).toBeInTheDocument()
      expect(screen.getByText('12 May 2026')).toBeInTheDocument()
    })

    it('one signer: the Security tab carries the warning dot', () => {
      render(<AccountDetailClient />)
      const tab = screen.getByRole('tab', { name: /Security & details/ })
      expect(within(tab).getByText('Needs attention')).toBeInTheDocument()
    })

    it('two or more signers: no warning dot', () => {
      mockUseAccountSigners.mockReturnValue({
        ...mockUseAccountSigners(),
        signers: {
          account_address: SAFE.account_address,
          passkeys: [
            { key_id: 'k1', created_at: '2026-05-12T00:00:00Z' },
            { key_id: 'k2', created_at: '2026-06-01T00:00:00Z' },
          ],
          owner_address: null,
        },
      })
      render(<AccountDetailClient />)
      const tab = screen.getByRole('tab', { name: /Security & details/ })
      expect(within(tab).queryByText('Needs attention')).not.toBeInTheDocument()
    })

    it('an unknown signer read shows no dot rather than a false warning', () => {
      mockUseAccountSigners.mockReturnValue({
        ...mockUseAccountSigners(),
        signers: null,
        loadError: true,
      })
      render(<AccountDetailClient />)
      const tab = screen.getByRole('tab', { name: /Security & details/ })
      expect(within(tab).queryByText('Needs attention')).not.toBeInTheDocument()
    })
  })

  describe('Last 30 days (#4097)', () => {
    it('renders Money in and Money out as two figures', () => {
      render(<AccountDetailClient />)
      expect(screen.getByText('$120.00')).toBeInTheDocument()
      expect(screen.getByText('$45.00')).toBeInTheDocument()
    })

    it('sets both figures at the secondary-figure size beside figure-density marks (#4260)', () => {
      render(<AccountDetailClient />)
      const section = screen.getByRole('region', { name: 'Last 30 days' })
      // The class is on the Amount span itself — a wrapper's text-* never
      // resizes the figure (#4259).
      const moneyIn = within(section).getByText('$120.00')
      const moneyOut = within(section).getByText('$45.00')
      // Plain matchers over the class list, so a miss is an AssertionError.
      for (const figure of [moneyIn, moneyOut]) {
        expect([...figure.classList]).toContain('text-xl')
        expect([...figure.classList]).not.toContain('text-sm')
      }
      // The mark is the 24px figure box, on the rendered mark span.
      for (const icon of ['svg.lucide-arrow-down', 'svg.lucide-arrow-up']) {
        const mark = section.querySelector(icon)!.closest('span[aria-hidden="true"]')!
        expect([...mark.classList]).toEqual(expect.arrayContaining(['h-6', 'w-6', 'rounded-[7px]']))
        expect([...mark.classList]).not.toContain('h-[18px]')
      }
      // The sr-only names still sit before each figure, in its pair.
      expect(within(section).getByText('Money in').parentElement).toContainElement(moneyIn)
      expect(within(section).getByText('Money out').parentElement).toContainElement(moneyOut)
    })

    it('while loading, the skeleton is one 28px row of two bars (#4260)', () => {
      mockUseAccountMoneyFlow.mockReturnValue({
        ...mockUseAccountMoneyFlow(),
        loading: true,
      })
      render(<AccountDetailClient />)
      const skeleton = screen.getByRole('status', { name: 'Loading the last 30 days' })
      expect([...skeleton.classList]).toEqual(expect.arrayContaining(['flex', 'h-7']))
      expect([...skeleton.classList]).not.toContain('space-y-2')
      expect(skeleton.children).toHaveLength(2)
    })

    it('carries the partial-data indicator when the feed is capped', () => {
      mockUseAccountMoneyFlow.mockReturnValue({
        ...mockUseAccountMoneyFlow(),
        partial: true,
      })
      render(<AccountDetailClient />)
      expect(
        screen.getByText('Figures cover the history Haven could load, which may not cover the full 30 days.'),
      ).toBeInTheDocument()
    })

    it('shows a retry when the window read failed', () => {
      mockUseAccountMoneyFlow.mockReturnValue({
        ...mockUseAccountMoneyFlow(),
        moneyIn: 0,
        moneyOut: 0,
        error: 'explorer down',
      })
      render(<AccountDetailClient />)
      expect(screen.getByText('Haven could not load the last 30 days.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    })
  })

  it('offers the account spend affordances it renders', () => {
    render(<AccountDetailClient />)

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    tabParam = 'security'
    render(<AccountDetailClient />)
    expect(screen.getByTestId('account-signers-card')).toBeInTheDocument()
  })

  // #2414: the unlink route answers 409 while an agent still holds spending
  // authority or a recovery is mid-flight. Before the fix the rejection escaped
  // as an unhandled promise rejection — the spinner stopped and nothing else
  // changed, so a refusal was indistinguishable from a dead button.
  it('keeps the account and says why when unlinking is refused', async () => {
    const removeAccount = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError(
          'Cannot unlink this Haven wallet while an agent has a live (pending, active or replaced) budget delegation or recovery is in progress',
          409,
        ),
      )
    mockUseAccounts.mockReturnValue({ renameAccount: vi.fn(), removeAccount, setDefault: vi.fn(), loading: false })

    render(<AccountDetailClient />)

    fireEvent.click(screen.getByLabelText('Account options'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove account' }))
    expect(screen.getByRole('heading', { name: 'Remove Main account?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent(/still has a budget/i)
    // Pending grants block the unlink too, so the copy must not say "active".
    expect(refusal).not.toHaveTextContent(/active budget/i)
    // The Security & details tab is signer replacement, not the sweep this
    // refusal is about — the copy must not borrow that word as a noun.
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
    const removeAccount = vi.fn().mockRejectedValue(new ApiRequestError('nope', 409))
    mockUseAccounts.mockReturnValue({ renameAccount: vi.fn(), removeAccount, setDefault: vi.fn(), loading: false })

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
    const removeAccount = vi.fn().mockRejectedValue(new ApiRequestError('boom', 500))
    mockUseAccounts.mockReturnValue({ renameAccount: vi.fn(), removeAccount, setDefault: vi.fn(), loading: false })

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
    const removeAccount = vi.fn().mockResolvedValue(undefined)
    mockUseAccounts.mockReturnValue({ renameAccount: vi.fn(), removeAccount, setDefault: vi.fn(), loading: false })

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
        accounts: [{ ...SAFE, account_type: 'delegator_hybrid' }],
      },
      loading: false,
      passkeys: [],
    })
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    tabParam = 'security'

    render(<AccountDetailClient />)

    const card = screen.getByTestId('account-signers-card')
    expect(card).toHaveAttribute('data-safe-address', SAFE.account_address)
  })

  // #4098: the tab owns the ledger — its own suite covers the truncated
  // honesty rule (the #2882 qualification) and the count line. The shell
  // renders the tab and keeps no feed of its own.
  it('renders the Activity tab and keeps no provisional feed of its own', () => {
    render(<AccountDetailClient />)

    expect(screen.getByTestId('account-activity-tab')).toBeInTheDocument()
    expect(screen.queryByText(/for this Haven wallet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/recent transactions/i)).not.toBeInTheDocument()
  })
})
