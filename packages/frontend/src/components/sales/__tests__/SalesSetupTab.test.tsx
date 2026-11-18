import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sales Setup tab (#4900, epic #4885): the receiving address action, the
 * kit address that saves through the catalogue route and the Sales keys slot.
 */

const mockGet = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (path: string) => mockGet(path) },
}))

import type { UseMerchantCatalogueResult } from '@/hooks/useMerchantCatalogue'
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

const ACCOUNT = { name: 'Sales', chain_id: 8453 }

/** Renders the tab and lets the keys read settle, so no state update lands outside the test. */
async function renderTab(value: UseMerchantCatalogueResult, onShowAddress = vi.fn()) {
  render(<SalesSetupTab account={ACCOUNT} catalogue={value} onShowAddress={onShowAddress} />)
  await screen.findByText('sk_merchant_aaa…')
  return { onShowAddress }
}

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ keys: [key('aaa', false), key('bbb', false), key('ccc', true)] })
  window.history.replaceState(null, '', '/sales?tab=setup')
})

describe('the receiving address', () => {
  it('opens the Receive dialog through the page and prints no address', async () => {
    const { onShowAddress } = await renderTab(catalogue())
    await userEvent.click(screen.getByRole('button', { name: 'Show address' }))
    expect(onShowAddress).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('sales-setup-tab').textContent).not.toMatch(/0x[0-9a-fA-F]{6}/)
  })
})

describe('the kit address', () => {
  it('shows the mockup helper, and saves a trimmed address through the catalogue', async () => {
    const saveDeployment = vi.fn().mockResolvedValue({ ok: true })
    await renderTab(catalogue({ saveDeployment }))
    expect(
      screen.getByText('The public address of your kit. Haven reads your product list from it; it never sends anything there.'),
    ).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('Kit address'), '  https://inference.example.com ')
    await userEvent.click(save)
    expect(saveDeployment).toHaveBeenCalledWith('https://inference.example.com')
  })

  it('fills the field with the saved address and keeps Save off until it changes', async () => {
    await renderTab(
      catalogue({
        data: { ...EMPTY, deployment_url: 'https://inference.example.com', last_read_status: 'ok', last_read_at: new Date().toISOString() },
      }),
    )
    expect((screen.getByLabelText('Kit address') as HTMLInputElement).value).toBe('https://inference.example.com')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/^Last read just now/)).toBeTruthy()
  })

  it('shows the route’s own refusal under the field and marks it invalid', async () => {
    const saveDeployment = vi
      .fn()
      .mockResolvedValue({ ok: false, message: 'Haven cannot read that address: only https addresses are read' })
    await renderTab(catalogue({ saveDeployment }))
    const input = screen.getByLabelText('Kit address') as HTMLInputElement
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
    const input = screen.getByLabelText('Kit address')
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Enter the address of your kit.')).toBeTruthy()
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
    expect(document.activeElement).toBe(screen.getByLabelText('Kit address'))
  })

  it('shows the field as busy while it saves', async () => {
    await renderTab(catalogue({ saving: true }))
    expect((screen.getByLabelText('Kit address') as HTMLInputElement).disabled).toBe(true)
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
