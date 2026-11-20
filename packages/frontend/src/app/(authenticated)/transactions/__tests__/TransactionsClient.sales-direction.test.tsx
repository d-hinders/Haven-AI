/**
 * #5001 — the Sales choice on the Transactions Direction facet, and the In
 * total's split into money from sales and money moved in.
 *
 * Three things are asserted here, each a line of the issue:
 *
 * - the option is offered only to a user with a Sales account, and sits
 *   between Incoming and Outgoing;
 * - the URL value is accepted for EVERY user, so a `?direction=sales` link
 *   opened without a Sales account resolves to the usual no-match state and
 *   never errors (the chip is the way out);
 * - the summary line: "Sales <amount>" under Sales, and
 *   "In <amount> · of which sales <amount>" under Incoming when the set holds
 *   a sale.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet, urlState, authState, merchantState, feedState, totalsRows } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  urlState: { query: '' },
  authState: {
    accounts: [] as Array<{ id: string; account_address: string; chain_id: number; name: string }>,
    currency: 'USD' as 'USD' | 'EUR' | 'SEK',
  },
  merchantState: {
    value: { status: 'ready', enabled: false, merchantAccount: null as { id: string; name: string; chain_id: number } | null },
  },
  feedState: { empty: false, total: 1 },
  totalsRows: { rows: [] as Array<Record<string, unknown>> },
}))

const SIGNED_IN_ACCOUNTS = [
  { id: 'safe-1', account_address: '0x' + 'aa'.repeat(20), chain_id: 8453, name: 'Main' },
]

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      getText: vi.fn(),
      // The unfiltered total behind "{shown} of {total}" (`limit=1`) and the
      // In/Out totals walk (#4266) both read through `api.get`.
      get: (...a: unknown[]) => mockGet(...a),
    },
  }
})
vi.mock('next/navigation', () => ({
  usePathname: () => '/transactions',
  useSearchParams: () => new URLSearchParams(urlState.query),
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { accounts: authState.accounts, currency_preference: authState.currency } }),
}))
// The shell's ONE merchant-services read (#4904). The page must not call
// `useMerchantServices` a second time, so this is the only source it sees.
vi.mock('@/context/MerchantServicesContext', () => ({
  useMerchantServicesContext: () => merchantState.value,
  // The detail panel's optional read (#5000); no row is opened in this file.
  useOptionalMerchantServicesContext: () => null,
}))
vi.mock('@/hooks/useContacts', () => ({ useContacts: () => ({ resolveAddress: () => null }) }))
vi.mock('@/hooks/useTransactionFilters', () => ({
  useTransactionFilters: () => ({ accounts: [], agents: [], tokens: [], loading: false, error: null }),
}))

const TX = {
  hash: '0xabc',
  type: 'erc20' as const,
  from: '0x' + 'bb'.repeat(20),
  to: '0x' + 'aa'.repeat(20),
  value: '1000000',
  valueFormatted: '1.00',
  asset: 'USDC',
  decimals: 6,
  direction: 'in' as const,
  timestamp: 1_778_240_999,
  blockNumber: 1,
  isError: false,
  chainId: 8453,
  accountId: 'safe-1',
  accountAddress: '0x' + 'aa'.repeat(20),
  accountName: 'Main',
}

vi.mock('@/hooks/useTransactionsFeed', async () => ({
  ...(await vi.importActual<typeof import('@/hooks/useTransactionsFeed')>('@/hooks/useTransactionsFeed')),
  browserTimeZone: () => 'Europe/Stockholm',
  useTransactionsFeed: () => ({
    transactions: feedState.empty ? [] : [TX],
    total: feedState.empty ? 0 : feedState.total,
    loadingInitial: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    partialFailure: false,
    failedAccountIds: [],
    truncated: false,
    liveKeys: new Set<string>(),
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}))

const TransactionsClient = (await import('../TransactionsClient')).default

/** One feed row for the totals walk, priced book-time in USD by default. */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    hash: '0x' + 'cc'.repeat(32),
    type: 'erc20',
    from: '0x' + 'bb'.repeat(20),
    to: '0x' + 'aa'.repeat(20),
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    tokenSymbol: 'USDC',
    decimals: 6,
    direction: 'in',
    timestamp: 1_778_240_999,
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0x' + 'aa'.repeat(20),
    accountName: 'Main',
    convertedAmount: '10.00',
    convertedCurrency: 'USD',
    ...overrides,
  }
}

const SALE_MARKER = { productName: 'Haven Field Notes', receiptNumber: 'R-1', merchantReference: 'ref-1' }

beforeEach(() => {
  mockGet.mockReset()
  mockGet.mockImplementation(async (url: string) =>
    // The unfiltered-total read is the one with `limit=1` exactly — not the
    // totals walk's `limit=100`.
    /(?:^|[?&])limit=1(?:&|$)/.test(String(url))
      ? { total: 40 }
      : { transactions: totalsRows.rows, total: totalsRows.rows.length, hasMore: false },
  )
  totalsRows.rows = []
  urlState.query = ''
  authState.accounts = SIGNED_IN_ACCOUNTS
  authState.currency = 'USD'
  merchantState.value = { status: 'ready', enabled: false, merchantAccount: null }
  feedState.empty = false
  feedState.total = 1
  window.history.replaceState(null, '', '/transactions')
})

function openDirectionMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: /^direction:/i }))
}

describe('TransactionsClient — the Sales choice on Direction (#5001)', () => {
  it('offers Sales between Incoming and Outgoing for a user with a Sales account', () => {
    merchantState.value = {
      status: 'ready',
      enabled: true,
      merchantAccount: { id: 'sales-1', name: 'Sales', chain_id: 8453 },
    }
    render(<TransactionsClient />)

    openDirectionMenu()
    const options = screen.getAllByRole('menuitemradio').map((el) => el.textContent?.trim())
    // All first (the facet's "no filter" row), then the three choices in order.
    expect(options).toEqual(['All', 'Incoming', 'Sales', 'Outgoing'])
  })

  it('does not offer Sales to a user without a Sales account', () => {
    render(<TransactionsClient />)

    openDirectionMenu()
    const options = screen.getAllByRole('menuitemradio').map((el) => el.textContent?.trim())
    expect(options).toEqual(['All', 'Incoming', 'Outgoing'])
    expect(screen.queryByRole('menuitemradio', { name: /^sales$/i })).toBeNull()
  })

  it('keeps the Sales option when Sales is turned off but the account survives', () => {
    // `merchantAccount` survives turning Sales off (`useMerchantServices`), so
    // past sales stay filterable.
    merchantState.value = {
      status: 'ready',
      enabled: false,
      merchantAccount: { id: 'sales-1', name: 'Sales', chain_id: 8453 },
    }
    render(<TransactionsClient />)

    openDirectionMenu()
    expect(screen.getByRole('menuitemradio', { name: /^sales$/i })).toBeInTheDocument()
  })

  it('resolves a ?direction=sales link for a user without a Sales account to the no-match state, never an error', async () => {
    urlState.query = 'direction=sales'
    window.history.replaceState(null, '', '/transactions?direction=sales')
    feedState.empty = true
    render(<TransactionsClient />)

    // The URL value is accepted for everyone (the codec's `values`), so the
    // filter is applied rather than rewritten away…
    expect(await screen.findByTestId('transactions-no-match')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    // …and the chip names it as a filter, which is the way out.
    expect(screen.getByRole('button', { name: /^direction: 1 selected$/i })).toBeInTheDocument()
  })

  it('sends direction=sales on the feed request', async () => {
    urlState.query = 'direction=sales'
    window.history.replaceState(null, '', '/transactions?direction=sales')
    render(<TransactionsClient />)

    await waitFor(() =>
      expect(mockGet.mock.calls.some(([url]) => String(url).includes('direction=sales'))).toBe(true),
    )
  })
})

describe('TransactionsClient — the totals line under Direction (#5001)', () => {
  it('shows one figure, "Sales <amount>", under Direction: Sales — never In or Out', async () => {
    urlState.query = 'direction=sales'
    window.history.replaceState(null, '', '/transactions?direction=sales')
    totalsRows.rows = [row({ sale: SALE_MARKER, convertedAmount: '10.00' })]
    render(<TransactionsClient />)

    const totals = await screen.findByTestId('transactions-totals')
    expect(within(totals).getByText('Sales')).toBeInTheDocument()
    expect(within(totals).getByText('Money from sales')).toBeInTheDocument()
    expect(within(totals).getByText('$10.00')).toBeInTheDocument()
    expect(within(totals).queryByText('In')).toBeNull()
    expect(within(totals).queryByText('Out')).toBeNull()
  })

  it('splits In under Direction: Incoming when the set holds a sale', async () => {
    merchantState.value = {
      status: 'ready',
      enabled: true,
      merchantAccount: { id: 'sales-1', name: 'Sales', chain_id: 8453 },
    }
    urlState.query = 'direction=in'
    window.history.replaceState(null, '', '/transactions?direction=in')
    totalsRows.rows = [
      row({ sale: SALE_MARKER, convertedAmount: '10.00' }),
      row({ hash: '0x' + 'dd'.repeat(32), convertedAmount: '5.00' }),
    ]
    render(<TransactionsClient />)

    const totals = await screen.findByTestId('transactions-totals')
    expect(within(totals).getByText('In')).toBeInTheDocument()
    expect(within(totals).getByText('$15.00')).toBeInTheDocument()
    expect(within(totals).getByText(/of which sales/)).toBeInTheDocument()
    expect(within(totals).getByText('$10.00')).toBeInTheDocument()
    // Incoming still hides the other half.
    expect(within(totals).queryByText('Out')).toBeNull()
  })

  it('leaves the Incoming line unchanged when the set holds no sale', async () => {
    merchantState.value = {
      status: 'ready',
      enabled: true,
      merchantAccount: { id: 'sales-1', name: 'Sales', chain_id: 8453 },
    }
    urlState.query = 'direction=in'
    window.history.replaceState(null, '', '/transactions?direction=in')
    totalsRows.rows = [row({ convertedAmount: '5.00' })]
    render(<TransactionsClient />)

    const totals = await screen.findByTestId('transactions-totals')
    expect(within(totals).getByText('In')).toBeInTheDocument()
    expect(within(totals).queryByText(/of which sales/)).toBeNull()
  })

  it('leaves the All line unchanged: "In · Out"', async () => {
    merchantState.value = {
      status: 'ready',
      enabled: true,
      merchantAccount: { id: 'sales-1', name: 'Sales', chain_id: 8453 },
    }
    totalsRows.rows = [
      row({ sale: SALE_MARKER, convertedAmount: '10.00' }),
      row({ hash: '0x' + 'ee'.repeat(32), direction: 'out', convertedAmount: '4.00' }),
    ]
    render(<TransactionsClient />)

    const totals = await screen.findByTestId('transactions-totals')
    expect(within(totals).getByText('In')).toBeInTheDocument()
    expect(within(totals).getByText('Out')).toBeInTheDocument()
    expect(within(totals).queryByText(/of which sales/)).toBeNull()
  })
})
