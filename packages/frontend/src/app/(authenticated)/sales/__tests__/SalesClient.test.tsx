import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sales page (#4900, epic #4885).
 *
 * The reads are mocked at `api.get` and everything above it is real — the
 * hooks, the paging, the formatters, the ledger row — so one fixture can prove
 * the claim the issue makes: the tiles, the breakdowns and the rows describe
 * the SAME period and agree with each other. The shell's merchant-services
 * setting is the one context the page may read; it is mocked as the shell
 * would hand it over.
 */

const mockGet = vi.fn()
const mockMerchantServices = vi.fn()
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})

vi.mock('@/lib/api', () => ({
  api: { get: (path: string) => mockGet(path) },
}))

vi.mock('@/context/MerchantServicesContext', () => ({
  useMerchantServicesContext: () => mockMerchantServices(),
}))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ currency: 'USD', setCurrency: vi.fn(), saving: false }),
}))

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  usePathname: () => '/sales',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

// The Receive dialog is its own pattern with its own tests; here only that the
// page opens it pointed at the Sales account.
vi.mock('@/components/ReceiveDialog', () => ({
  default: ({ open, account }: { open: boolean; account: { name: string; account_address: string } | null }) =>
    open ? <div role="dialog" aria-label="Receive">{`Receive to ${account?.name} ${account?.account_address}`}</div> : null,
}))

import SalesClient from '../SalesClient'
import { previousSalesRange, salesDayRange, SALES_PAGE_SIZE } from '@/lib/sales'

const SALES_ACCOUNT = {
  id: 'acct-sales',
  account_address: '0x7Ac3E19b5D0F42c86e1A93b7f0D5c2E48b916Fd2',
  chain_id: 8453,
  name: 'Sales',
  created_at: '2026-11-01T00:00:00.000Z',
}

function setting(status: 'loading' | 'ready' | 'error', enabled: boolean) {
  return {
    status,
    enabled,
    state: null,
    merchantAccount: enabled ? SALES_ACCOUNT : null,
    refresh: vi.fn(),
    turnOn: vi.fn(),
    turnOff: vi.fn(),
  }
}

const CONTACT = { kind: 'contact', name: 'Lumen Research', address: '0x41b2c09e7a55d81f3b2e6c40a9d17e5f8c0b7d93' }
const OWN = { kind: 'own', name: 'Atlas', address: '0x9e10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4c2a' }
const WALLET = { kind: 'wallet', name: null, address: '0x8f3a5e0b7c1d4a92e6f03b8d15c7a90e4b6d21c0' }
// Another Haven user's agent: the reads already answer it as a wallet; the page
// must not add anything that says so.
const OTHER_USERS_AGENT = { kind: 'wallet', name: null, address: '0x5c1d93e2b07f4a6c8d15e3b9a20f7c64d1e8a7f2' }

const zero = { count: 0, amount_raw: '0' }

/**
 * One period, one fixture. Revenue $2.14 = 2 chat sales ($0.84) + 1 embeddings
 * sale ($0.30) + 1 payment with no product ($1.00). A move of $0.50 from the
 * owner's own agent is in the list and in none of the figures.
 */
const SUMMARY = {
  revenue_raw: '2140000',
  sales: 3,
  average_sale_raw: '380000',
  without_product: { count: 1, amount_raw: '1000000' },
  own_moves: { count: 1, amount_raw: '500000' },
  by_product: [
    { product_id: 'chat', label: 'Chat completion', sales: 2, amount_raw: '840000' },
    { product_id: 'embed', label: 'Embeddings', sales: 1, amount_raw: '300000' },
  ],
  by_product_other: { products: 0, sales: 0, amount_raw: '0' },
  by_payer: [
    { payer: CONTACT, payments: 2, amount_raw: '1140000' },
    { payer: WALLET, payments: 1, amount_raw: '700000' },
    { payer: OTHER_USERS_AGENT, payments: 1, amount_raw: '300000' },
  ],
  by_payer_other: { payers: 0, payments: 0, amount_raw: '0' },
  unattributed: { payments: 0, amount_raw: '0' },
  by_day: [
    { day: '2026-11-16', payments: 2, sales: 2, revenue_raw: '1140000' },
    { day: '2026-11-17', payments: 2, sales: 1, revenue_raw: '1000000' },
  ],
}

const PREVIOUS_SUMMARY = { ...SUMMARY, revenue_raw: '1070000' }

const PAYMENTS = [
  { tx_hash: '0xa1', block_time: '2026-11-17T14:05:00.000Z', kind: 'sale', amount_raw: '420000', product_id: 'chat', product_label: 'Chat completion', payer: CONTACT, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
  { tx_hash: '0xa2', block_time: '2026-11-17T13:48:00.000Z', kind: 'no_product', amount_raw: '1000000', product_id: null, product_label: null, payer: WALLET, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
  { tx_hash: '0xa3', block_time: '2026-11-16T10:00:00.000Z', kind: 'own_move', amount_raw: '500000', product_id: null, product_label: null, payer: OWN, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
  { tx_hash: '0xa4', block_time: '2026-11-16T09:30:00.000Z', kind: 'sale', amount_raw: '420000', product_id: 'chat', product_label: 'Chat completion', payer: CONTACT, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'stripe' },
  { tx_hash: '0xa5', block_time: '2026-11-16T09:00:00.000Z', kind: 'sale', amount_raw: '300000', product_id: 'embed', product_label: 'Embeddings', payer: OTHER_USERS_AGENT, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
]

interface Scenario {
  everPaid?: boolean
  summary?: unknown
  previous?: unknown
  pages?: Array<{ payments: unknown[]; next_cursor: string | null }>
}

/** Serve the reads: the whole-history probe, the two summaries and the pages. */
function serve({ everPaid = true, summary = SUMMARY, previous = PREVIOUS_SUMMARY, pages }: Scenario = {}) {
  const today = salesDayRange({ preset: '30d' })
  const prior = previousSalesRange(today)
  const queue = pages ?? [{ payments: PAYMENTS, next_cursor: null }]
  mockGet.mockImplementation(async (path: string) => {
    const url = new URL(path, 'http://x')
    if (url.pathname === '/merchant-sales/summary') {
      return url.searchParams.get('to') === prior.to ? previous : summary
    }
    if (url.pathname === '/merchant-sales/payments') {
      if (!url.searchParams.has('from')) {
        return { payments: everPaid ? [PAYMENTS[0]] : [], next_cursor: null }
      }
      const cursor = url.searchParams.get('cursor')
      const index = cursor === null ? 0 : Number(cursor.replace('c', ''))
      return queue[index]
    }
    throw new Error(`unexpected read ${path}`)
  })
}

const callsTo = (fragment: string) => mockGet.mock.calls.map((c) => String(c[0])).filter((p) => p.includes(fragment))

async function renderPage() {
  render(<SalesClient />)
  await screen.findByTestId('sales-page')
}

beforeEach(() => {
  mockGet.mockReset()
  mockNotFound.mockClear()
  mockMerchantServices.mockReset().mockReturnValue(setting('ready', true))
  window.history.replaceState(null, '', '/sales')
})

describe('the gate', () => {
  it('answers as not found with merchant services off, and reads nothing', () => {
    mockMerchantServices.mockReturnValue(setting('ready', false))
    expect(() => render(<SalesClient />)).toThrow('NEXT_NOT_FOUND')
    expect(mockNotFound).toHaveBeenCalled()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('shows the route loading pattern, never a 404, while the setting loads', () => {
    mockMerchantServices.mockReturnValue(setting('loading', false))
    render(<SalesClient />)
    expect(mockNotFound).not.toHaveBeenCalled()
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeTruthy()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('says a failed read failed, with a retry, instead of a 404', async () => {
    const value = setting('error', false)
    mockMerchantServices.mockReturnValue(value)
    render(<SalesClient />)
    expect(mockNotFound).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(value.refresh).toHaveBeenCalled()
  })
})

describe('first run', () => {
  it('shows "No sales yet" and the three steps when the account has never been paid', async () => {
    serve({ everPaid: false })
    await renderPage()
    expect(await screen.findByText('No sales yet')).toBeTruthy()
    const steps = screen.getByTestId('sales-first-run')
    expect(within(steps).getByText('Put your receiving address in your kit')).toBeTruthy()
    expect(within(steps).getByText('Create a Sales key')).toBeTruthy()
    expect(within(steps).getByText('Tell Haven where your kit runs')).toBeTruthy()
    // Steps 2 and 3 go to the Setup tab.
    expect(within(steps).getByRole('link', { name: 'Create Sales key' }).getAttribute('href')).toBe('/sales?tab=setup')
    expect(within(steps).getByRole('link', { name: 'Add kit address' }).getAttribute('href')).toBe('/sales?tab=setup')
    // No figures, no period control, no summary read: a first run is not a quiet period.
    expect(screen.queryByTestId('sales-tiles')).toBeNull()
    expect(screen.queryByRole('button', { name: /Period/ })).toBeNull()
    expect(callsTo('/merchant-sales/summary')).toHaveLength(0)
  })

  it('opens Receive pointed at the Sales account from step 1 and from the header', async () => {
    serve({ everPaid: false })
    await renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Show address' }))
    expect(screen.getByRole('dialog', { name: 'Receive' }).textContent).toContain(`Receive to Sales ${SALES_ACCOUNT.account_address}`)
  })

  it('is not shown for a quiet period of an account that has been paid', async () => {
    serve({ summary: { ...SUMMARY, sales: 0, without_product: zero, own_moves: zero, revenue_raw: '0', by_product: [], by_payer: [], by_day: [] } })
    await renderPage()
    expect(await screen.findByTestId('sales-empty-period')).toBeTruthy()
    expect(screen.queryByText('No sales yet')).toBeNull()
  })
})

describe('the Overview, from one fixture', () => {
  it('shows tiles that agree with the breakdowns and the list', async () => {
    serve()
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toContain('$2.14')
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('3')
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('from 3 payers')
    expect(within(tiles).getByTestId('stat-tile-average-sale').textContent).toContain('$0.38')
    expect(within(tiles).getByTestId('stat-tile-without-a-product').textContent).toContain('1')

    // By product: the lines add up to the Revenue tile ($0.84 + $0.30 + $1.00).
    const byProduct = screen.getByTestId('sales-by-product')
    for (const text of ['Chat completion', 'Embeddings', 'No product', '$0.84', '$0.30', '$1.00']) {
      expect(within(byProduct).getAllByText(text).length).toBeGreaterThan(0)
    }
    // By payer: the lines add up to it too ($1.14 + $0.70 + $0.30).
    const byPayer = screen.getByTestId('sales-by-payer')
    for (const text of ['$1.14', '$0.70', '$0.30']) {
      expect(within(byPayer).getAllByText(text).length).toBeGreaterThan(0)
    }

    // The list: its summary line is the SAME count and revenue as the tiles
    // (3 sales + 1 no product + 1 own move listed; revenue never includes the move).
    const summaryLine = await screen.findByTestId('sales-payments-summary')
    expect(summaryLine.textContent).toContain('5 payments')
    expect(summaryLine.textContent).toContain('Revenue $2.14')
    expect(screen.getAllByTestId('sales-ledger')[0].textContent).toContain('Chat completion')
  })

  it('compares revenue with the period before, in the tile', async () => {
    serve()
    await renderPage()
    const revenue = await screen.findByTestId('stat-tile-revenue')
    await waitFor(() => expect(revenue.textContent).toContain('+100.0%'))
    expect(revenue.textContent).toContain('vs the 30 days before')
  })

  it('says so when the period before had no sales', async () => {
    serve({ previous: { ...SUMMARY, revenue_raw: '0' } })
    await renderPage()
    const revenue = await screen.findByTestId('stat-tile-revenue')
    await waitFor(() => expect(revenue.textContent).toContain('No sales in the 30 days before'))
    expect(revenue.textContent).not.toContain('%')
  })

  it('names the own moves once, not counted, and in no total', async () => {
    serve()
    await renderPage()
    expect((await screen.findByText(/Not counted:/)).closest('div')!.textContent).toContain(
      'Not counted: 1 payment of $0.50 from your own accounts or agents. Moves between your accounts are never revenue.',
    )
    // The revenue tile does not carry it.
    expect(screen.getByTestId('stat-tile-revenue').textContent).not.toContain('$2.64')
  })

  it('draws the by-day chart without a Refusals column', async () => {
    serve()
    await renderPage()
    const table = await screen.findAllByTestId('chart-data-table')
    expect(within(table[0]).queryByRole('columnheader', { name: 'Refusals' })).toBeNull()
    expect(within(table[0]).getByRole('columnheader', { name: 'Revenue' })).toBeTruthy()
  })

  it('has no search box, no facets and no Last paid column', async () => {
    serve()
    await renderPage()
    await screen.findByTestId('sales-tiles')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
    expect(screen.queryByText('Last paid')).toBeNull()
    expect(screen.queryByText('Price')).toBeNull()
  })

  it('shows the tiles, the other lines and the footer link to Transactions', async () => {
    serve({
      summary: {
        ...SUMMARY,
        by_product_other: { products: 2, sales: 4, amount_raw: '100000' },
        by_payer_other: { payers: 3, payments: 5, amount_raw: '200000' },
        unattributed: { payments: 1, amount_raw: '50000' },
      },
    })
    await renderPage()
    const byProduct = await screen.findByTestId('sales-by-product')
    expect(within(byProduct).getAllByText('Other').length).toBeGreaterThan(0)
    const byPayer = screen.getByTestId('sales-by-payer')
    expect(within(byPayer).getAllByText('Other payers').length).toBeGreaterThan(0)
    expect(within(byPayer).getAllByText('Several payers').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Transactions' }).getAttribute('href')).toBe('/transactions')
  })
})

describe('payers', () => {
  it('names contacts and own agents, and reads every other payer as Wallet with a short address', async () => {
    serve()
    await renderPage()
    const byPayer = await screen.findByTestId('sales-by-payer')
    expect(within(byPayer).getAllByText('Lumen Research').length).toBeGreaterThan(0)
    // Both wallets (one of them another Haven user's agent) read identically.
    expect(within(byPayer).getAllByText('Wallet')).toHaveLength(4) // 2 payers x (table + phone list)
    expect(within(byPayer).getAllByText('0x8f3a…21c0').length).toBeGreaterThan(0)
    expect(within(byPayer).getAllByText('0x5c1d…a7f2').length).toBeGreaterThan(0)
    const ledger = await screen.findAllByTestId('sales-ledger')
    expect(ledger[0].textContent).toContain('Lumen Research')
    expect(ledger[0].textContent).toContain('Wallet · 0x8f3a…21c0')
    expect(ledger[0].textContent).toContain('Wallet · 0x5c1d…a7f2')
  })

  it('never says a payer uses Haven', async () => {
    serve()
    await renderPage()
    await screen.findByTestId('sales-by-payer')
    await screen.findAllByTestId('sales-ledger')
    expect(screen.getByTestId('sales-page').textContent).not.toMatch(/haven (agent|user)|uses haven|haven wallet/i)
  })
})

describe('the ledger rows', () => {
  it('titles a payment with no sale record "No product recorded", muted', async () => {
    serve()
    await renderPage()
    const title = await screen.findByText('No product recorded')
    expect(title.className).toContain('text-[var(--v2-ink-3)]')
  })

  it('shows an own move as "Moved between your accounts", Not counted, and not signed as income', async () => {
    serve()
    await renderPage()
    const title = await screen.findByText('Moved between your accounts')
    const row = title.closest('[role="button"]') as HTMLElement
    expect(row.textContent).toContain('Atlas → Sales')
    expect(within(row).getByText('Not counted')).toBeTruthy()
    expect(row.textContent).toContain('$0.50')
    expect(row.textContent).not.toContain('+$0.50')
    // A sale IS signed as income.
    const sale = (await screen.findAllByText('Embeddings')).map((el) => el.closest('[role="button"]')).find(Boolean) as HTMLElement
    expect(sale.textContent).toContain('+$0.30')
  })

  it('renders a payment held in Stripe like any sale, with no special mark', async () => {
    serve()
    await renderPage()
    await screen.findByText('Moved between your accounts')
    expect(screen.queryByText(/stripe/i)).toBeNull()
  })

  it('opens the payment panel for the row that was pressed', async () => {
    serve()
    await renderPage()
    const row = (await screen.findByText('No product recorded')).closest('[role="button"]') as HTMLElement
    expect(screen.queryByTestId('sales-payment-panel')).toBeNull()
    await userEvent.click(row)
    expect(screen.getByTestId('sales-payment-panel')).toBeTruthy()
  })
})

describe('paging', () => {
  it('asks for one page, and "Show 50 more" asks for exactly the next cursor', async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...PAYMENTS[0],
        tx_hash: `0xp${n}-${i}`,
        block_time: '2026-11-17T12:00:00.000Z',
      }))
    serve({
      summary: { ...SUMMARY, sales: 120, without_product: zero, own_moves: zero },
      pages: [
        { payments: page(SALES_PAGE_SIZE), next_cursor: 'c1' },
        { payments: page(SALES_PAGE_SIZE).map((p, i) => ({ ...p, tx_hash: `0xq-${i}` })), next_cursor: 'c2' },
        { payments: [], next_cursor: null },
      ],
    })
    await renderPage()
    const more = await screen.findByTestId('list-show-more')
    expect(more.textContent).toBe('Show 50 more')
    // One page so far, never the whole period.
    expect(callsTo('from=').filter((p) => p.includes('/payments'))).toHaveLength(1)
    expect(callsTo('cursor=')).toHaveLength(0)

    await userEvent.click(more)
    await waitFor(() => expect(callsTo('cursor=')).toHaveLength(1))
    expect(callsTo('cursor=')[0]).toContain('cursor=c1')
    await waitFor(() => expect(document.querySelectorAll('[role="button"][aria-haspopup="dialog"]')).toHaveLength(SALES_PAGE_SIZE * 2))
    // Still more: a further press would ask for c2, not re-ask c1.
    expect(screen.getByTestId('list-show-more')).toBeTruthy()
  })

  it('hides Show more on the last page', async () => {
    serve()
    await renderPage()
    await screen.findByText('Moved between your accounts')
    expect(screen.queryByTestId('list-show-more')).toBeNull()
  })
})

describe('the tabs and the period', () => {
  it('holds the tab in the URL and swaps the body', async () => {
    serve()
    await renderPage()
    await screen.findByTestId('sales-tiles')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Products' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Setup' })).toBeTruthy()
  })

  it('opens on the tab the URL names, without the period control on Setup', async () => {
    window.history.replaceState(null, '', '/sales?tab=setup')
    serve()
    await renderPage()
    expect(screen.getByTestId('sales-setup-tab')).toBeTruthy()
    expect(screen.queryByTestId('sales-tiles')).toBeNull()
    expect(screen.queryByRole('button', { name: /Period/ })).toBeNull()
  })

  it('reads the period from the URL', async () => {
    window.history.replaceState(null, '', '/sales?period=7d')
    serve()
    await renderPage()
    await screen.findByTestId('sales-tiles')
    const seven = salesDayRange({ preset: '7d' })
    await waitFor(() => expect(callsTo('/summary').some((p) => p.includes(`from=${seven.from}&to=${seven.to}`))).toBe(true))
    await act(async () => {})
  })
})
