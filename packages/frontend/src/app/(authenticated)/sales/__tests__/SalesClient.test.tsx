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
const mockDelete = vi.fn()
const mockReplace = vi.fn()
const mockMerchantServices = vi.fn()
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (path: string) => mockGet(path), delete: (path: string) => mockDelete(path) },
}))

vi.mock('@/context/MerchantServicesContext', () => ({
  useMerchantServicesContext: () => mockMerchantServices(),
}))

const mockCurrency = vi.fn<() => 'USD' | 'EUR' | 'SEK'>(() => 'USD')
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ currency: mockCurrency(), setCurrency: vi.fn(), saving: false }),
}))

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  usePathname: () => '/sales',
  useRouter: () => ({ push: vi.fn(), replace: (...args: unknown[]) => mockReplace(...args), back: vi.fn(), prefetch: vi.fn() }),
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
import { BY_PAYER_DESCRIPTION } from '@/components/sales/SalesOverviewTab'
import { LocaleProvider } from '@/context/LocaleContext'
import { ToastProvider } from '@/components/ui/Toast'
import { previousSalesRange, productFacetValue, salesDayRange, SALES_PAGE_SIZE } from '@/lib/sales'

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
  revenue_in_account_raw: '2140000',
  sales: 3,
  // $2.14 over every payment counted (3 sales + 1 with no product), rounded down (#4981).
  average_sale_raw: '535000',
  without_product: { count: 1, amount_raw: '1000000' },
  own_moves: { count: 1, amount_raw: '500000' },
  by_product: [
    { product_id: 'chat', label: 'Chat completion', sales: 2, amount_raw: '840000' },
    { product_id: 'embed', label: 'Embeddings', sales: 1, amount_raw: '300000' },
  ],
  by_product_other: { products: 0, sales: 0, amount_raw: '0' },
  by_payer: [
    { payer: CONTACT, payments: 2, amount_raw: '1140000', last_paid_at: '2026-11-17T14:05:00.000Z' },
    { payer: WALLET, payments: 1, amount_raw: '700000', last_paid_at: '2026-11-17T13:48:00.000Z' },
    { payer: OTHER_USERS_AGENT, payments: 1, amount_raw: '300000', last_paid_at: '2026-11-16T09:00:00.000Z' },
  ],
  by_payer_other: { payers: 0, payments: 0, amount_raw: '0' },
  unattributed: { payments: 0, amount_raw: '0' },
  by_day: [
    { day: '2026-11-16', payments: 2, sales: 2, revenue_raw: '1140000', in_stripe_raw: '0' },
    { day: '2026-11-17', payments: 2, sales: 1, revenue_raw: '1000000', in_stripe_raw: '0' },
  ],
  received_in_stripe: { count: 0, amount_raw: '0' },
}

const PREVIOUS_SUMMARY = { ...SUMMARY, revenue_raw: '1070000' }

const PAYMENTS = [
  { tx_hash: '0xa1', block_time: '2026-11-17T14:05:00.000Z', kind: 'sale', amount_raw: '420000', product_id: 'chat', product_label: 'Chat completion', payer: CONTACT, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
  { tx_hash: '0xa2', block_time: '2026-11-17T13:48:00.000Z', kind: 'no_product', amount_raw: '1000000', product_id: null, product_label: null, payer: WALLET, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
  { tx_hash: '0xa3', block_time: '2026-11-16T10:00:00.000Z', kind: 'own_move', amount_raw: '500000', product_id: null, product_label: null, payer: OWN, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
  { tx_hash: '0xa4', block_time: '2026-11-16T09:30:00.000Z', kind: 'sale', amount_raw: '420000', product_id: 'chat', product_label: 'Chat completion', payer: CONTACT, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
  { tx_hash: '0xa5', block_time: '2026-11-16T09:00:00.000Z', kind: 'sale', amount_raw: '300000', product_id: 'embed', product_label: 'Embeddings', payer: OTHER_USERS_AGENT, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'account' },
]

/**
 * #4954, #4981: the same period plus two sales received at a registered
 * Stripe deposit address ($0.01 + $0.02 of "Joke", payer WALLET). They count
 * in EVERY figure — Revenue $2.17, 5 sales + 1 with no product = 6 payments,
 * the chart, both breakdowns — and are split out as "in Stripe":
 * `revenue_in_account_raw` + `received_in_stripe` = `revenue_raw`, and the
 * day they landed on carries `in_stripe_raw`.
 */
const STRIPE_ADDRESS = '0x3c9e5a1b7d2f4e60a8b1c3d5e7f9a0b2c4d6e8f0'
const STRIPE_SUMMARY = {
  ...SUMMARY,
  revenue_raw: '2170000',
  revenue_in_account_raw: '2140000',
  sales: 5,
  // 2170000 / 6, rounded down.
  average_sale_raw: '361666',
  by_product: [...SUMMARY.by_product, { product_id: 'joke', label: 'Joke', sales: 2, amount_raw: '30000' }],
  by_payer: [
    SUMMARY.by_payer[0],
    { ...SUMMARY.by_payer[1], payments: 3, amount_raw: '730000' },
    SUMMARY.by_payer[2],
  ],
  by_day: [
    SUMMARY.by_day[0],
    { day: '2026-11-17', payments: 4, sales: 3, revenue_raw: '1030000', in_stripe_raw: '30000' },
  ],
  received_in_stripe: { count: 2, amount_raw: '30000' },
}
const STRIPE_PAYMENTS = [
  { tx_hash: '0x' + 'b1'.repeat(32), block_time: '2026-11-17T15:00:00.000Z', kind: 'sale', amount_raw: '10000', product_id: 'joke', product_label: 'Joke', payer: WALLET, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'stripe', receiving_address: STRIPE_ADDRESS },
  { tx_hash: '0x' + 'b2'.repeat(32), block_time: '2026-11-17T14:30:00.000Z', kind: 'sale', amount_raw: '20000', product_id: 'joke', product_label: 'Joke', payer: WALLET, several_payers: false, receipt_number: null, vat_treatment: null, held_by: 'stripe', receiving_address: STRIPE_ADDRESS },
  ...PAYMENTS,
]

/** The catalogue the page reads once: no kit address saved unless a test says otherwise. */
const NO_KIT = {
  deployment_url: null,
  last_read_at: null,
  last_read_status: 'never',
  last_read_detail: null,
  mismatch: false,
  mismatch_reason: null,
  document_name: null,
  document_operator_name: null,
  document_network: null,
  document_pay_to: null,
  document_updated: null,
  products: [],
}

interface Scenario {
  catalogue?: unknown
  everPaid?: boolean
  summary?: unknown
  previous?: unknown
  pages?: Array<{ payments: unknown[]; next_cursor: string | null; total?: number }>
  /** The answer to a FILTERED read (#4960): any read carrying a filter parameter gets it. */
  filtered?: { summary: unknown; payments: unknown[] }
}

/** #4960: the period's facets — every product and payer, unfiltered. */
const FACETS = {
  products: [
    { product_id: 'chat', label: 'Chat completion' },
    { product_id: 'embed', label: 'Embeddings' },
  ],
  payers: [CONTACT, WALLET, OTHER_USERS_AGENT, OWN],
}

const FILTER_KEYS = ['kind', 'product_id', 'payer', 'q']
const isFiltered = (url: URL) => FILTER_KEYS.some((k) => url.searchParams.has(k))

/** Serve the reads: the whole-history probe, the two summaries and the pages. */
function serve({ everPaid = true, summary = SUMMARY, previous = PREVIOUS_SUMMARY, pages, catalogue = NO_KIT, filtered }: Scenario = {}) {
  const today = salesDayRange({ preset: '30d' })
  const prior = previousSalesRange(today)
  const queue = pages ?? [{ payments: PAYMENTS, next_cursor: null }]
  mockGet.mockImplementation(async (path: string) => {
    const url = new URL(path, 'http://x')
    if (url.pathname === '/merchant-sales/summary') {
      if (filtered && isFiltered(url)) return filtered.summary
      return url.searchParams.get('to') === prior.to ? previous : summary
    }
    if (url.pathname === '/merchant-sales/facets') return FACETS
    if (url.pathname === '/merchant-catalogue') return catalogue
    if (url.pathname === '/merchant-keys') return { keys: [] }
    const detailMatch = /^\/merchant-sales\/payments\/(0x[^/]+)$/.exec(url.pathname)
    if (detailMatch) {
      const row = STRIPE_PAYMENTS.find((p) => p.tx_hash === detailMatch[1])
      return { ...row, merchant_reference: null, legs: [] }
    }
    if (url.pathname === '/merchant-sales/payments') {
      if (!url.searchParams.has('from')) {
        return { payments: everPaid ? [PAYMENTS[0]] : [], next_cursor: null, total: everPaid ? 1 : 0 }
      }
      if (filtered && isFiltered(url)) {
        return { payments: filtered.payments, next_cursor: null, total: filtered.payments.length }
      }
      const cursor = url.searchParams.get('cursor')
      const index = cursor === null ? 0 : Number(cursor.replace('c', ''))
      const total = queue.reduce((n, page) => n + page.payments.length, 0)
      return { total, ...queue[index] }
    }
    throw new Error(`unexpected read ${path}`)
  })
}

const callsTo = (fragment: string) => mockGet.mock.calls.map((c) => String(c[0])).filter((p) => p.includes(fragment))

/** The page's own rate and a different one on the payments pages: the Overview must use the summary's. */
// usd is far from 1 on purpose: a USD figure that read it would show (#4963 review).
const SUMMARY_RATES = { usd: 0.5, eur: 0.92, sek: 10 }
const PAGE_RATES = { usd: 0.5, eur: 0.5, sek: 99 }

async function renderPage() {
  // #4983: the Setup tab now mounts the Stripe deposit addresses, which read
  // the message catalog and the toast surface — the shell provides both.
  render(
    <LocaleProvider>
      <ToastProvider>
        <SalesClient />
      </ToastProvider>
    </LocaleProvider>,
  )
  await screen.findByTestId('sales-page')
}

beforeEach(() => {
  mockGet.mockReset()
  mockDelete.mockReset()
  mockReplace.mockReset()
  mockNotFound.mockClear()
  mockCurrency.mockReturnValue('USD')
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
    // #4985: the seller is introduced before any other use of the word.
    expect(within(steps).getByTestId('seller-definition').textContent).toContain('you run a seller')
    expect(within(steps).getByText('Put your receiving address in your seller')).toBeTruthy()
    expect(within(steps).getByText('Create a Sales key')).toBeTruthy()
    expect(within(steps).getByText('Add your product list (optional)')).toBeTruthy()
    // Step 2 (#4905) links to the keys on the Setup tab as a ghost action;
    // step 1's address is the one primary action; step 3 goes to the Setup tab.
    expect(within(steps).getByRole('link', { name: 'Go to Sales keys' }).getAttribute('href')).toBe('/sales?tab=setup#sales-keys')
    expect(within(steps).queryByText(/is coming/)).toBeNull()
    expect(within(steps).getByRole('link', { name: 'Add product list address' }).getAttribute('href')).toBe('/sales?tab=setup#kit-address')
    // #4985: no step is done without an observation, and the count says so.
    expect((await within(steps).findByTestId('sales-first-run-count')).textContent).toBe('0 of 3 done')
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
  it('leaves the payer foot off when a payment has no single payer', async () => {
    serve({
      summary: {
        ...SUMMARY,
        by_payer: [{ payer: CONTACT, payments: 2, amount_raw: '840000' }],
        unattributed: { payments: 2, amount_raw: '1300000' },
      },
    })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('4')
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).not.toContain('payers')
  })

  it('counts payers from the lines and the folded Other payers', async () => {
    serve({
      summary: {
        ...SUMMARY,
        by_payer: [{ payer: CONTACT, payments: 2, amount_raw: '840000' }],
        by_payer_other: { payers: 4, payments: 2, amount_raw: '1300000' },
      },
    })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('from 5 payers')
  })

  it('shows tiles that agree with the breakdowns and the list', async () => {
    serve()
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toContain('$2.14')
    // Sales counts every revenue payment (3 sales + 1 with no product), and
    // the average is revenue over that count: $2.14 / 4.
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('4')
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('from 3 payers')
    expect(within(tiles).getByTestId('stat-tile-average-sale').textContent).toContain('$0.54')
    expect(within(tiles).getByTestId('stat-tile-average-sale').textContent).toContain('per payment')
    expect(within(tiles).getByTestId('stat-tile-without-a-product').textContent).toContain('1')

    // By product: the lines add up to the Revenue tile ($0.84 + $0.30 + $1.00).
    const byProduct = screen.getByTestId('sales-by-product')
    for (const text of ['Chat completion', 'Embeddings', 'No product', '$0.84', '$0.30', '$1.00']) {
      expect(within(byProduct).getAllByText(text).length).toBeGreaterThan(0)
    }
    // The No product line counts payments, not sales.
    expect(byProduct.textContent).toContain('1 payment')
    expect(byProduct.textContent).not.toMatch(/No product[^$]*1 sale/)
    // By payer: the lines add up to it too ($1.14 + $0.70 + $0.30).
    const byPayer = screen.getByTestId('sales-by-payer')
    for (const text of ['$1.14', '$0.70', '$0.30']) {
      expect(within(byPayer).getAllByText(text).length).toBeGreaterThan(0)
    }

    // The list: its summary line is the SAME count and revenue as the tiles
    // (3 sales + 1 no product + 1 own move listed; revenue never includes the move).
    const summaryLine = await screen.findByTestId('sales-payments-summary')
    expect((await screen.findByTestId('list-toolbar-count')).textContent).toContain('5 payments')
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

  it('has the search, the Product, Payer and Recorded facets, and a Last paid column (#4960)', async () => {
    serve()
    await renderPage()
    await screen.findByTestId('sales-tiles')
    const payments = screen.getByTestId('sales-payments')
    expect(within(payments).getByPlaceholderText('Search payments')).toBeTruthy()
    const facets = within(payments).getByTestId('list-toolbar-facets')
    for (const label of ['Product', 'Payer', 'Recorded']) {
      expect(within(facets).getByRole('button', { name: new RegExp(label) })).toBeTruthy()
    }
    const byPayer = screen.getByTestId('sales-by-payer')
    expect(within(byPayer).getAllByText('Last paid').length).toBeGreaterThan(0)
    expect(within(byPayer).getAllByTestId('breakdown-last-paid-cell')).toHaveLength(SUMMARY.by_payer.length)
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

describe('the display currency (#4963)', () => {
  const withRates = (usdc_rates: unknown) => ({ ...SUMMARY, usdc_rates })

  it('reads every Overview figure in SEK from the summary rate, with "≈" on the two totals only', async () => {
    mockCurrency.mockReturnValue('SEK')
    serve({
      summary: withRates(SUMMARY_RATES),
      // A different rate on the payments page: the rows must still use the summary's.
      pages: [{ payments: PAYMENTS, next_cursor: null, usdc_rates: PAGE_RATES } as never],
    })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    const fmt = (v: number) => new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK' }).format(v)
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toContain(`≈${fmt(21.4)}`)
    expect(within(tiles).getByTestId('stat-tile-average-sale').textContent).toContain(`≈${fmt(5.35)}`)
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).not.toContain('USDC')

    const byProduct = screen.getByTestId('sales-by-product')
    expect(byProduct.textContent).toContain(fmt(8.4))
    expect(byProduct.textContent).not.toContain('≈')
    expect(screen.getByTestId('sales-by-payer').textContent).not.toContain('≈')

    // Rows: 0.42 USDC * 10 (the summary's rate), not * 99 (the page's).
    const ledger = screen.getAllByTestId('sales-ledger')[0]
    expect(ledger.textContent).toContain(fmt(4.2))
    expect(ledger.textContent).not.toContain(fmt(41.58))
    expect(ledger.textContent).not.toContain('≈')
    // The list's summary line is a total: it carries "≈" like the Revenue tile (design review).
    expect(screen.getByTestId('sales-payments-summary').textContent).toContain(`Revenue ≈${fmt(21.4)}`)
    // The delta chip uses the figure's decimal comma, not "+100.0%".
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toContain('+100,0')
  })

  it('strikes the chart axis in SEK at the summary rate, matching its values (#4963 review)', async () => {
    mockCurrency.mockReturnValue('SEK')
    serve({ summary: withRates(SUMMARY_RATES) })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    const ticks = screen.getAllByTestId('chart-tick-label').map((el) => el.textContent ?? '')
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) expect(tick).not.toContain('USDC')
    // The largest day is 1.14 USDC = 11,40 kr. Unconverted ticks topped out near
    // 1 kr; converted ones are on the kronor scale (the chart may draw its
    // tallest bar past the top tick, as it always has).
    const top = Math.max(...ticks.map((t) => Number(t.replace(/[^\d,]/g, '').replace(',', '.'))))
    expect(top).toBeGreaterThanOrEqual(5)
    // ...and drawn at the summary's 10, not the page's 99 (ticks near 100 kr).
    expect(top).toBeLessThanOrEqual(20)
    // The values on the same chart: 1.14 USDC at 10 = 11,40 kr, converted once.
    const fmt = (v: number) => new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK' }).format(v)
    const table = screen.getAllByTestId('chart-data-table')[0].textContent ?? ''
    expect(table).toContain(fmt(11.4))
    expect(table).not.toContain(fmt(114))
  })

  it('reads in EUR from the eur rate', async () => {
    mockCurrency.mockReturnValue('EUR')
    serve({ summary: withRates(SUMMARY_RATES) })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(2.14 * 0.92)
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toContain(`≈${eur}`)
  })

  it('keeps USD exact and unmarked, never reading the usd rate', async () => {
    serve({ summary: withRates(SUMMARY_RATES) })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toContain('$2.14')
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).not.toContain('≈')
    expect(within(tiles).getByTestId('stat-tile-average-sale').textContent).not.toContain('≈')
  })

  it('reads in USDC when the currency has no rate', async () => {
    mockCurrency.mockReturnValue('SEK')
    serve({ summary: withRates({ usd: 0.9998, eur: 0.92, sek: null }) })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    // #5105: in USDC mode the unit sits in the tile's unit slot, its own element.
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toMatch(/2\.14\s*USDC/)
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).not.toContain('≈')
  })

  it('reads in USDC when the whole rate read failed (null) or the field is missing (older backend)', async () => {
    mockCurrency.mockReturnValue('SEK')
    for (const summary of [withRates(null), SUMMARY]) {
      serve({ summary })
      const view = render(<SalesClient />)
      const tiles = await screen.findByTestId('sales-tiles')
      // #5105: in USDC mode the unit sits in the tile's unit slot, its own element.
      expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toMatch(/2\.14\s*USDC/)
      view.unmount()
    }
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

  it('says, in one sentence, that one buyer can appear as more than one wallet (#5088), without naming Haven', async () => {
    serve()
    await renderPage()
    const byPayer = await screen.findByTestId('sales-by-payer')
    const sentence = 'A payer is the address the money came from, so one buyer can appear as more than one wallet.'
    expect(BY_PAYER_DESCRIPTION).toBe(
      `Who paid. ${sentence} Only your contacts and your own agents and accounts are named.`,
    )
    expect(byPayer.textContent).toContain(sentence)
  })

  it('the Revenue tile and the Payments summary show a sum’s sub-cent part (#5088): 0.0135 is $0.0135', async () => {
    serve({
      summary: {
        ...SUMMARY,
        revenue_raw: '13500',
        revenue_in_account_raw: '3500',
        received_in_stripe: { count: 1, amount_raw: '10000' },
      },
    })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    expect(within(tiles).getByText('$0.0135')).toBeTruthy()
    expect(within(tiles).getByText('$0.0035 in Haven · $0.01 in Stripe')).toBeTruthy()
    const summaryLine = await screen.findByTestId('sales-payments-summary')
    expect(summaryLine.textContent).toBe('Revenue $0.0135 ($0.0035 in Haven · $0.01 in Stripe)')
  })

  it("shows a payer row's sub-cent part (#5088): 0.011 is $0.0110, 0.0025 stays $0.0025", async () => {
    serve({
      summary: {
        ...SUMMARY,
        by_payer: [
          { payer: { address: '0x02cA3aD5D6DCd8A83261db0052Cd1BBCF6b371FD', kind: 'wallet', name: null }, payments: 2, amount_raw: '11000', last_paid_at: '2026-11-17T10:00:00.000Z' },
          { payer: { address: '0x98ffBf30459a98FD80fAce18f519967769641F76', kind: 'wallet', name: null }, payments: 1, amount_raw: '2500', last_paid_at: '2026-11-17T09:00:00.000Z' },
        ],
      },
    })
    await renderPage()
    const byPayer = await screen.findByTestId('sales-by-payer')
    expect(within(byPayer).getAllByText('$0.0110').length).toBeGreaterThan(0)
    expect(within(byPayer).getAllByText('$0.0025').length).toBeGreaterThan(0)
  })

  it('every other revenue sum shows its sub-cent part too (#5088): product, Other, no product, Other payers, Several payers, the chart', async () => {
    serve({
      summary: {
        ...SUMMARY,
        revenue_raw: '13500',
        revenue_in_account_raw: '13500',
        by_product: [{ product_id: 'chat', label: 'Chat completion', sales: 2, amount_raw: '6100' }],
        by_product_other: { products: 2, sales: 2, amount_raw: '7200' },
        without_product: { count: 1, amount_raw: '16500' },
        by_payer_other: { payers: 2, payments: 2, amount_raw: '6300' },
        unattributed: { payments: 1, amount_raw: '7400' },
      },
    })
    await renderPage()
    const byProduct = await screen.findByTestId('sales-by-product')
    for (const figure of ['$0.0061', '$0.0072', '$0.0165']) expect(byProduct.textContent).toContain(figure)
    const byPayer = screen.getByTestId('sales-by-payer')
    for (const figure of ['$0.0063', '$0.0074']) expect(byPayer.textContent).toContain(figure)
    const chart = screen.getAllByRole('img', { name: /Revenue over 30 days/ })[0]
    expect(chart.getAttribute('aria-label')).toContain('$0.0135 from')
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
    expect(row.textContent).toMatch(/Atlas.*Sales/)
    expect(within(row).getByText('Not counted')).toBeTruthy()
    expect(row.textContent).toContain('$0.50')
    expect(row.textContent).not.toContain('+$0.50')
    // A sale IS signed as income.
    const sale = (await screen.findAllByText('Embeddings')).map((el) => el.closest('[role="button"]')).find(Boolean) as HTMLElement
    expect(sale.textContent).toContain('+$0.30')
  })

  it('shows no Stripe mark, tile or line for a period with no sale received in Stripe (#4954)', async () => {
    serve()
    await renderPage()
    await screen.findByText('Moved between your accounts')
    expect(screen.queryByText(/stripe/i)).toBeNull()
    expect(screen.queryByTestId('sales-stripe-tile')).toBeNull()
  })

  it('opens the payment panel for the row that was pressed', async () => {
    serve()
    await renderPage()
    const row = (await screen.findByText('No product recorded')).closest('[role="button"]') as HTMLElement
    expect(screen.queryByRole('dialog', { name: 'No product recorded' })).toBeNull()
    await userEvent.click(row)
    // The panel reads the payment that was pressed, by its hash.
    expect(await screen.findByRole('dialog', { name: 'No product recorded' })).toBeTruthy()
    expect(callsTo('/merchant-sales/payments/0xa2')).toHaveLength(1)
  })

  it('clearing a sale record refreshes the list and the summary under the panel', async () => {
    serve()
    mockDelete.mockResolvedValue(undefined)
    await renderPage()
    const row = within(await screen.findByTestId('sales-ledger')).getAllByText('Chat completion')[0].closest('[role="button"]') as HTMLElement
    await userEvent.click(row)
    await userEvent.click(await screen.findByRole('button', { name: 'Clear sale record' }))
    const summaryReads = callsTo('/merchant-sales/summary').length
    const listReads = callsTo('/merchant-sales/payments?').length
    await userEvent.click(screen.getByRole('button', { name: 'Clear record' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/merchant-sales/payments/0xa1/record'))
    await waitFor(() => expect(callsTo('/merchant-sales/summary').length).toBeGreaterThan(summaryReads))
    await waitFor(() => expect(callsTo('/merchant-sales/payments?').length).toBeGreaterThan(listReads))
    await screen.findByTestId('sales-tiles')
  })

  it('the leaked-key notice in the clear dialog closes the panel and opens the Setup tab', async () => {
    serve()
    await renderPage()
    const row = within(await screen.findByTestId('sales-ledger')).getAllByText('Chat completion')[0].closest('[role="button"]') as HTMLElement
    await userEvent.click(row)
    await userEvent.click(await screen.findByRole('button', { name: 'Clear sale record' }))
    await userEvent.click(screen.getByRole('button', { name: 'Sales keys' }))
    // The page goes to the Setup tab (the URL holds the tab), and both the
    // confirmation and the panel are closed.
    expect(mockReplace).toHaveBeenCalledWith('/sales?tab=setup', { scroll: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockDelete).not.toHaveBeenCalled()
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

  it('counts the products on the tab and flags Products and Setup when the kit could not be read', async () => {
    serve({
      catalogue: {
        ...NO_KIT,
        deployment_url: 'https://inference.example.com',
        last_read_at: '2026-11-17T10:00:00.000Z',
        last_read_status: 'unreachable',
        products: [
          { product_id: 'chat', name: 'Chat completion', description: null, route: null, model: null, price_atomic: '18000', network: 'eip155:8453', output_token_cap: null, offered: true, removed_at: null },
          { product_id: 'embed', name: 'Embeddings', description: null, route: null, model: null, price_atomic: '100', network: 'eip155:8453', output_token_cap: null, offered: true, removed_at: null },
        ],
      },
    })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    const products = await screen.findByRole('tab', { name: /^Products/ })
    await waitFor(() => expect(products.textContent).toContain('2'))
    expect(products.textContent).toMatch(/needs attention|attention/i)
    expect(screen.getByRole('tab', { name: /^Setup/ }).textContent).toMatch(/attention/i)
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

describe('sales received in Stripe (#4954, #4981)', () => {
  const stripeServe = (summary: unknown = STRIPE_SUMMARY, previous: unknown = PREVIOUS_SUMMARY) =>
    serve({ summary, previous, pages: [{ payments: STRIPE_PAYMENTS, next_cursor: null }] })

  it('counts a Stripe sale in every tile, in one row of four, and says where it was received', async () => {
    stripeServe()
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    // Four tiles, one grid, and no tile of its own for Stripe.
    expect(within(tiles).getAllByTestId(/^stat-tile-/)).toHaveLength(4)
    expect(screen.queryByTestId('sales-stripe-tile')).toBeNull()
    expect(screen.queryByText(/not in Revenue/)).toBeNull()
    // Revenue is the total ($2.14 + $0.03) with the split in its foot.
    const revenue = within(tiles).getByTestId('stat-tile-revenue')
    expect(revenue.textContent).toContain('$2.17')
    expect(revenue.textContent).toContain('$2.14 in Haven · $0.03 in Stripe')
    // Sales counts every sale and payment (5 sales + 1 with no product).
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('6')
    expect(within(tiles).getByTestId('stat-tile-sales').textContent).toContain('from 3 payers')
    // Average is the read's own figure: $2.17 / 6.
    expect(within(tiles).getByTestId('stat-tile-average-sale').textContent).toContain('$0.36')
    expect(within(tiles).getByTestId('stat-tile-without-a-product').textContent).toContain('1')
    // Never reads as a balance.
    expect(tiles.textContent).not.toMatch(/balance/i)
  })

  it('keeps the previous-period chip beside the split foot, on the new definition', async () => {
    stripeServe()
    await renderPage()
    const revenue = await screen.findByTestId('stat-tile-revenue')
    // ($2.17 - $1.07) / $1.07
    await waitFor(() => expect(revenue.textContent).toContain('+102.8%'))
    expect(revenue.textContent).toContain('vs the 30 days before')
    expect(revenue.textContent).toContain('in Stripe')
  })

  it('lets the split foot take the slot the "no sales before" line would have', async () => {
    stripeServe(STRIPE_SUMMARY, { ...SUMMARY, revenue_raw: '0' })
    await renderPage()
    const revenue = await screen.findByTestId('stat-tile-revenue')
    await waitFor(() => expect(revenue.textContent).toContain('in Stripe'))
    expect(revenue.textContent).not.toContain('No sales in the')
    expect(revenue.textContent).not.toContain('%')
  })

  it('keeps today\'s footnote without a Stripe sale', async () => {
    serve({ previous: { ...SUMMARY, revenue_raw: '0' } })
    await renderPage()
    const revenue = await screen.findByTestId('stat-tile-revenue')
    await waitFor(() => expect(revenue.textContent).toContain('No sales in the 30 days before'))
    expect(revenue.textContent).not.toContain('in Stripe')
  })

  it('includes the Stripe sales in By product and By payer, so each adds up to Revenue', async () => {
    stripeServe()
    await renderPage()
    const byProduct = await screen.findByTestId('sales-by-product')
    expect(byProduct.textContent).toContain('Joke')
    expect(byProduct.textContent).toContain('$0.03')
    const byPayer = screen.getByTestId('sales-by-payer')
    // The wallet's $0.70 plus the two $0.03 Stripe payments' $0.03.
    expect(byPayer.textContent).toContain('$0.73')
  })

  it('draws two series, In Haven and In Stripe, and drops the zero segment', async () => {
    stripeServe()
    await renderPage()
    const table = (await screen.findAllByTestId('chart-data-table'))[0]
    expect(within(table).getByRole('columnheader', { name: 'In Haven' })).toBeTruthy()
    expect(within(table).getByRole('columnheader', { name: 'In Stripe' })).toBeTruthy()
    expect(within(table).queryByRole('columnheader', { name: 'Revenue' })).toBeNull()
    // The 17th: $1.00 in Haven and $0.03 in Stripe; the 16th has no Stripe segment.
    expect(table.textContent).toContain('$0.03')
    expect(table.textContent).toContain('$1.00')
    // The chart's accessible name still names the total and the count.
    const chart = screen.getAllByRole('img', { name: /Revenue over 30 days/ })[0]
    expect(chart.getAttribute('aria-label')).toContain('$2.17 from 6 payments')
  })

  it('draws one Revenue series when the period has no Stripe sale', async () => {
    serve()
    await renderPage()
    const table = (await screen.findAllByTestId('chart-data-table'))[0]
    expect(within(table).getByRole('columnheader', { name: 'Revenue' })).toBeTruthy()
    expect(within(table).queryByRole('columnheader', { name: 'In Haven' })).toBeNull()
  })

  it('counts both kinds in the list line, with the split beside the total', async () => {
    stripeServe()
    await renderPage()
    const line = await screen.findByTestId('sales-payments-summary')
    // 5 account payments + 2 Stripe sales.
    expect((await screen.findByTestId('list-toolbar-count')).textContent).toContain('7 payments')
    expect(line.textContent).toContain('Revenue $2.17 ($2.14 in Haven · $0.03 in Stripe)')
    expect(screen.getByTestId('sales-payments').textContent).toContain('not in Transactions')
  })

  it('splits in SEK at the summary rate, with "≈" on the total and its parts', async () => {
    mockCurrency.mockReturnValue('SEK')
    stripeServe({ ...STRIPE_SUMMARY, usdc_rates: SUMMARY_RATES })
    await renderPage()
    const fmt = (v: number) => new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK' }).format(v)
    const revenue = await screen.findByTestId('stat-tile-revenue')
    expect(revenue.textContent).toContain(`≈${fmt(21.7)}`)
    expect(revenue.textContent).toContain(`≈${fmt(21.4)} in Haven · ≈${fmt(0.3)} in Stripe`)
    const line = screen.getByTestId('sales-payments-summary')
    expect(line.textContent).toContain(`Revenue ≈${fmt(21.7)} (≈${fmt(21.4)} in Haven · ≈${fmt(0.3)} in Stripe)`)
    const table = screen.getAllByTestId('chart-data-table')[0].textContent ?? ''
    expect(table).toContain(fmt(0.3))
  })

  it('marks the Stripe rows, and only them', async () => {
    stripeServe()
    await renderPage()
    const ledger = await screen.findByTestId('sales-ledger')
    const marks = within(ledger).getAllByText('Received in Stripe')
    expect(marks).toHaveLength(2)
    for (const mark of marks) {
      expect(mark.closest('[role="button"]')?.textContent).toContain('Joke')
    }
  })

  it('is not the empty state when the period has only Stripe sales, and still shows four tiles', async () => {
    const stripeOnly = {
      ...SUMMARY,
      revenue_raw: '30000',
      revenue_in_account_raw: '0',
      sales: 2,
      average_sale_raw: '15000',
      without_product: zero,
      own_moves: zero,
      by_product: [{ product_id: 'joke', label: 'Joke', sales: 2, amount_raw: '30000' }],
      by_payer: [{ payer: WALLET, payments: 2, amount_raw: '30000', last_paid_at: '2026-11-17T15:00:00.000Z' }],
      by_day: [{ day: '2026-11-17', payments: 2, sales: 2, revenue_raw: '30000', in_stripe_raw: '30000' }],
      received_in_stripe: { count: 2, amount_raw: '30000' },
    }
    serve({ summary: stripeOnly, pages: [{ payments: STRIPE_PAYMENTS.slice(0, 2), next_cursor: null }] })
    await renderPage()
    const tiles = await screen.findByTestId('sales-tiles')
    expect(within(tiles).getAllByTestId(/^stat-tile-/)).toHaveLength(4)
    expect(within(tiles).getByTestId('stat-tile-revenue').textContent).toContain('$0.00 in Haven · $0.03 in Stripe')
    expect(screen.queryByTestId('sales-stripe-tile')).toBeNull()
    expect(screen.queryByTestId('sales-empty-period')).toBeNull()
  })

  it('shows the payment into the deposit address in the detail, with its hash and no account', async () => {
    stripeServe()
    await renderPage()
    const row = within(await screen.findByTestId('sales-ledger')).getAllByText('Joke')[0].closest('[role="button"]') as HTMLElement
    await userEvent.click(row)
    const panel = await screen.findByRole('dialog', { name: 'Joke' })
    const header = within(panel).getByTestId('sales-payment-header')
    expect(within(header).getByText('Received in Stripe')).toBeTruthy()
    expect(header.textContent).toContain('to your Stripe address')
    // The sale counts in revenue; it is not in the account's balance (#4981).
    expect(panel.textContent).toContain('It counts in your revenue, but not in any Haven balance')
    expect(panel.textContent).not.toContain('not in your revenue')
    // The who-line names the Stripe address, never "Paid … into Sales".
    expect(header.textContent).not.toMatch(/Paid by[^·]*into Sales/)
    expect(within(panel).getByTestId('sales-payment-details').textContent).toContain('Your Stripe deposit address')
    const technical = within(panel).getByTestId('sales-payment-technical')
    expect(technical.querySelector(`[title="${STRIPE_ADDRESS}"]`)).not.toBeNull()
    expect(technical.querySelector(`[title="${STRIPE_PAYMENTS[0].tx_hash}"]`)).not.toBeNull()
    // The Sales account is not where this sale went.
    expect(technical.querySelector(`[title="${SALES_ACCOUNT.account_address}"]`)).toBeNull()
    expect(within(panel).getByRole('link', { name: /View on explorer/ })).toBeTruthy()
  })

  it('says clearing a Stripe sale removes it from the page, and closes the panel after', async () => {
    stripeServe()
    mockDelete.mockResolvedValue(undefined)
    await renderPage()
    const row = within(await screen.findByTestId('sales-ledger')).getAllByText('Joke')[0].closest('[role="button"]') as HTMLElement
    await userEvent.click(row)
    await userEvent.click(await screen.findByRole('button', { name: 'Clear sale record' }))
    const confirm = screen.getByRole('dialog', { name: 'Clear this sale record?' })
    expect(confirm.textContent).toContain('it leaves this page')
    expect(confirm.textContent).not.toContain('The payment stays')
    await userEvent.click(screen.getByRole('button', { name: 'Clear record' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(`/merchant-sales/payments/${STRIPE_PAYMENTS[0].tx_hash}/record`))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Joke' })).toBeNull())
  })
})

describe('filters and search (#4960)', () => {
  /** The period narrowed to the chat product: 2 sales of $0.42 from the contact. */
  const CHAT_SUMMARY = {
    ...SUMMARY,
    revenue_raw: '840000',
    sales: 2,
    revenue_in_account_raw: '840000',
    average_sale_raw: '420000',
    without_product: zero,
    own_moves: zero,
    by_product: [{ product_id: 'chat', label: 'Chat completion', sales: 2, amount_raw: '840000' }],
    by_payer: [{ payer: CONTACT, payments: 2, amount_raw: '840000', last_paid_at: '2026-11-17T14:05:00.000Z' }],
    by_day: [
      { day: '2026-11-16', payments: 1, sales: 1, revenue_raw: '420000', in_stripe_raw: '0' },
      { day: '2026-11-17', payments: 1, sales: 1, revenue_raw: '420000', in_stripe_raw: '0' },
    ],
  }
  const CHAT_PAYMENTS = [PAYMENTS[0], PAYMENTS[3]]
  const EMPTY_SUMMARY = {
    ...SUMMARY,
    revenue_raw: '0',
    sales: 0,
    average_sale_raw: '0',
    without_product: zero,
    own_moves: zero,
    by_product: [],
    by_payer: [],
    by_day: [],
  }
  const params = (path: string) => new URL(path, 'http://x').searchParams

  it('sends ONE filter set to every read, and the tiles, chart, breakdowns and list all describe it', async () => {
    // Two Recorded values: every facet is multi-select, and both reach the reads.
    window.history.replaceState(null, '', '/sales?product=chat&recorded=sale,no_product')
    serve({ filtered: { summary: CHAT_SUMMARY, payments: CHAT_PAYMENTS } })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    await waitFor(() => expect(within(screen.getByTestId('sales-ledger')).getAllByText('Chat completion')).toHaveLength(2))

    // Every summary (this period AND the one it is compared with) and every
    // list page carries the same filters; the facets read and the first-run
    // probe carry none.
    const reads = [...callsTo('/merchant-sales/summary'), ...callsTo('/merchant-sales/payments?').filter((p) => params(p).has('from') && params(p).get('limit') !== '1')]
    expect(reads.length).toBeGreaterThanOrEqual(3)
    for (const path of reads) {
      expect(params(path).getAll('product_id'), path).toEqual(['chat'])
      expect(params(path).getAll('kind'), path).toEqual(['no_product', 'sale'])
    }
    for (const path of callsTo('/merchant-sales/facets')) expect([...params(path).keys()].sort()).toEqual(['from', 'to'])
    // The first-run probe (whole history, one row) is never filtered: a
    // filtered link that matches nothing is not an account never paid.
    const probes = callsTo('/merchant-sales/payments?').filter((p) => !params(p).has('from'))
    expect(probes.length).toBeGreaterThan(0)
    for (const path of probes) for (const key of FILTER_KEYS) expect(params(path).has(key), path).toBe(false)

    // The figures are the filtered summary's, and they agree with the rows.
    const tiles = screen.getByTestId('sales-tiles')
    expect(tiles.textContent).toContain('$0.84')
    expect(screen.getByTestId('sales-by-product').textContent).toContain('$0.84')
    expect(screen.getByTestId('sales-by-product').textContent).not.toContain('Embeddings')
    expect(screen.getByTestId('sales-by-payer').textContent).toContain('$0.84')
    expect(screen.getByTestId('sales-by-payer').textContent).not.toContain('Wallet')
    const rowsTotal = CHAT_PAYMENTS.reduce((n, p) => n + Number(p.amount_raw), 0)
    expect(rowsTotal).toBe(Number(CHAT_SUMMARY.revenue_raw))
    expect(screen.getByTestId('sales-payments-summary').textContent).toContain('Revenue $0.84')
    // "{shown} of {total}": the filtered list's total of the period's unfiltered one.
    await waitFor(() => expect(screen.getByTestId('list-toolbar-count').textContent).toContain('2 of 5 payments'))
  })

  it('lists every product and payer of the period in the facets, and does not shrink them to the value chosen', async () => {
    window.history.replaceState(null, '', '/sales?product=chat')
    serve({ filtered: { summary: CHAT_SUMMARY, payments: CHAT_PAYMENTS } })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    const facets = screen.getByTestId('list-toolbar-facets')

    await userEvent.click(within(facets).getByRole('button', { name: /Product/ }))
    let menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Chat completion/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Embeddings/ })).toBeTruthy()
    await userEvent.keyboard('{Escape}')

    await userEvent.click(within(facets).getByRole('button', { name: /Payer/ }))
    menu = await screen.findByRole('menu')
    const payerText = menu.textContent ?? ''
    // Named payers by name; every other payer as "Wallet" with a short address,
    // and nothing says a payer uses Haven.
    expect(payerText).toContain('Lumen Research')
    expect(payerText).toContain('Atlas')
    expect(within(menu).getAllByRole('menuitemcheckbox', { name: /^Wallet · 0x/ })).toHaveLength(2)
    expect(payerText).not.toMatch(/haven/i)
    await userEvent.keyboard('{Escape}')

    await userEvent.click(within(facets).getByRole('button', { name: /Recorded/ }))
    menu = await screen.findByRole('menu')
    for (const label of ['Sale', 'No product recorded', 'Moved between your accounts']) {
      expect(within(menu).getByRole('menuitemcheckbox', { name: new RegExp(`^${label}`) })).toBeTruthy()
    }
    expect(menu.textContent).not.toMatch(/no_product|own_move/)
  })

  it('shows the no-match state under the toolbar when a filter matches nothing, and Clear filters keeps the period', async () => {
    window.history.replaceState(null, '', '/sales?period=7d&recorded=own_move&q=zzz')
    serve({ filtered: { summary: EMPTY_SUMMARY, payments: [] } })
    await renderPage()
    const noMatch = await screen.findByTestId('sales-no-match')
    expect(noMatch.textContent).toContain('No payments match these filters')
    // The toolbar that set the filter is still there, and the period's empty state is not shown.
    expect(screen.getByPlaceholderText('Search payments')).toBeTruthy()
    expect(screen.queryByTestId('sales-empty-period')).toBeNull()

    mockGet.mockClear()
    await userEvent.click(within(noMatch).getByRole('button', { name: 'Clear filters' }))
    const seven = salesDayRange({ preset: '7d' })
    await waitFor(() => expect(callsTo('/merchant-sales/summary').length).toBeGreaterThan(0))
    for (const path of callsTo('/merchant-sales/summary')) {
      for (const key of ['kind', 'q', 'product_id', 'payer']) expect(params(path).has(key), path).toBe(false)
    }
    expect(callsTo('/merchant-sales/summary').some((p) => p.includes(`from=${seven.from}&to=${seven.to}`))).toBe(true)
  })

  it('sends no search shorter than two characters, and sends one once it is long enough', async () => {
    serve({ filtered: { summary: CHAT_SUMMARY, payments: CHAT_PAYMENTS } })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    const box = screen.getByPlaceholderText('Search payments')
    await userEvent.type(box, 'l{Enter}')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(callsTo('q=')).toEqual([])
    await userEvent.type(box, 'umen{Enter}')
    await waitFor(() => expect(callsTo('/merchant-sales/summary').some((p) => params(p).get('q') === 'lumen')).toBe(true))
  })

  it("prints By payer's Last paid in the viewer's clock: Today with the time, else the day and the time", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 17, 20, 0))
    try {
      serve({
        summary: {
          ...SUMMARY,
          by_payer: [
            { payer: CONTACT, payments: 2, amount_raw: '1140000', last_paid_at: new Date(2026, 10, 17, 14, 17).toISOString() },
            { payer: WALLET, payments: 1, amount_raw: '700000', last_paid_at: new Date(2026, 10, 12, 9, 10).toISOString() },
          ],
        },
      })
      await renderPage()
      const byPayer = await screen.findByTestId('sales-by-payer')
      expect(within(byPayer).getAllByTestId('breakdown-last-paid-cell').map((c) => c.textContent)).toEqual([
        'Today, 14:17',
        '12 Nov, 09:10',
      ])
      // Inside a sentence (the collapsed stand-in and the phone line) "today" is lower case.
      expect(byPayer.textContent).toContain('Last paid today, 14:17')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps focus in the search box when the search is cleared and the figures reload unfiltered', async () => {
    serve({ filtered: { summary: CHAT_SUMMARY, payments: CHAT_PAYMENTS } })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    const box = screen.getByPlaceholderText('Search payments')
    await userEvent.type(box, 'lumen{Enter}')
    await waitFor(() => expect(callsTo('/merchant-sales/summary').some((p) => params(p).get('q') === 'lumen')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(screen.getByTestId('sales-tiles')).toBeTruthy())
    expect(screen.getByPlaceholderText('Search payments')).toBe(box)
    expect(document.activeElement).toBe(box)
    // And backspacing a term below two characters does not drop focus either.
    await userEvent.type(box, 'lu{Enter}')
    await waitFor(() => expect(callsTo('/merchant-sales/summary').some((p) => params(p).get('q') === 'lu')).toBe(true))
    await userEvent.type(box, '{Backspace}{Enter}')
    await waitFor(() => expect(screen.getByTestId('sales-tiles')).toBeTruthy())
    expect(document.activeElement).toBe(box)
  })

  it('debounces the search: a typed term makes one read per figure, not one per keystroke', async () => {
    serve({ filtered: { summary: CHAT_SUMMARY, payments: CHAT_PAYMENTS } })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    await userEvent.type(screen.getByPlaceholderText('Search payments'), 'lumen')
    const today = salesDayRange({ preset: '30d' })
    await waitFor(() =>
      expect(callsTo('/merchant-sales/summary').filter((p) => params(p).get('q') === 'lumen' && params(p).get('to') === today.to)).toHaveLength(1),
    )
    // No read for any prefix of the term.
    const prefixes = ['l', 'lu', 'lum', 'lume']
    expect(mockGet.mock.calls.map((c) => String(c[0])).filter((p) => prefixes.includes(params(p).get('q') ?? ''))).toEqual([])
  })

  it('reads the facets and the filtered figures again after a sale record is cleared', async () => {
    window.history.replaceState(null, '', '/sales?product=chat')
    serve({ filtered: { summary: CHAT_SUMMARY, payments: CHAT_PAYMENTS } })
    mockDelete.mockResolvedValue(undefined)
    await renderPage()
    const row = within(await screen.findByTestId('sales-ledger')).getAllByText('Chat completion')[0].closest('[role="button"]') as HTMLElement
    await userEvent.click(row)
    await userEvent.click(await screen.findByRole('button', { name: 'Clear sale record' }))
    const facetReads = callsTo('/merchant-sales/facets').length
    mockGet.mock.calls.length = 0
    await userEvent.click(screen.getByRole('button', { name: 'Clear record' }))
    await waitFor(() => expect(callsTo('/merchant-sales/summary').length).toBeGreaterThan(0))
    for (const path of callsTo('/merchant-sales/summary')) expect(params(path).getAll('product_id'), path).toEqual(['chat'])
    await waitFor(() => expect(callsTo('/merchant-sales/facets').length).toBeGreaterThan(0))
    expect(facetReads).toBeGreaterThan(0)
  })

  it('says so when the filter options cannot load, and the search still works', async () => {
    serve()
    const served = mockGet.getMockImplementation()!
    mockGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/merchant-sales/facets')) throw new Error('500')
      return served(path)
    })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    expect((await screen.findByTestId('sales-facets-error')).textContent).toContain('could not load')
    expect(screen.getByPlaceholderText('Search payments')).toBeTruthy()
  })

  it('keeps a product id with a comma whole from the URL to the reads', async () => {
    const id = 'pro,annual'
    window.history.replaceState(null, '', `/sales?product=${encodeURIComponent(productFacetValue(id))}`)
    serve({ filtered: { summary: CHAT_SUMMARY, payments: CHAT_PAYMENTS } })
    await renderPage()
    await screen.findByTestId('sales-tiles')
    await waitFor(() => expect(callsTo('/merchant-sales/summary').length).toBeGreaterThan(0))
    for (const path of callsTo('/merchant-sales/summary')) expect(params(path).getAll('product_id'), path).toEqual([id])
  })
})

