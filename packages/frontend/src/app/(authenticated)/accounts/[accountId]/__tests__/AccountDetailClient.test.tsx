/**
 * #4097 — the account page as the full record of one account: header (badges
 * in `meta`, Send/Receive primacy), the three-column summary card (Balance /
 * Holdings / Last 30 days), the tab row (?tab= owned here), the Agents tab
 * (active agents, hidden revoked count), and the Security & details tab
 * (AccountSignersCard + Account details). The removals are asserted too: no
 * off-ramp panel, no "Agent access" card, no "Token balances" table, no
 * "Advanced account details", no TransactionsTable.
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

vi.mock('@/components/ReceiveFundsModal', () => ({
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
      Backup &amp; recovery
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

/** Minimal aggregated row — the truncation cases only need the count line. */
function txRow() {
  return {
    hash: '0xabc',
    type: 'erc20' as const,
    from: '0x' + 'bb'.repeat(20),
    to: SAFE.account_address,
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    decimals: 6,
    direction: 'in' as const,
    timestamp: 1_778_240_999,
    blockNumber: 1,
    isError: false,
    chainId: SAFE.chain_id,
    accountId: SAFE.id,
    accountAddress: SAFE.account_address,
    accountName: SAFE.name,
  }
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
      d7: { ...zeroWindow, refusals: { budget: 0, scope: 0, failed: 0, haven: 0 } },
      d30: { ...zeroWindow, refusals: { budget: 0, scope: 0, failed: 0, haven: 0 } },
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
    mockUseAttentionDismissals.mockReturnValue({ dismissedIds: [], dismiss: vi.fn() })
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
      approx: false,
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
      expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument()
    })

    it('?tab=agents selects the Agents tab', () => {
      tabParam = 'agents'
      render(<AccountDetailClient />)
      expect(screen.getByRole('tab', { name: /Agents/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByRole('heading', { name: 'Activity' })).not.toBeInTheDocument()
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
      expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument()
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
            accountId: 'safe-1',
            accountName: 'Main account',
            accountChainId: 8453,
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
              d7: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, refusals: { budget: 0, scope: 0, failed: 0, haven: 0 } },
              d30: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, refusals: { budget: 0, scope: 0, failed: 0, haven: 0 } },
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

  // #2882: this surface reads the same capped feed as /transactions and made
  // the louder claim — "N transactions for this Haven wallet" from a total
  // that counts only what the explorer window returned.
  it('does not claim a complete history when the feed is capped', () => {
    mockUseTransactionsFeed.mockReturnValue({
      transactions: [txRow()],
      loadingInitial: false,
      loadingMore: false,
      error: null,
      total: 47,
      hasMore: true,
      truncated: true,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText(/47 recent transactions for this Haven wallet/i)).toBeInTheDocument()
    expect(screen.queryByText(/^47 transactions for this Haven wallet$/i)).toBeNull()
    expect(screen.getByText(/loaded/i)).toBeInTheDocument()
  })

  it('states the plain count when the feed is complete', () => {
    mockUseTransactionsFeed.mockReturnValue({
      transactions: [txRow()],
      loadingInitial: false,
      loadingMore: false,
      error: null,
      total: 3,
      hasMore: false,
      truncated: false,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText(/3 transactions for this Haven wallet/i)).toBeInTheDocument()
    expect(screen.queryByText(/recent transactions for this Haven wallet/i)).toBeNull()
  })
})
