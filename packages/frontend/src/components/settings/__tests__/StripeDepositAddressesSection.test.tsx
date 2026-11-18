import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Settings → Sales → Stripe deposit addresses (#4954). The routes are mocked
 * at `api`; the hook, the classifier and the section are real, so a refusal is
 * proven end to end from the route's `error_code` to the words on screen.
 */

const mockGet = vi.fn()
const mockPost = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    get: (path: string) => mockGet(path),
    post: (path: string, body?: unknown) => mockPost(path, body),
  },
}))

import { ApiRequestError } from '@/lib/api'
import { LocaleProvider } from '@/context/LocaleContext'
import { ToastProvider } from '@/components/ui/Toast'
import StripeDepositAddressesSection, { displayDepositAddress } from '../StripeDepositAddressesSection'

const ACTIVE = {
  id: '11111111-1111-4111-8111-111111111111',
  address: '0x3c9e5a1b7d2f4e60a8b1c3d5e7f9a0b2c4d6e8f0',
  chain: 'eip155:84532',
  registered_at: '2026-11-18T09:00:00.000Z',
  retired_at: null,
  active: true,
  verified: false as const,
  verification: 'Registered by you, not verified by Haven.',
}
const RETIRED = {
  ...ACTIVE,
  id: '22222222-2222-4222-8222-222222222222',
  address: '0x8f3a5e0b7c1d4a92e6f03b8d15c7a90e4b6d21c0',
  registered_at: '2026-11-10T09:00:00.000Z',
  retired_at: '2026-11-12T09:00:00.000Z',
  active: false,
}

function serveList(addresses: unknown[]) {
  mockGet.mockImplementation(async (path: string) => {
    if (path === '/merchant-deposit-addresses') {
      return { verification: 'Registered by you, not verified by Haven.', addresses }
    }
    throw new Error(`unexpected read ${path}`)
  })
}

function renderSection() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <StripeDepositAddressesSection chainId={84532} />
      </ToastProvider>
    </LocaleProvider>,
  )
}

const refusal = (status: number, error_code?: string, error = 'Refused.') =>
  new ApiRequestError(error, status, { error, ...(error_code ? { error_code } : {}) })

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
})

describe('the list', () => {
  it('labels EVERY address "registered by you, not verified by Haven", and keeps a retired one listed as retired', async () => {
    serveList([ACTIVE, RETIRED])
    renderSection()
    const rows = await screen.findAllByTestId('sales-deposit-address')
    expect(rows).toHaveLength(2)

    const section = screen.getByTestId('sales-deposit-addresses')
    // Per address: the badge and the helper line both carry the label.
    expect(within(section).getAllByText('Not verified by Haven')).toHaveLength(2)
    expect(within(section).getAllByText(/^Registered by you on .*, not verified by Haven\./)).toHaveLength(2)
    // The one section notice, not one per address.
    expect(within(section).getAllByText(/^Registered by you, not verified by Haven\. Haven cannot check/)).toHaveLength(1)

    // Shown in full, checksummed, as the Receive dialog shows an address.
    expect(section.textContent).toContain(displayDepositAddress(ACTIVE.address))
    expect(displayDepositAddress(ACTIVE.address)).not.toBe(ACTIVE.address)

    // The retired one stays, marked, with no Retire action.
    expect(within(section).getAllByText('Retired')).toHaveLength(1)
    expect(section.textContent).toContain('Retired on 12 November 2026')
    expect(within(section).getAllByRole('button', { name: /^Retire / })).toHaveLength(1)
  })

  it('says nothing is registered, and to register before the first payment', async () => {
    serveList([])
    renderSection()
    const empty = await screen.findByTestId('sales-deposit-addresses-empty')
    expect(empty.textContent).toContain('before your first Stripe payment')
  })

  it('says a failed read failed, with a retry', async () => {
    mockGet.mockRejectedValueOnce(new Error('down'))
    renderSection()
    expect(await screen.findByText('Haven could not load your Stripe deposit addresses.')).toBeTruthy()
    serveList([ACTIVE])
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findAllByTestId('sales-deposit-address')).toHaveLength(1)
  })
})

describe('register', () => {
  it('posts the trimmed address, shows the result, and reads the list again', async () => {
    serveList([])
    mockPost.mockResolvedValue(ACTIVE)
    renderSection()
    await screen.findByTestId('sales-deposit-addresses-empty')
    await userEvent.click(screen.getByRole('button', { name: 'Register address' }))
    const dialog = await screen.findByRole('dialog', { name: 'Register a Stripe deposit address' })
    await userEvent.type(within(dialog).getByLabelText('Deposit address'), `  ${ACTIVE.address}  `)
    serveList([ACTIVE])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register address' }))

    expect(mockPost).toHaveBeenCalledWith('/merchant-deposit-addresses', { address: ACTIVE.address })
    expect(await within(dialog).findByText('Address registered')).toBeTruthy()
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    expect(await screen.findAllByTestId('sales-deposit-address')).toHaveLength(1)
  })

  it('catches a value that is not an address before any round trip', async () => {
    serveList([])
    renderSection()
    await screen.findByTestId('sales-deposit-addresses-empty')
    await userEvent.click(screen.getByRole('button', { name: 'Register address' }))
    const dialog = await screen.findByRole('dialog', { name: 'Register a Stripe deposit address' })
    await userEvent.type(within(dialog).getByLabelText('Deposit address'), '0x1234')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register address' }))
    expect(within(dialog).getByText(/This is not an address/)).toBeTruthy()
    expect(mockPost).not.toHaveBeenCalled()
  })

  // The last column: whether the list is read again (the outcome may already
  // be on it — unknown, or another tab's registration), or not (the request
  // was refused before anything could change).
  it.each([
    [refusal(400, 'INVALID_DEPOSIT_ADDRESS'), /This is not an address/, false],
    [refusal(409, 'DEPOSIT_ADDRESS_IS_OWN'), /one of your own accounts or agents/, false],
    [refusal(409, 'DEPOSIT_ADDRESS_ALREADY_REGISTERED'), /already registered to a Sales account/, true],
    [refusal(409, 'MERCHANT_ACCOUNT_REQUIRED'), /Turn Sales on/, true],
    [refusal(429), /Too many changes/, false],
    [refusal(422, undefined, 'A sentence the route sent.'), /A sentence the route sent\./, true],
    [refusal(502), /Haven did not answer/, true],
  ])('shows the route reason for a refused registration inside the dialog (%#)', async (err, words, rereads) => {
    serveList([])
    mockPost.mockRejectedValue(err)
    renderSection()
    await screen.findByTestId('sales-deposit-addresses-empty')
    await userEvent.click(screen.getByRole('button', { name: 'Register address' }))
    const dialog = await screen.findByRole('dialog', { name: 'Register a Stripe deposit address' })
    await userEvent.type(within(dialog).getByLabelText('Deposit address'), ACTIVE.address)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Register address' }))
    expect(await within(dialog).findByText(words)).toBeTruthy()
    // The raw code is never shown.
    expect(dialog.textContent).not.toMatch(/[A-Z]{3,}_[A-Z_]+/)
    // The error is the input's description, and the helper is not painted red beside it.
    const input = within(dialog).getByLabelText('Deposit address')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toBe('stripe-deposit-address-error')
    expect(within(dialog).queryByText('Registered by you, not verified by Haven.')).toBeNull()
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(rereads ? 2 : 1))
  })

  it('keys each address by its registration, so a reordered list keeps each row its own label and action', async () => {
    serveList([ACTIVE, RETIRED])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = renderSection()
    await screen.findAllByTestId('sales-deposit-address')
    // The retired one comes first after a re-read (a newer registration of the old address).
    serveList([RETIRED, ACTIVE])
    rerender(
      <LocaleProvider>
        <ToastProvider>
          <StripeDepositAddressesSection chainId={84532} key="reread" />
        </ToastProvider>
      </LocaleProvider>,
    )
    const rows = await screen.findAllByTestId('sales-deposit-address')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Retired')
    expect(rows[1].textContent).not.toContain('Retired')
    expect(screen.getAllByRole('button', { name: /^Retire / })).toHaveLength(1)
    expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
    errors.mockRestore()
  })
})

describe('retire', () => {
  it('asks first, posts the retirement, and reads the list again', async () => {
    serveList([ACTIVE])
    mockPost.mockResolvedValue({ ...ACTIVE, active: false, retired_at: '2026-11-18T10:00:00.000Z' })
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: /^Retire / }))
    const confirm = await screen.findByRole('dialog', { name: 'Retire this address?' })
    expect(confirm.textContent).toContain('The sales already received there stay')
    expect(mockPost).not.toHaveBeenCalled()
    serveList([{ ...ACTIVE, active: false, retired_at: '2026-11-18T10:00:00.000Z' }])
    await userEvent.click(within(confirm).getByRole('button', { name: 'Retire address' }))
    expect(mockPost).toHaveBeenCalledWith(`/merchant-deposit-addresses/${ACTIVE.id}/retire`, undefined)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Retire this address?' })).toBeNull())
    expect(await screen.findByText('Retired')).toBeTruthy()
  })

  it('shows a refused retirement inside the confirmation', async () => {
    serveList([ACTIVE])
    mockPost.mockRejectedValue(refusal(409, 'DEPOSIT_ADDRESS_RETIRED'))
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: /^Retire / }))
    const confirm = await screen.findByRole('dialog', { name: 'Retire this address?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Retire address' }))
    expect(await within(confirm).findByText('This address is already retired.')).toBeTruthy()
  })
})
