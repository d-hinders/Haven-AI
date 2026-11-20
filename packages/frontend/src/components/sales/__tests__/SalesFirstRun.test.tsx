import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sales first-run helper (#4900, approved on #4894; observed steps and the
 * seller definition by #4985).
 *
 * Each step's state comes from a read, and no step is ever done without an
 * observation. One test per case the issue names: none observed, key only, kit
 * `ok` without a key, `mismatch` with a key, a revoked key then an unrevoked
 * one, all three done, an un-tick, and loading.
 */

const mockGet = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (path: string) => mockGet(path) },
}))

import type { UseMerchantCatalogueResult } from '@/hooks/useMerchantCatalogue'
import { SalesFirstRun } from '../SalesFirstRun'
import type { SalesCatalogue } from '@/lib/sales'

const ACCOUNT = {
  name: 'Sales',
  chain_id: 84532,
  account_address: '0x7Ac3E19b5D0F42c86e1A93b7f0D5c2E48b916Fd2',
}

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

const OK: SalesCatalogue = {
  ...EMPTY,
  deployment_url: 'https://inference.example.com',
  last_read_at: '2026-11-17T10:00:00.000Z',
  last_read_status: 'ok',
  document_name: 'Inference',
  document_network: 'eip155:84532',
  document_pay_to: ACCOUNT.account_address,
}

const MISMATCH: SalesCatalogue = {
  ...OK,
  last_read_status: 'mismatch',
  mismatch: true,
  mismatch_reason: 'pay_to names another account',
  document_pay_to: '0x12D9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae4Ab',
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
    saveDeployment: vi.fn(),
    ...overrides,
  }
}

/** The keys read answers with `keys`; a `null` answer never settles (the loading case). */
function serveKeys(keys: ReturnType<typeof key>[] | null) {
  mockGet.mockImplementation(async (path: string) => {
    if (path !== '/merchant-keys') throw new Error(`unexpected read ${path}`)
    if (keys === null) return new Promise(() => {})
    return { keys }
  })
}

/** The row's observed state, from the `<li>` the checklist renders. */
function stepState(title: string): string | null {
  return screen.getByText(title).closest('li')?.getAttribute('data-step-state') ?? null
}

const STEP_1 = 'Put your receiving address in your seller'
const STEP_2 = 'Create a Sales key'
const STEP_3 = 'Add your product list (optional)'

async function renderHelper(value: UseMerchantCatalogueResult, account = ACCOUNT) {
  render(
    <SalesFirstRun catalogue={value} account={account} onShowAddress={vi.fn()} setupHref="/sales?tab=setup" />,
  )
  await act(async () => {})
}

/** Mounts the helper and hands back the render result, so a test can unmount and re-read. */
async function mountHelper(value: UseMerchantCatalogueResult, account = ACCOUNT) {
  const view = render(
    <SalesFirstRun catalogue={value} account={account} onShowAddress={vi.fn()} setupHref="/sales?tab=setup" />,
  )
  await act(async () => {})
  return view
}

beforeEach(() => {
  mockGet.mockReset()
  serveKeys([])
})

describe('the seller definition (#4985)', () => {
  it('renders before any other use of "seller" or "kit" in the view', async () => {
    await renderHelper(catalogue())
    const definition = screen.getByTestId('seller-definition')
    expect(definition.textContent).toContain('you run a seller')
    expect(definition.textContent).toContain('The merchant kit is a small program you run in front of an API.')
    expect(definition.textContent).toContain('During the pilot the merchant kit runs on Base Sepolia only')
    expect(definition.querySelector('a[href*="paywall-proxy/README.md"]')).toBeTruthy()
    expect(definition.querySelector('a[href*="12-merchant-kit.md#selling-without-the-kit"]')).toBeTruthy()

    // The definition is the FIRST thing in the helper: the empty state's
    // "…once your seller reports it" comes after it.
    const helper = screen.getByTestId('sales-first-run')
    const first = helper.querySelector('[data-testid="seller-definition"]')
    const empty = screen.getByText('No sales yet')
    expect(first).toBeTruthy()
    expect(first!.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the observed steps (#4985)', () => {
  it('none observed: step 1 active, steps 2 and 3 pending, and no step done', async () => {
    await renderHelper(catalogue())
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_1)).toBe('active')
    expect(stepState(STEP_2)).toBe('pending')
    expect(stepState(STEP_3)).toBe('pending')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('0 of 3 done')
  })

  it('key only: 1 of 3 done, step 1 active', async () => {
    serveKeys([key('aaa', false)])
    await renderHelper(catalogue())
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_1)).toBe('active')
    expect(stepState(STEP_2)).toBe('done')
    expect(stepState(STEP_3)).toBe('pending')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('1 of 3 done')
  })

  it('kit ok without a key: 2 of 3 done, step 2 active', async () => {
    await renderHelper(catalogue({ data: OK }))
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_1)).toBe('done')
    expect(stepState(STEP_2)).toBe('active')
    expect(stepState(STEP_3)).toBe('done')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('2 of 3 done')
  })

  it('kit mismatch with a key: step 3 done and step 1 active, with the pays-elsewhere line', async () => {
    serveKeys([key('aaa', false)])
    await renderHelper(catalogue({ data: MISMATCH }))
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_1)).toBe('active')
    expect(stepState(STEP_2)).toBe('done')
    expect(stepState(STEP_3)).toBe('done')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('2 of 3 done')
    expect(screen.getByText(/Your seller’s product list pays another account or network\./)).toBeTruthy()
  })

  it('a revoked key only is not done; a later read with an unrevoked key flips step 2 to done', async () => {
    serveKeys([key('aaa', true)])
    const first = await mountHelper(catalogue())
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_2)).toBe('pending')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('0 of 3 done')
    first.unmount()

    // The next read of the keys (a remount, as a tab switch gives) sees the
    // unrevoked key: the step follows the observation, not a latch.
    serveKeys([key('aaa', true), key('bbb', false)])
    await mountHelper(catalogue())
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_2)).toBe('done')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('1 of 3 done')
  })

  it('all three done: "3 of 3 done" and the connected copy', async () => {
    serveKeys([key('aaa', false)])
    await renderHelper(catalogue({ data: OK }))
    await screen.findByTestId('sales-first-run-count')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('3 of 3 done')
    expect(screen.getByText('Your seller is connected. Sales appear here when someone pays.')).toBeTruthy()
    expect(stepState(STEP_1)).toBe('done')
    expect(stepState(STEP_2)).toBe('done')
    expect(stepState(STEP_3)).toBe('done')
  })

  it('un-ticks: a catalogue read going ok → unreachable returns steps 1 and 3 to not done', async () => {
    serveKeys([key('aaa', false)])
    const { rerender } = render(
      <SalesFirstRun catalogue={catalogue({ data: OK })} account={ACCOUNT} onShowAddress={vi.fn()} setupHref="/sales?tab=setup" />,
    )
    await screen.findByTestId('sales-first-run-count')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('3 of 3 done')

    rerender(
      <SalesFirstRun
        catalogue={catalogue({ data: { ...OK, last_read_status: 'unreachable' } })}
        account={ACCOUNT}
        onShowAddress={vi.fn()}
        setupHref="/sales?tab=setup"
      />,
    )
    await waitFor(() => expect(stepState(STEP_1)).toBe('active'))
    expect(stepState(STEP_3)).toBe('pending')
    expect(stepState(STEP_2)).toBe('done')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('1 of 3 done')
  })

  it('un-ticks: revoking the only key returns step 2 to not done, and the count follows', async () => {
    serveKeys([key('aaa', false)])
    const first = await mountHelper(catalogue({ data: OK }))
    await screen.findByTestId('sales-first-run-count')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('3 of 3 done')
    first.unmount()

    // The next read sees the key revoked: step 2 goes back to not done.
    serveKeys([key('aaa', true)])
    await mountHelper(catalogue({ data: OK }))
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_2)).toBe('active')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('2 of 3 done')
  })

  it('loading: no step done and no count', async () => {
    serveKeys(null)
    await renderHelper(catalogue({ data: null, loading: true }))
    expect(screen.queryByTestId('sales-first-run-count')).toBeNull()
    expect(stepState(STEP_1)).toBe('active')
    expect(stepState(STEP_2)).toBe('pending')
    expect(stepState(STEP_3)).toBe('pending')
  })

  it('a failed keys read leaves step 2 not done and shows no error', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    await renderHelper(catalogue())
    await screen.findByTestId('sales-first-run-count')
    expect(stepState(STEP_2)).not.toBe('done')
    expect(screen.getByTestId('sales-first-run-count').textContent).toBe('0 of 3 done')
    expect(screen.queryByText(/could not load/i)).toBeNull()
  })
})

describe('the coding-agent prompt (#4985)', () => {
  it('offers the prompt on Base Sepolia and never prints it until the clipboard refuses', async () => {
    await renderHelper(catalogue())
    expect(screen.getByTestId('merchant-kit-setup-prompt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy setup prompt' })).toBeTruthy()
    expect(screen.queryByTestId('merchant-kit-setup-prompt-text')).toBeNull()
  })

  it('on a Base Sales account offers no prompt, and shows the Base Sepolia pilot line', async () => {
    await renderHelper(catalogue(), { ...ACCOUNT, chain_id: 8453 })
    expect(screen.queryByTestId('merchant-kit-setup-prompt')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy setup prompt' })).toBeNull()
    expect(screen.getByTestId('merchant-kit-setup-pilot-only').textContent).toContain(
      'During the pilot the merchant kit runs on Base Sepolia only',
    )
  })
})
