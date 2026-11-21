import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sales Setup tab (#4900, epic #4885; the seller definition, the optional
 * product list address and the coding-agent prompt by #4985): the receiving
 * address action, the product list address that saves through the catalogue
 * route, the Sales keys slot and the prompt.
 */

const mockGet = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (path: string) => mockGet(path) },
}))

import type { UseMerchantCatalogueResult } from '@/hooks/useMerchantCatalogue'
import { LocaleProvider } from '@/context/LocaleContext'
import { ToastProvider } from '@/components/ui/Toast'
import { SalesSetupTab } from '../SalesSetupTab'
import type { SalesCatalogue } from '@/lib/sales'

const EMPTY: SalesCatalogue = {
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

const key = (id: string, revoked: boolean) => ({
  id,
  key_prefix: `sk_merchant_${id}`,
  created_by: 'u1',
  created_at: '2026-11-01T00:00:00.000Z',
  revoked_by: revoked ? 'u1' : null,
  revoked_at: revoked ? '2026-11-02T00:00:00.000Z' : null,
  last_used_at: null,
})

function catalogue(overrides: Partial<UseMerchantCatalogueResult> = {}): UseMerchantCatalogueResult {
  return {
    data: EMPTY,
    loading: false,
    failed: false,
    reading: false,
    saving: false,
    reload: vi.fn(),
    readNow: vi.fn(),
    saveDeployment: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
}

const ACCOUNT = {
  name: 'Sales',
  chain_id: 84532,
  account_address: '0x7Ac3E19b5D0F42c86e1A93b7f0D5c2E48b916Fd2',
}

const ADDRESS_LABEL = 'Product list address (optional)'

/** Renders the tab and lets the keys read settle, so no state update lands outside the test. */
async function renderTab(value: UseMerchantCatalogueResult, onShowAddress = vi.fn(), account = ACCOUNT) {
  render(
    <LocaleProvider>
      <ToastProvider>
        <SalesSetupTab account={account} catalogue={value} onShowAddress={onShowAddress} />
      </ToastProvider>
    </LocaleProvider>,
  )
  await screen.findByText('sk_merchant_aaa…')
  return { onShowAddress }
}

const originalClipboard = navigator.clipboard

beforeEach(() => {
  mockGet.mockReset().mockImplementation(async (path: string) => {
    // #4983: the Stripe deposit addresses are one more part of this card.
    if (path === '/merchant-deposit-addresses') {
      return { verification: 'Registered by you, not verified by Haven.', addresses: [] }
    }
    return { keys: [key('aaa', false), key('bbb', false), key('ccc', true)] }
  })
  window.history.replaceState(null, '', '/sales?tab=setup')
})

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
})

describe('the receiving address', () => {
  it('opens the Receive dialog through the page and prints no address', async () => {
    const { onShowAddress } = await renderTab(catalogue())
    await userEvent.click(screen.getByRole('button', { name: 'Show address' }))
    expect(onShowAddress).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('sales-setup-tab').textContent).not.toMatch(/0x[0-9a-fA-F]{6}/)
  })
})

describe('the seller definition (#4985)', () => {
  it('opens the card, before Receiving address', async () => {
    await renderTab(catalogue())
    const definition = screen.getByTestId('seller-definition')
    expect(definition.textContent).toContain('you run a seller')
    expect(definition.textContent).toContain('The merchant kit is a small program you run in front of an API.')
    expect(definition.textContent).toContain('During the pilot the merchant kit runs on Base Sepolia only')
    // #5009: the licence wording (owner decision (b) on #5005) — the pilot
    // merchant's permission, no written step.
    expect(definition.textContent).toContain(
      'A merchant in the pilot may run and modify it to evaluate Haven, but not redistribute it.',
    )
    expect(definition.textContent).not.toContain('written permission')
    expect(definition.querySelector('a[href*="paywall-proxy/README.md"]')).toBeTruthy()
    expect(definition.querySelector('a[href*="12-merchant-kit.md#selling-without-the-kit"]')).toBeTruthy()

    const receiving = screen.getByRole('heading', { name: 'Receiving address', level: 2 })
    expect(definition.compareDocumentPosition(receiving) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the product list address', () => {
  it('shows the seller-neutral helper, and saves a trimmed address through the catalogue', async () => {
    const saveDeployment = vi.fn().mockResolvedValue({ ok: true })
    await renderTab(catalogue({ saveDeployment }))
    const helper = document.getElementById('sales-kit-address-help')
    expect(helper?.textContent).toContain('The public address of your seller.')
    expect(helper?.textContent).toContain('/.well-known/x402')
    expect(helper?.textContent).toContain('never sends anything to it.')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText(ADDRESS_LABEL), '  https://inference.example.com ')
    await userEvent.click(save)
    expect(saveDeployment).toHaveBeenCalledWith('https://inference.example.com')
  })

  it('fills the field with the saved address and keeps Save off until it changes', async () => {
    await renderTab(
      catalogue({
        data: { ...EMPTY, deployment_url: 'https://inference.example.com', last_read_status: 'ok', last_read_at: new Date().toISOString() },
      }),
    )
    expect((screen.getByLabelText(ADDRESS_LABEL) as HTMLInputElement).value).toBe('https://inference.example.com')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/^Last read just now/)).toBeTruthy()
  })

  it('shows the route’s own refusal under the field and marks it invalid', async () => {
    const saveDeployment = vi
      .fn()
      .mockResolvedValue({ ok: false, message: 'Haven cannot read that address: only https addresses are read' })
    await renderTab(catalogue({ saveDeployment }))
    const input = screen.getByLabelText(ADDRESS_LABEL) as HTMLInputElement
    await userEvent.type(input, 'http://inference.example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Haven cannot read that address: only https addresses are read')).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    // Typing again clears it.
    await userEvent.type(input, 's')
    expect(screen.queryByText(/only https addresses are read/)).toBeNull()
  })

  it('asks for an address instead of saving an empty one', async () => {
    const saveDeployment = vi.fn()
    await renderTab(
      catalogue({ saveDeployment, data: { ...EMPTY, deployment_url: 'https://inference.example.com', last_read_status: 'ok' } }),
    )
    const input = screen.getByLabelText(ADDRESS_LABEL)
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Enter your seller’s address.')).toBeTruthy()
    expect(saveDeployment).not.toHaveBeenCalled()
  })

  it('says the read could not use a saved address, and points to Products', async () => {
    await renderTab(
      catalogue({
        data: { ...EMPTY, deployment_url: 'https://inference.example.com', last_read_status: 'unreachable', last_read_at: new Date().toISOString() },
      }),
    )
    expect(screen.getByText(/Saved\. Haven couldn’t use it/)).toBeTruthy()
  })

  it('takes focus when the first-run step links to #kit-address', async () => {
    window.history.replaceState(null, '', '/sales?tab=setup#kit-address')
    await renderTab(catalogue())
    expect(document.activeElement).toBe(screen.getByLabelText(ADDRESS_LABEL))
  })

  it('shows the field as busy while it saves', async () => {
    await renderTab(catalogue({ saving: true }))
    expect((screen.getByLabelText(ADDRESS_LABEL) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy()
  })
})

describe('the Sales keys section', () => {
  it('lists the keys by prefix and offers Create Sales key (the screens are covered in SalesKeys.test)', async () => {
    await renderTab(catalogue())
    const section = screen.getByTestId('sales-keys-section')
    expect(mockGet).toHaveBeenCalledWith('/merchant-keys')
    expect(section.textContent).toContain('sk_merchant_bbb…')
    expect(screen.getByRole('button', { name: 'Create Sales key' })).toBeTruthy()
  })
})

describe('the coding-agent prompts (#4985, #5010)', () => {
  it('copies the kit prompt with the README URL, the Sales account address and eip155:84532, and no key prefix', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderTab(catalogue())
    await userEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('https://github.com/d-hinders/Haven-AI/blob/dev/packages/paywall-proxy/README.md')
    expect(copied).toContain(ACCOUNT.account_address)
    expect(copied).toContain('eip155:84532')
    expect(copied).toContain('HAVEN_SALES_URL=')
    expect(copied).not.toContain('sk_merchant_')
    // #5009: the first step runs the container image (#5007), never a clone.
    expect(copied).toContain('ghcr.io/d-hinders/haven-paywall-proxy')
    expect(copied).not.toContain('git clone')
    // The prompt is not printed: only the labelled copy control is on screen.
    expect(screen.queryByTestId('seller-setup-kit-prompt-text')).toBeNull()
  })

  it('copies the own-server prompt with the account address, the network, the API origin and the worked example, and no key', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderTab(catalogue())
    await userEvent.click(screen.getByRole('button', { name: 'Copy own-server prompt' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain(ACCOUNT.account_address)
    expect(copied).toContain('eip155:84532')
    expect(copied).toContain(window.location.origin)
    expect(copied).toContain('docs/product/selling-with-your-own-server.md')
    expect(copied).toContain('Sales → Setup → Sales keys')
    // No Sales key, no key prefix, no value shaped like one (#5010).
    expect(copied).not.toContain('sk_merchant_')
    expect(copied).not.toMatch(/sk_merchant_[A-Za-z0-9]/)
    expect(screen.queryByTestId('seller-setup-own-server-prompt-text')).toBeNull()
  })

  it('reveals the prompt when the clipboard refuses it', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    await renderTab(catalogue())
    await userEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
    const revealed = await screen.findByTestId('seller-setup-kit-prompt-text')
    expect(revealed.textContent).toContain(ACCOUNT.account_address)
    expect(revealed.textContent).not.toContain('sk_merchant_')
  })

  it('reveals the own-server prompt when the clipboard refuses it', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    await renderTab(catalogue())
    await userEvent.click(screen.getByRole('button', { name: 'Copy own-server prompt' }))
    const revealed = await screen.findByTestId('seller-setup-own-server-prompt-text')
    expect(revealed.textContent).toContain(ACCOUNT.account_address)
    expect(revealed.textContent).not.toContain('sk_merchant_')
    // The kit prompt stays unprinted: each reveal is its own.
    expect(screen.queryByTestId('seller-setup-kit-prompt-text')).toBeNull()
  })

  it('on a Base Sales account offers neither prompt, and shows the Base Sepolia pilot line', async () => {
    await renderTab(catalogue(), vi.fn(), { ...ACCOUNT, chain_id: 8453 })
    expect(screen.queryByTestId('seller-setup-prompts')).toBeNull()
    expect(screen.queryByTestId('seller-setup-kit-prompt')).toBeNull()
    expect(screen.queryByTestId('seller-setup-own-server-prompt')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy setup prompt' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy own-server prompt' })).toBeNull()
    expect(screen.getByTestId('seller-setup-pilot-only').textContent).toContain(
      'During the pilot the merchant kit runs on Base Sepolia only',
    )
  })
})

describe('the Stripe deposit addresses (#4983)', () => {
  it('renders as one more part of the card, reads the route, and carries the account network', async () => {
    await renderTab(catalogue())

    const section = await screen.findByTestId('sales-deposit-addresses')
    expect(mockGet).toHaveBeenCalledWith('/merchant-deposit-addresses')
    // The part's own anchor, like #receiving-address, #sales-keys and #kit-address.
    expect(section).toHaveAttribute('id', 'stripe-deposit-addresses')
    expect(screen.getByRole('heading', { name: 'Stripe deposit addresses', level: 2 })).toBeTruthy()

    // The account's `chain_id` reaches the register dialog's subtitle.
    await userEvent.click(within(section).getByRole('button', { name: 'Register address' }))
    const dialog = await screen.findByRole('dialog', { name: 'Register a Stripe deposit address' })
    expect(dialog.textContent).toContain('Base')
  })
})
