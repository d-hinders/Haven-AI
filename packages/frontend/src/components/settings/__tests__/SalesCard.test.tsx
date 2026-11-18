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

describe('SalesCard — the states (#4904)', () => {
  it('never on: the purpose line and the one control, and no account rows', () => {
    serve()
    renderCard()

    expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument()
    expect(
      screen.getByText('Turn Sales on to take payments from customers and their agents.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on Sales' })).toBeInTheDocument()
    expect(screen.queryByText('Sales account')).not.toBeInTheDocument()
    expect(screen.queryByText('Keys not accepted while off')).not.toBeInTheDocument()
  })

  it('on: the badge, the account as a link to its page, and its network', () => {
    serve({ state: merchantServicesOn, enabled: true, merchantAccount: SALES_ACCOUNT })
    renderCard()

    expect(screen.getByText('On')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Sales/ })
    expect(link).toHaveAttribute('href', `/accounts/${SALES_ACCOUNT.id}`)
    expect(screen.getByText('Network')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn off Sales' })).toBeInTheDocument()
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
    // The documented Detail list row (design-system.md § Detail list).
    expect(screen.getByText('Sales keys')).toBeInTheDocument()
    expect(screen.getByText('Keys not accepted while off')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on Sales' })).toBeInTheDocument()
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
