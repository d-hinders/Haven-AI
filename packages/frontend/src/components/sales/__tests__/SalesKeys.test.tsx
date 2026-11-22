import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Sales key screens (#4905): the list, create with the secret shown once,
 * the close guard, revoke, and the secret hygiene the issue names.
 */

const SECRET = 'sk_merchant_4f2a9c7e1b05d3f8a6e2c94b7d10f58e3a6c2b9d7e41f0a8'
const PREFIX = 'sk_merchant_4f2a9c7e1b05'
// #4905 review: a key is named by its first 16 characters on screen.
const LABEL = 'sk_merchant_4f2a…'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockDelete = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    get: (path: string) => mockGet(path),
    post: (path: string) => mockPost(path),
    delete: (path: string) => mockDelete(path),
  },
}))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }) }),
}))
vi.mock('@/context/AuthContext', () => ({ useOptionalAuth: () => ({ user: { id: 'u1' } }) }))

import { ApiRequestError } from '@/lib/api'
import { LocaleProvider } from '@/context/LocaleContext'
import { SalesKeysSection } from '../SalesKeysSection'

/** #5038: a lost answer says to check the list, never "Nothing was created". */
const CREATE_UNKNOWN = 'Haven did not answer, so the key may have been created.'
const REVOKE_UNKNOWN = 'Haven did not answer, so the key may have been revoked.'

const live = {
  id: 'k1',
  key_prefix: PREFIX,
  created_by: 'u1',
  created_at: '2026-11-12T09:00:00.000Z',
  revoked_by: null,
  revoked_at: null,
  last_used_at: null,
}
const revoked = {
  ...live,
  id: 'k2',
  key_prefix: 'sk_merchant_07de00000000',
  revoked_by: 'u1',
  revoked_at: '2026-11-13T09:00:00.000Z',
}

let storageWrites: string[]
let consoleCalls: string[]
let clipboard: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ keys: [live, revoked] })
  mockPost.mockReset().mockResolvedValue({ ...live, id: 'k3', secret: SECRET })
  mockDelete.mockReset().mockResolvedValue({})
  toastSuccess.mockReset()
  toastError.mockReset()
  storageWrites = []
  consoleCalls = []
  for (const store of [Storage.prototype]) {
    vi.spyOn(store, 'setItem').mockImplementation((key, value) => {
      storageWrites.push(`${key}=${value}`)
    })
  }
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args.map(String).join(' '))
    })
  }
  clipboard = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  window.history.replaceState(null, '', '/sales?tab=setup')
})

afterEach(() => vi.restoreAllMocks())

async function renderSection() {
  render(
    <LocaleProvider>
      <SalesKeysSection />
    </LocaleProvider>,
  )
  await screen.findByText(`${LABEL}`)
}

async function openCreated() {
  await renderSection()
  await userEvent.click(screen.getByRole('button', { name: 'Create Sales key' }))
  const dialog = screen.getByRole('dialog', { name: 'Create Sales key' })
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create Sales key' }))
  return screen.findByRole('dialog', { name: 'Your new Sales key' })
}

describe('the list', () => {
  it('shows each key by prefix, who made it, last used, a Revoked badge, and Revoke only on live keys', async () => {
    await renderSection()
    const list = screen.getByTestId('sales-keys-list')
    expect(list.textContent).toContain('Created by you, 12 Nov')
    expect(list.textContent).toContain('Never used')
    expect(within(list).getByText('Revoked')).toBeTruthy()
    expect(list.textContent).toContain('Revoked by you, 13 Nov')
    expect(within(list).getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'What a key can do' }).getAttribute('href')).toMatch(/merchant-key-limits\.md$/)
  })

  it('has an empty state and an error state, and never an empty list that hides a failed read', async () => {
    mockGet.mockResolvedValue({ keys: [] })
    const { unmount } = render(
      <LocaleProvider>
        <SalesKeysSection />
      </LocaleProvider>,
    )
    expect(await screen.findByText(/No Sales keys yet/)).toBeTruthy()
    unmount()
    mockGet.mockRejectedValue(new Error('boom'))
    render(
      <LocaleProvider>
        <SalesKeysSection />
      </LocaleProvider>,
    )
    expect(await screen.findByText('Your Sales keys could not load. Your payments are unchanged.')).toBeTruthy()
  })
})

describe('create', () => {
  it('the create screen shows the intro and one can’t sentence in the Setup tab wording, with no Can / Can’t rows (#4984)', async () => {
    await renderSection()
    await userEvent.click(screen.getByRole('button', { name: 'Create Sales key' }))
    const dialog = screen.getByRole('dialog', { name: 'Create Sales key' })

    expect(dialog.textContent).toContain('Your seller uses a Sales key to report what each payment was for.')
    expect(dialog.textContent).toContain(
      'A key can’t move money, sign, or see anything but this account’s sales.',
    )
    // One wording, not two: the Setup tab carries the same sentence.
    expect(screen.getByTestId('sales-keys-section').textContent).toContain(
      'A key can’t move money, sign, or see anything but this account’s sales.',
    )
    expect(dialog.querySelector('dl')).toBeNull()
  })

  it('the created screen renders no DetailList and no Can / Can’t label (#4984)', async () => {
    const dialog = await openCreated()
    const text = dialog.textContent ?? ''

    expect(dialog.querySelector('dl')).toBeNull()
    // Both apostrophes: the code uses U+2019, and a plain ' must not slip in.
    expect(text).not.toMatch(/Can[’']t/)
    expect(text).not.toMatch(/\bCan\b/)
  })

  it('shows the secret once, and Copy copies exactly it', async () => {
    const dialog = await openCreated()
    expect(mockPost).toHaveBeenCalledWith('/merchant-keys')
    expect(dialog.textContent).toContain(SECRET)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy Sales key' }))
    expect(clipboard).toHaveBeenCalledWith(SECRET)
  })

  it('asks before closing an uncopied key, and keeps it when the answer is Cancel', async () => {
    const dialog = await openCreated()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    const guard = screen.getByTestId('sales-key-close-guard')
    expect(guard.textContent).toContain('Close without copying the key?')
    await userEvent.click(within(guard).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog', { name: 'Your new Sales key' }).textContent).toContain(SECRET)
  })

  it('closes without asking after a copy; the secret is gone from the page and the list shows only the prefix', async () => {
    const dialog = await openCreated()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy Sales key' }))
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
    // The second view: a new dialog starts at the ask screen, with no secret.
    await userEvent.click(screen.getByRole('button', { name: 'Create Sales key' }))
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('"Close anyway" drops the secret', async () => {
    const dialog = await openCreated()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close anyway' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('explains a 409 inside the dialog and leaves it on the ask screen', async () => {
    mockPost.mockRejectedValue(new ApiRequestError('no account', 409, { error: 'no account', error_code: 'MERCHANT_ACCOUNT_REQUIRED' }))
    await renderSection()
    await userEvent.click(screen.getByRole('button', { name: 'Create Sales key' }))
    const dialog = screen.getByRole('dialog', { name: 'Create Sales key' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Sales key' }))
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Turn on Sales in Settings/)
    expect(screen.getByRole('dialog', { name: 'Create Sales key' })).toBeTruthy()
  })

  it('says the outcome is unknown, never "Nothing was created", when the answer is lost, and re-reads the list (#5038)', async () => {
    mockPost.mockRejectedValue(new TypeError('Failed to fetch'))
    await renderSection()
    const reads = mockGet.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Create Sales key' }))
    const dialog = screen.getByRole('dialog', { name: 'Create Sales key' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Sales key' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain(CREATE_UNKNOWN)
    expect(alert.textContent).not.toContain('Nothing was created')
    // The key may exist: the list is re-read even though the create failed.
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(reads))
  })

  it('says the same for a 5xx, which may have committed before it answered (#5038)', async () => {
    mockPost.mockRejectedValue(new ApiRequestError('unavailable', 502))
    await renderSection()
    const reads = mockGet.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Create Sales key' }))
    const dialog = screen.getByRole('dialog', { name: 'Create Sales key' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Sales key' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain(CREATE_UNKNOWN)
    expect(alert.textContent).not.toContain('Nothing was created')
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(reads))
  })

  it('keeps "Nothing was created" for a 4xx, which did not commit (#5038)', async () => {
    mockPost.mockRejectedValue(new ApiRequestError('bad request', 400))
    await renderSection()
    await userEvent.click(screen.getByRole('button', { name: 'Create Sales key' }))
    const dialog = screen.getByRole('dialog', { name: 'Create Sales key' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Sales key' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('Nothing was created')
    expect(alert.textContent).not.toContain(CREATE_UNKNOWN)
  })

  it('never writes the secret to storage, the console or the URL', async () => {
    const dialog = await openCreated()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy Sales key' }))
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(storageWrites.join('\n')).not.toContain(SECRET)
    expect(consoleCalls.join('\n')).not.toContain(SECRET)
    expect(window.location.href).not.toContain(SECRET)
    // The re-read after the create is the list: prefixes only.
    expect(JSON.stringify(mockGet.mock.results)).not.toContain(SECRET)
  })
})

describe('revoke', () => {
  it('says what stops, then DELETEs, toasts and re-reads', async () => {
    await renderSection()
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    const dialog = screen.getByRole('dialog', { name: `Revoke ${LABEL}?` })
    expect(dialog.textContent).toContain('Your seller stops being able to report sales with this key straight away.')
    const reads = mockGet.mock.calls.length
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/merchant-keys/k1'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Key revoked.'))
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(reads))
  })

  it('keeps the dialog open and says the outcome is unknown when the answer is lost (#5038)', async () => {
    mockDelete.mockRejectedValue(new Error('down'))
    await renderSection()
    const reads = mockGet.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }))
    expect(await screen.findByText(new RegExp(REVOKE_UNKNOWN))).toBeTruthy()
    expect(screen.queryByText(/could not revoke the key/)).toBeNull()
    expect(toastSuccess).not.toHaveBeenCalled()
    // The revoke may have committed: the list is re-read even though it failed.
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(reads))
  })

  it('keeps "It still works" for a 4xx, which did not commit (#5038)', async () => {
    mockDelete.mockRejectedValue(new ApiRequestError('refused', 409))
    await renderSection()
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }))
    expect(await screen.findByText(/could not revoke the key/)).toBeTruthy()
    expect(screen.queryByText(new RegExp(REVOKE_UNKNOWN))).toBeNull()
  })

  it('does not carry a failed revoke\'s error into the next confirm (#4905 review)', async () => {
    mockDelete.mockRejectedValue(new Error('down'))
    await renderSection()
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }))
    expect(await screen.findByText(new RegExp(REVOKE_UNKNOWN))).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(screen.getByRole('dialog', { name: `Revoke ${LABEL}?` })).toBeTruthy()
    expect(screen.queryByText(new RegExp(REVOKE_UNKNOWN))).toBeNull()
  })
})
