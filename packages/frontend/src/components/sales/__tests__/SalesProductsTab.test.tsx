import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sales Products tab (#4900, epic #4885): the catalogue read, in every
 * state the read can be in. The page owns the one catalogue read, so the tab
 * is rendered with the hook's result as the page hands it over; the summary
 * read (sales per product) is mocked at `api.get`.
 */

const mockGet = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (path: string) => mockGet(path) },
}))

vi.mock('@/context/MerchantServicesContext', () => ({
  useMerchantServicesContext: () => ({
    merchantAccount: { id: 'a', account_address: '0x7Ac3E19b5D0F42c86e1A93b7f0D5c2E48b916Fd2', chain_id: 8453, name: 'Sales', created_at: '' },
  }),
}))

import type { UseMerchantCatalogueResult } from '@/hooks/useMerchantCatalogue'
import { mismatchText, SalesProductsTab } from '../SalesProductsTab'
import type { SalesCatalogue } from '@/lib/sales'

const RANGE = { from: '2026-10-19', to: '2026-11-17' }

function product(overrides: Partial<SalesCatalogue['products'][number]> = {}): SalesCatalogue['products'][number] {
  return {
    product_id: 'chat',
    name: 'Chat completion',
    description: null,
    route: 'POST /v1/chat',
    model: null,
    price_atomic: '18000',
    network: 'eip155:8453',
    output_token_cap: null,
    offered: true,
    removed_at: null,
    ...overrides,
  }
}

const OK: SalesCatalogue = {
  deployment_url: 'https://inference.example.com',
  last_read_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  last_read_status: 'ok',
  last_read_detail: null,
  mismatch: false,
  mismatch_reason: null,
  document_name: 'Inference',
  document_operator_name: null,
  document_network: 'eip155:8453',
  document_pay_to: '0x7Ac3E19b5D0F42c86e1A93b7f0D5c2E48b916Fd2',
  document_updated: null,
  products: [
    product(),
    product({ product_id: 'embed', name: 'Embeddings', price_atomic: '100' }),
    product({ product_id: 'legacy', name: 'Legacy model', price_atomic: '1000000', offered: false, removed_at: '2026-11-01T00:00:00.000Z' }),
  ],
}

const SUMMARY = {
  revenue_raw: '0',
  sales: 0,
  average_sale_raw: '0',
  without_product: { count: 0, amount_raw: '0' },
  own_moves: { count: 0, amount_raw: '0' },
  by_product: [
    { product_id: 'chat', label: 'Chat completion', sales: 12, amount_raw: '216000' },
    { product_id: 'legacy', label: 'Legacy model', sales: 1, amount_raw: '1000000' },
  ],
  by_product_other: { products: 0, sales: 0, amount_raw: '0' },
  by_payer: [],
  by_payer_other: { payers: 0, payments: 0, amount_raw: '0' },
  unattributed: { payments: 0, amount_raw: '0' },
  by_day: [],
}

function catalogue(overrides: Partial<UseMerchantCatalogueResult> = {}): UseMerchantCatalogueResult {
  return {
    data: OK,
    loading: false,
    failed: false,
    reading: false,
    saving: false,
    reload: vi.fn(),
    readNow: vi.fn().mockResolvedValue({ ok: true }),
    saveDeployment: vi.fn(),
    ...overrides,
  }
}

/** Renders the tab and lets the summary read settle, so no state update lands outside the test. */
async function renderTab(value: UseMerchantCatalogueResult, onOpenSetup = vi.fn()) {
  render(<SalesProductsTab catalogue={value} range={RANGE} onOpenSetup={onOpenSetup} />)
  await act(async () => {})
  return { onOpenSetup }
}

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue(SUMMARY)
})

describe('the Products tab', () => {
  it('says there is no product list address yet, and goes to Setup', async () => {
    const { onOpenSetup } = await renderTab(
      catalogue({ data: { ...OK, deployment_url: null, last_read_at: null, last_read_status: 'never', products: [] } }),
    )
    expect(screen.getByText('No product list address yet')).toBeTruthy()
    expect(screen.getByText(/The product list is optional\./)).toBeTruthy()
    expect(screen.queryByTestId('sales-products-freshness')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Go to Setup' }))
    expect(onOpenSetup).toHaveBeenCalled()
  })

  it('lists the products read: exact USDC prices, network, sales in the period and status', async () => {
    await renderTab(catalogue())
    const table = await screen.findByTestId('sales-products-table')
    expect(within(table).getAllByText('Chat completion').length).toBeGreaterThan(0)
    // An exact price: a $0.018 call is not rounded to a cent here.
    expect(within(table).getAllByText('0.018 USDC').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('0.0001 USDC').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('1.00 USDC').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('Base').length).toBeGreaterThan(0)
    // Sales in the period, from the summary's by-product lines; a product with none reads 0.
    await waitFor(() => expect(within(table).getAllByText('12').length).toBeGreaterThan(0))
    expect(within(table).getAllByText('0').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('Offered').length).toBe(2)
    expect(within(table).getAllByText('No longer offered').length).toBeGreaterThan(0)
    expect(screen.getByText('Sales, 30 days')).toBeTruthy()
    expect(mockGet).toHaveBeenCalledWith('/merchant-sales/summary?from=2026-10-19&to=2026-11-17')
  })

  it('shows the freshness line: where it was read from and how long ago', async () => {
    await renderTab(catalogue())
    const freshness = screen.getByTestId('sales-products-freshness')
    expect(freshness.textContent).toContain('Read from inference.example.com · 4m ago')
    expect(within(freshness).getByRole('button', { name: 'Read now' })).toBeTruthy()
  })

  it('warns on a mismatch, dims the list and says which address and network the seller named', async () => {
    await renderTab(
      catalogue({
        data: {
          ...OK,
          last_read_status: 'mismatch',
          mismatch: true,
          document_network: 'eip155:84532',
          document_pay_to: '0x12D9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae4Ab',
        },
      }),
    )
    const notice = screen.getByTestId('sales-products-mismatch')
    expect(notice.textContent).toContain('Your seller isn’t set up for this Sales account.')
    expect(notice.textContent).toContain('0x12D9…e4Ab on Base Sepolia, not to Sales on Base')
    expect(notice.textContent).toContain('Haven isn’t using these product names until they match.')
  })

  it('warns when the seller cannot be read: the last good list stays, and Haven retries every 15 minutes', async () => {
    await renderTab(catalogue({ data: { ...OK, last_read_status: 'unreachable' } }))
    const notice = screen.getByTestId('sales-products-unreachable')
    expect(notice.textContent).toContain('Haven couldn’t read your seller just now.')
    expect(notice.textContent).toContain('Haven tries again every 15 minutes.')
    expect(screen.getByTestId('sales-products-table')).toBeTruthy()
    expect(screen.getByTestId('sales-products-freshness').textContent).toContain('Last tried 4m ago · inference.example.com')
  })

  it('gives a 404 its own copy and Go to Setup, not the outage copy (#4985)', async () => {
    const { onOpenSetup } = await renderTab(
      catalogue({ data: { ...OK, last_read_status: 'unreachable', last_read_detail: 'http_status: HTTP 404' } }),
    )
    const notice = screen.getByTestId('sales-products-unreachable')
    expect(notice.textContent).toContain('Haven reached that address, but there is no product list at /.well-known/x402.')
    expect(notice.textContent).not.toContain('Haven couldn’t read your seller just now.')
    await userEvent.click(within(notice).getByRole('button', { name: 'Go to Setup' }))
    expect(onOpenSetup).toHaveBeenCalled()
  })

  it('gives a 410 the same no-product-list copy (#4985)', async () => {
    await renderTab(
      catalogue({ data: { ...OK, last_read_status: 'unreachable', last_read_detail: 'http_status: HTTP 410' } }),
    )
    const notice = screen.getByTestId('sales-products-unreachable')
    expect(notice.textContent).toContain('there is no product list at /.well-known/x402')
    expect(within(notice).getByRole('button', { name: 'Go to Setup' })).toBeTruthy()
  })

  it('keeps the outage copy for a 503 and a timeout, with no Go to Setup (#4985)', async () => {
    for (const detail of ['http_status: HTTP 503', 'timeout: the read timed out']) {
      const { unmount } = render(
        <SalesProductsTab
          catalogue={catalogue({ data: { ...OK, last_read_status: 'unreachable', last_read_detail: detail } })}
          range={RANGE}
          onOpenSetup={vi.fn()}
        />,
      )
      await act(async () => {})
      const notice = screen.getByTestId('sales-products-unreachable')
      expect(notice.textContent).toContain('Haven couldn’t read your seller just now.')
      expect(notice.textContent).not.toContain('there is no product list')
      expect(within(notice).queryByRole('button', { name: 'Go to Setup' })).toBeNull()
      unmount()
    }
  })

  it('says a seller with no product list is not one Haven can use, and points to Setup', async () => {
    const { onOpenSetup } = await renderTab(catalogue({ data: { ...OK, last_read_status: 'malformed', products: [] } }))
    expect(screen.getByTestId('sales-products-malformed').textContent).toContain(
      'Haven found something at that address, but it isn’t a product list Haven can read.',
    )
    await userEvent.click(within(screen.getByTestId('sales-products-malformed')).getByRole('button', { name: 'Go to Setup' }))
    expect(onOpenSetup).toHaveBeenCalled()
  })

  it('says nothing has been read yet when an address is saved but no read has happened', async () => {
    await renderTab(catalogue({ data: { ...OK, last_read_at: null, last_read_status: 'never', products: [] } }))
    expect(screen.getByText('No products read yet')).toBeTruthy()
    expect(screen.getByTestId('sales-products-freshness').textContent).toContain('Not read yet from inference.example.com')
  })

  it('reads now: asks the read, shows Reading… while it runs, and shows a failed read under the header', async () => {
    let finish: (value: { ok: false; message: string }) => void = () => {}
    const readNow = vi.fn(() => new Promise<{ ok: false; message: string }>((resolve) => (finish = resolve)))
    const { rerender } = render(
      <SalesProductsTab catalogue={catalogue({ readNow })} range={RANGE} onOpenSetup={vi.fn()} />,
    )
    await act(async () => {})
    await userEvent.click(screen.getByRole('button', { name: 'Read now' }))
    expect(readNow).toHaveBeenCalledTimes(1)
    rerender(<SalesProductsTab catalogue={catalogue({ readNow, reading: true })} range={RANGE} onOpenSetup={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Reading…' }) as HTMLButtonElement).disabled).toBe(true)
    finish({ ok: false, message: 'Save the address of your kit deployment first' })
    expect((await screen.findByTestId('sales-products-read-error')).textContent).toContain('Save the address of your kit')
  })

  it('shows loading, then an error with a retry', async () => {
    const reload = vi.fn()
    const { unmount } = render(
      <SalesProductsTab catalogue={catalogue({ data: null, loading: true })} range={RANGE} onOpenSetup={vi.fn()} />,
    )
    expect(screen.getByRole('status', { name: 'Loading products' })).toBeTruthy()
    await act(async () => {})
    unmount()
    await renderTab(catalogue({ data: null, failed: true, reload }))
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalled()
  })
})

describe('mismatchText', () => {
  it('falls back to a general sentence when the kit named no address or network', async () => {
    const text = mismatchText({ ...OK, document_pay_to: null, document_network: null }, { name: 'Sales', chain_id: 8453 })
    expect(text).toContain('names a different receiving address or network')
    expect(text).not.toContain('0x')
  })
})
