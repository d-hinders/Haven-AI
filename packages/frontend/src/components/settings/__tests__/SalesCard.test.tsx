import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseMerchantServices } = vi.hoisted(() => ({ mockUseMerchantServices: vi.fn() }))

vi.mock('@/hooks/useMerchantServices', () => ({ useMerchantServices: () => mockUseMerchantServices() }))

import { LocaleProvider } from '@/context/LocaleContext'
import { MerchantServicesProvider } from '@/context/MerchantServicesContext'
import SalesCard from '@/components/settings/SalesCard'
import { merchantServicesOff, merchantServicesOn } from '../../../../e2e/fixtures/haven-api'

const SALES_ACCOUNT = merchantServicesOn.merchant_account!

function serve(overrides: Record<string, unknown> = {}) {
  const turnOff = vi.fn().mockResolvedValue({ ok: true, state: { ...merchantServicesOn, enabled: false } })
  mockUseMerchantServices.mockReturnValue({
    status: 'ready',
    state: merchantServicesOff,
    enabled: false,
    merchantAccount: null,
    refresh: vi.fn(),
    turnOn: vi.fn(),
    turnOff,
    ...overrides,
  })
  return { turnOff }
}

function renderCard() {
  return render(
    <LocaleProvider>
      <MerchantServicesProvider>
        <SalesCard />
      </MerchantServicesProvider>
    </LocaleProvider>,
  )
}

beforeEach(() => {
  mockUseMerchantServices.mockReset()
})

describe('SalesCard — one SettingsSection, like Accounting (#4983)', () => {
  it('puts the title above the card and the testid on the section itself', () => {
    serve()
    renderCard()

    const section = screen.getByTestId('sales-card')
    expect(section.tagName).toBe('SECTION')
    // The heading is the section's own `v2-text-h3`, not a `Card.Header` band.
    expect(within(section).getByRole('heading', { name: 'Sales', level: 2 })).toBeInTheDocument()
    expect(section.querySelector('[class*="v2-text-h3"]')).not.toBeNull()
    // No second `<section>` nests inside it.
    expect(section.querySelector('section')).toBeNull()
  })

  it('never on: the product context, the status row and the one control, and no account rows', () => {
    serve()
    renderCard()

    expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument()
    // What Sales is: the account, the Sales page, and the seller — the kit is
    // one option, never the assumption (#4985's shared definition).
    expect(screen.getByText(/a separate Sales account/)).toBeInTheDocument()
    expect(screen.getByText(/the Sales page shows what each payment was for/)).toBeInTheDocument()
    expect(screen.getByText(/your own MCP server or API, or Haven’s merchant kit/)).toBeInTheDocument()
    expect(screen.getByText('Turn Sales on to take payments from customers and their agents.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on Sales' })).toBeInTheDocument()
    expect(screen.queryByText('Sales account')).not.toBeInTheDocument()
    expect(screen.queryByText('Keys not accepted while off')).not.toBeInTheDocument()
    // `/sales` answers not found while Sales is off, so no link to it renders.
    expect(screen.queryByRole('link', { name: 'Open the Sales page' })).not.toBeInTheDocument()
  })

  it('on: the badge, the link to the Sales page, the account as a link to its page, and its network', () => {
    serve({ state: merchantServicesOn, enabled: true, merchantAccount: SALES_ACCOUNT })
    renderCard()

    expect(screen.getByText('On')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn off Sales' })).toBeInTheDocument()

    // The heading's slot is a LINK to the fuller surface, never a button.
    const salesPage = screen.getByRole('link', { name: 'Open the Sales page' })
    expect(salesPage).toHaveAttribute('href', '/sales')

    // The account chip still links to the account, by its own exact name.
    const account = screen.getByRole('link', { name: SALES_ACCOUNT.name })
    expect(account).toHaveAttribute('href', `/accounts/${SALES_ACCOUNT.id}`)

    expect(screen.getByText('Network')).toBeInTheDocument()
    expect(screen.queryByText('Keys not accepted while off')).not.toBeInTheDocument()
  })

  it('off: the account and its history are kept, and the keys are refused', () => {
    serve({ state: { ...merchantServicesOn, enabled: false }, merchantAccount: SALES_ACCOUNT })
    renderCard()

    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Sales is off. The Sales account and its history are kept, and the Sales keys are not accepted.',
      ),
    ).toBeInTheDocument()
    // The keys-off row is a `SettingsRow` now, not a Detail list row.
    expect(screen.getByText('Sales keys')).toBeInTheDocument()
    expect(screen.getByText('Keys not accepted while off')).toBeInTheDocument()
    expect(
      screen.getByText('Sales reports from your seller are refused until Sales is on again.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on Sales' })).toBeInTheDocument()
    // Off means `/sales` answers not found, so no link to it renders.
    expect(screen.queryByRole('link', { name: 'Open the Sales page' })).not.toBeInTheDocument()
  })

  it('loading: a busy region, never a silent off', () => {
    serve({ status: 'loading', state: null })
    renderCard()

    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn on Sales' })).not.toBeInTheDocument()
  })

  it('error: a retry, never a silent off', () => {
    const refresh = vi.fn()
    serve({ status: 'error', state: null, refresh })
    renderCard()

    expect(screen.getByText('Haven could not load Sales.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalled()
  })
})

describe('SalesCard — Stripe deposit addresses moved to Sales → Setup (#4983)', () => {
  it('on: renders none of it, and no Stripe text', () => {
    serve({ state: merchantServicesOn, enabled: true, merchantAccount: SALES_ACCOUNT })
    renderCard()

    expect(screen.queryByTestId('sales-deposit-addresses')).not.toBeInTheDocument()
    expect(screen.queryByText(/Stripe/)).not.toBeInTheDocument()
  })
})

describe('SalesCard — turning off asks first (#4904)', () => {
  it('the confirmation says the account and its history are kept and the keys stop working', async () => {
    const { turnOff } = serve({ state: merchantServicesOn, enabled: true, merchantAccount: SALES_ACCOUNT })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Turn off Sales' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Turn off Sales?')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'The Sales account and its history are kept, and the Sales keys stop working. You can turn Sales back on at any time.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off Sales' }))
    await waitFor(() => expect(turnOff).toHaveBeenCalledTimes(1))
  })

  it('a failed turn-off shows its error inside the dialog', async () => {
    const turnOff = vi.fn().mockResolvedValue({ ok: false, message: 'nope' })
    serve({ state: merchantServicesOn, enabled: true, merchantAccount: SALES_ACCOUNT, turnOff })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Turn off Sales' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off Sales' }))

    expect(await within(dialog).findByText('We could not turn Sales off. Try again in a moment.')).toBeInTheDocument()
  })
})
