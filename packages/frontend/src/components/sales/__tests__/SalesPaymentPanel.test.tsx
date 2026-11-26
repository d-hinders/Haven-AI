import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sales payment panel (#4900, epic #4885): the variants the reads can
 * produce (a sale, a payment with no sale record, an own move, a payment with
 * no legs, a payment held by Stripe), and the one action that changes data —
 * clearing a sale record — through the confirmation, the DELETE, the toast and
 * the refresh, and its failure shown inside the dialog.
 */

const mockGet = vi.fn()
const mockDelete = vi.fn()
const mockToastSuccess = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (path: string) => mockGet(path), delete: (path: string) => mockDelete(path) },
}))

vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: { success: mockToastSuccess, error: vi.fn(), info: vi.fn() } }),
}))

const mockCurrency = vi.fn(() => 'USD')
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ currency: mockCurrency(), setCurrency: vi.fn(), saving: false }),
}))

const ACCOUNT_ADDRESS = '0x7Ac3E19b5D0F42c86e1A93b7f0D5c2E48b916Fd2'
vi.mock('@/context/MerchantServicesContext', () => ({
  useMerchantServicesContext: () => ({
    status: 'ready',
    enabled: true,
    merchantAccount: {
      id: 'acct-sales',
      account_address: ACCOUNT_ADDRESS,
      chain_id: 8453,
      name: 'Sales',
      created_at: '2026-11-01T00:00:00.000Z',
    },
  }),
}))

import { ApiRequestError } from '@/lib/api'
import { LocaleProvider } from '@/context/LocaleContext'
import { SalesPaymentPanel, payerPhrase } from '../SalesPaymentPanel'

const HASH = `0x${'ab'.repeat(32)}`
const CONTACT = { kind: 'contact', name: 'Lumen Research', address: '0x41b2c09e7a55d81f3b2e6c40a9d17e5f8c0b7d93' }
const OWN = { kind: 'own', name: 'Atlas', address: '0x9e10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4c2a' }
const WALLET = { kind: 'wallet', name: null, address: '0x8f3a5e0b7c1d4a92e6f03b8d15c7a90e4b6d21c0' }

const base = {
  tx_hash: HASH,
  block_time: '2026-11-17T14:05:00.000Z',
  kind: 'sale',
  amount_raw: '420000',
  product_id: 'chat',
  product_label: 'Chat completion',
  payer: WALLET,
  several_payers: false,
  receipt_number: null,
  vat_treatment: null,
  held_by: 'account',
  merchant_reference: 'req_01JD8Q4F2K',
  legs: [{ log_index: 3, payer: WALLET, amount_raw: '420000' }],
}

function serve(detail: unknown) {
  mockGet.mockImplementation(async () => detail)
}

async function open(onClose = vi.fn(), extra: Partial<React.ComponentProps<typeof SalesPaymentPanel>> = {}) {
  render(
    <LocaleProvider>
      <SalesPaymentPanel txHash={HASH} onClose={onClose} {...extra} />
    </LocaleProvider>,
  )
  await screen.findByTestId('sales-payment-header')
}

beforeEach(() => {
  mockGet.mockReset()
  mockDelete.mockReset()
  mockToastSuccess.mockReset()
  mockCurrency.mockReturnValue('USD')
})

describe('the panel, by variant', () => {
  it('shows a sale: the product, the amount and its USDC value, Received, who paid and when', async () => {
    serve(base)
    await open()
    expect(screen.getByRole('dialog', { name: 'Chat completion' })).toBeTruthy()
    const header = screen.getByTestId('sales-payment-header')
    expect(within(header).getByText('+$0.42')).toBeTruthy()
    expect(within(header).getByText('0.42 USDC')).toBeTruthy()
    expect(within(header).getByText('Received')).toBeTruthy()
    expect(header.textContent).toContain('Paid by Wallet (0x8f3a…21c0) into Sales')

    const details = screen.getByTestId('sales-payment-details')
    expect(details.textContent).toContain('Chat completion')
    expect(details.textContent).toContain('chat')
    expect(details.textContent).toContain('Not one of your contacts or agents')
    expect(within(details).getByText('Sent')).toBeTruthy()
    expect(details.textContent).toContain('req_01JD8Q4F2K')
    expect(screen.queryByText('Confirmations')).toBeNull()
    expect(screen.queryByText('Reported with')).toBeNull()
  })

  it('names a contact payer and leads with their monogram, not the direction mark', async () => {
    serve({ ...base, payer: CONTACT, legs: [{ log_index: 1, payer: CONTACT, amount_raw: '420000' }] })
    await open()
    expect(screen.getByTestId('sales-payment-header').textContent).toContain('Paid by Lumen Research into Sales')
    expect(screen.getByTestId('sales-payment-details').textContent).toContain('One of your contacts')
  })

  it('reads in USDC, not a converted figure, when the currency has no rate or the read has no usdc_rates', async () => {
    mockCurrency.mockReturnValue('SEK')
    serve({ ...base, usdc_rates: { usd: 0.9998, eur: 0.92, sek: null } })
    await open()
    const header = screen.getByTestId('sales-payment-header')
    expect(within(header).getByText('+0.42 USDC')).toBeTruthy()
    expect(header.textContent).not.toContain('$')
    expect(header.textContent).not.toContain('\u2248')
  })

  it('reads in USDC for an older backend with no usdc_rates field', async () => {
    mockCurrency.mockReturnValue('EUR')
    serve(base)
    await open()
    expect(within(screen.getByTestId('sales-payment-header')).getByText('+0.42 USDC')).toBeTruthy()
  })

  it('converts SEK with the detail read\'s rate, marks it approximate, and keeps the USDC figure beside it', async () => {
    mockCurrency.mockReturnValue('SEK')
    serve({ ...base, usdc_rates: { usd: 0.9998, eur: 0.92, sek: 10 } })
    await open()
    const header = screen.getByTestId('sales-payment-header')
    expect(header.textContent).toContain('\u2248')
    expect(header.textContent).toContain('+4,20')
    expect(within(header).getByText('0.42 USDC')).toBeTruthy()
  })

  it('converts EUR the same way', async () => {
    mockCurrency.mockReturnValue('EUR')
    serve({ ...base, usdc_rates: { usd: 0.9998, eur: 0.5, sek: 10 } })
    await open()
    const header = screen.getByTestId('sales-payment-header')
    expect(header.textContent).toContain('\u2248')
    expect(header.textContent).toContain('0,21')
  })

  it('keeps USD exact and unmarked, ignoring rates.usd', async () => {
    serve({ ...base, usdc_rates: { usd: 0.5, eur: 0.92, sek: 10 } })
    await open()
    const header = screen.getByTestId('sales-payment-header')
    expect(within(header).getByText('+$0.42')).toBeTruthy()
    expect(header.textContent).not.toContain('\u2248')
  })

  it('keeps every address and hash inside Technical details, shortened, and links the explorer', async () => {
    serve(base)
    await open()
    const technical = screen.getByTestId('sales-payment-technical') as HTMLDetailsElement
    expect(technical.open).toBe(false)
    expect(within(technical).getByText('Technical details')).toBeTruthy()
    expect(within(technical).getByText('Base')).toBeTruthy()
    expect(within(technical).getByText('0x8f3a…21c0')).toBeTruthy()
    expect(within(technical).getByText('0x7Ac3…6Fd2')).toBeTruthy()
    expect(within(technical).getByText('0xabab…abab')).toBeTruthy()
    // None of them is in the primary body.
    const primary = screen.getByTestId('sales-payment-header').textContent + screen.getByTestId('sales-payment-details').textContent
    expect(primary).not.toContain(HASH)
    expect(primary).not.toContain(ACCOUNT_ADDRESS)
    const explorer = screen.getByRole('link', { name: 'View on explorer' })
    expect(explorer.getAttribute('href')).toBe(`https://basescan.org/tx/${HASH}`)
  })

  it('shows a payment with no sale record as "No product recorded", with its notice and no clear action', async () => {
    serve({ ...base, kind: 'no_product', product_id: null, product_label: null, merchant_reference: null })
    await open()
    expect(screen.getByRole('dialog', { name: 'No product recorded' })).toBeTruthy()
    expect(screen.getByText(/Your seller sent no sale record for this payment/)).toBeTruthy()
    expect(within(screen.getByTestId('sales-payment-details')).getByText('Not sent')).toBeTruthy()
    expect(within(screen.getByTestId('sales-payment-header')).getByText('Received')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear sale record' })).toBeNull()
  })

  it('shows an own move as "Moved between your accounts", Not counted, with the notice and no clear action', async () => {
    serve({
      ...base,
      kind: 'own_move',
      product_id: null,
      product_label: null,
      payer: OWN,
      merchant_reference: null,
      legs: [{ log_index: 0, payer: OWN, amount_raw: '420000' }],
    })
    await open()
    expect(screen.getByRole('dialog', { name: 'Moved between your accounts' })).toBeTruthy()
    const header = screen.getByTestId('sales-payment-header')
    expect(within(header).getByText('Not counted')).toBeTruthy()
    expect(within(header).queryByText('Received')).toBeNull()
    expect(within(header).getByText('$0.42')).toBeTruthy()
    expect(header.textContent).toContain('By Atlas into Sales')
    expect(screen.getByText(/is a move, not a sale, so it is not in your revenue/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear sale record' })).toBeNull()
  })

  it('does not crash when legs is empty: it omits the payer address rather than inventing one', async () => {
    serve({ ...base, payer: null, legs: [] })
    await open()
    const technical = screen.getByTestId('sales-payment-technical')
    expect(within(technical).queryByText('Paid from')).toBeNull()
    expect(within(technical).getByText('Transaction')).toBeTruthy()
    expect(screen.getByTestId('sales-payment-header').textContent).toContain('Paid into Sales')
  })

  it('says a Stripe-held sale counts in revenue but not in the Sales account\'s balance (#4981)', async () => {
    serve({ ...base, held_by: 'stripe', tx_hash: 'pi_3Q8example', payer: null, legs: [] })
    await open()
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain('It counts in your revenue, but not in any Haven balance')
    expect(text).not.toContain('not in your revenue')
  })

  it('does not crash on a payment held by Stripe: no on-chain hash, no explorer link', async () => {
    serve({ ...base, held_by: 'stripe', tx_hash: 'pi_3Q8example', payer: null, legs: [] })
    await open()
    expect(screen.getByRole('dialog', { name: 'Chat completion' })).toBeTruthy()
    const technical = screen.getByTestId('sales-payment-technical')
    expect(within(technical).queryByText('Transaction')).toBeNull()
    expect(within(technical).queryByText('Paid to')).toBeNull()
    expect(screen.queryByRole('link', { name: 'View on explorer' })).toBeNull()
  })

  it('names several payers in one payment without picking one', async () => {
    serve({ ...base, payer: null, several_payers: true, legs: [
      { log_index: 1, payer: WALLET, amount_raw: '200000' },
      { log_index: 2, payer: CONTACT, amount_raw: '220000' },
    ] })
    await open()
    expect(screen.getByTestId('sales-payment-header').textContent).toContain('Paid by several wallets into Sales')
    const technical = screen.getByTestId('sales-payment-technical')
    expect(within(technical).getByText('Paid from 1')).toBeTruthy()
    expect(within(technical).getByText('Paid from 2')).toBeTruthy()
  })

  it('says so when the payment is not on the account, and when the read fails', async () => {
    mockGet.mockRejectedValueOnce(new ApiRequestError('No such payment on this account.', 404))
    render(
      <LocaleProvider>
        <SalesPaymentPanel txHash={HASH} onClose={vi.fn()} />
      </LocaleProvider>,
    )
    expect(await screen.findByText('This payment is not on your Sales account.')).toBeTruthy()
  })

  it('offers a retry when the read fails', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))
    render(
      <LocaleProvider>
        <SalesPaymentPanel txHash={HASH} onClose={vi.fn()} />
      </LocaleProvider>,
    )
    const retry = await screen.findByRole('button', { name: 'Try again' })
    mockGet.mockResolvedValue(base)
    await userEvent.click(retry)
    await screen.findByTestId('sales-payment-header')
  })

  it('stays closed with no payment, and reads nothing', () => {
    render(
      <LocaleProvider>
        <SalesPaymentPanel txHash={null} onClose={vi.fn()} />
      </LocaleProvider>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('clearing a sale record', () => {
  it('asks first, with the leaked-key warning, and DELETEs only on confirm', async () => {
    serve(base)
    mockDelete.mockResolvedValue(undefined)
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    const dialog = screen.getByRole('dialog', { name: 'Clear this sale record?' })
    expect(dialog.textContent).toContain('The payment stays and still counts as revenue.')
    expect(dialog.textContent).toContain('Think your Sales key leaked?')
    expect(mockDelete).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(mockDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Clear this sale record?' })).toBeNull()
  })

  it('on confirm: deletes the record, toasts, refreshes the panel and tells the page', async () => {
    serve(base)
    mockDelete.mockResolvedValue(undefined)
    const onCleared = vi.fn()
    await open(vi.fn(), { onCleared })
    const readsBefore = mockGet.mock.calls.length
    // After the clear the same read answers a payment with no record.
    mockGet.mockImplementation(async () => ({ ...base, kind: 'no_product', product_id: null, product_label: null }))

    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear record' }))

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(`/merchant-sales/payments/${HASH}/record`))
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Sale record cleared. The payment stays.'))
    expect(onCleared).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(readsBefore))
    // The panel now reads as a payment with no record, and the dialog is gone.
    expect(await screen.findByRole('dialog', { name: 'No product recorded' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Clear this sale record?' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear sale record' })).toBeNull()
  })

  it('shows a failed clear inside the dialog, keeps it open, and changes nothing else', async () => {
    serve(base)
    mockDelete.mockRejectedValue(new ApiRequestError('Turn merchant services on before clearing a sale record', 409))
    const onCleared = vi.fn()
    await open(vi.fn(), { onCleared })
    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    const dialog = screen.getByRole('dialog', { name: 'Clear this sale record?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear record' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Turn merchant services on'))
    expect(mockToastSuccess).not.toHaveBeenCalled()
    expect(onCleared).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Clear this sale record?' })).toBeTruthy()
    // Cancelling and trying again starts clean.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    expect(within(screen.getByRole('dialog', { name: 'Clear this sale record?' })).queryByRole('alert')).toBeNull()
  })

  it('words a record that is already gone, and refreshes', async () => {
    serve(base)
    mockDelete.mockRejectedValue(new ApiRequestError('This payment has no sale record to clear.', 404))
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear record' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('It may already be cleared'),
    )
  })

  it('says the outcome is unknown, never "Nothing changed", when the answer is lost (#5038)', async () => {
    serve(base)
    mockDelete.mockRejectedValue(new TypeError('Failed to fetch'))
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    const dialog = screen.getByRole('dialog', { name: 'Clear this sale record?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear record' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('the sale record may have been cleared')
    expect(alert.textContent).not.toContain('Nothing changed')
    expect(mockToastSuccess).not.toHaveBeenCalled()
  })

  it('says the same for a 5xx, which may have committed before it answered (#5038)', async () => {
    serve(base)
    mockDelete.mockRejectedValue(new ApiRequestError('unavailable', 503))
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    const dialog = screen.getByRole('dialog', { name: 'Clear this sale record?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear record' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('the sale record may have been cleared')
    expect(alert.textContent).not.toContain('Nothing changed')
  })

  it('sends the owner to Setup from the leaked-key notice, closing the confirmation', async () => {
    serve(base)
    const onOpenSetup = vi.fn()
    await open(vi.fn(), { onOpenSetup })
    await userEvent.click(screen.getByRole('button', { name: 'Clear sale record' }))
    await userEvent.click(screen.getByRole('button', { name: 'Sales keys' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
    expect(mockDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Clear this sale record?' })).toBeNull()
  })
})

describe('a wallet is never named (owner decision 2, #4894)', () => {
  const NAMED_WALLET = { kind: 'wallet' as const, name: "Someone's agent", address: WALLET.address }

  it('reads as a wallet in the header phrase, whatever name it carries', () => {
    expect(payerPhrase(NAMED_WALLET, false)).toBe('Wallet (0x8f3a…21c0)')
  })

  it('reads as Wallet in the open panel and never shows the name', async () => {
    serve({ ...base, payer: NAMED_WALLET, legs: [{ log_index: 3, payer: NAMED_WALLET, amount_raw: '420000' }] })
    await open()
    const dialog = screen.getByRole('dialog', { name: 'Chat completion' })
    expect(screen.getByTestId('sales-payment-header').textContent).toContain('Paid by Wallet (0x8f3a…21c0) into Sales')
    expect(dialog.textContent).not.toContain('Someone')
  })
})
