import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseContacts, chainsState, urlState, authState, mockToastSuccess, mockToastError } =
  vi.hoisted(() => ({
    mockUseContacts: vi.fn(),
    chainsState: { map: new Map<string, number[]>() },
    // The page URL, read by `useListUrlState` through `next/navigation`.
    urlState: { query: '' },
    // #4642: the accounts the shared money-action launcher reads.
    authState: { accounts: [] as unknown[] },
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  }))

vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => mockUseContacts(),
}))

vi.mock('@/hooks/useContactChains', () => ({
  useContactChains: () => ({ chainsByAddress: chainsState.map, loading: false }),
}))

// #4642: the launcher reads the signed-in user's accounts and asks the
// operation gate whether the selected one can sign. Both are mocked here so
// the page's own wiring is what the suite exercises.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1', accounts: authState.accounts }, passkeys: [] }),
}))

vi.mock('@/hooks/useAccountOperationGate', () => ({
  useAccountOperationGate: () => ({ kind: 'ready' }),
}))

// The Send dialog is the Send slice's (#4641); a marker carrying the account
// and the preset recipient is enough to pin the wiring.
vi.mock('@/components/DelegationSendModal', () => ({
  default: ({
    accountAddress,
    chainId,
    initialRecipient,
  }: {
    accountAddress?: string
    chainId?: number
    initialRecipient?: string
  }) => (
    <div data-testid="delegation-send-modal">{`${accountAddress ?? ''}|${chainId ?? ''}|${initialRecipient ?? ''}`}</div>
  ),
}))

vi.mock('@/components/ReceiveDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="receive-dialog" /> : null),
}))

// The toast is the app's announcement surface; the provider alone renders no
// items, so the calls are what this suite pins.
vi.mock('@/components/ui/Toast', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/Toast')>(
    '@/components/ui/Toast',
  )
  return {
    ...actual,
    useToast: () => ({
      toast: Object.assign(vi.fn(), {
        success: mockToastSuccess,
        error: mockToastError,
        info: vi.fn(),
      }),
    }),
  }
})

// `useChainScope` is deliberately NOT mocked — it is gone from the page
// (#4115): the network scope lives in the URL through the list-controls
// codec, so what is mocked is the router the codec reads.
vi.mock('next/navigation', () => ({
  usePathname: () => '/contacts',
  useSearchParams: () => new URLSearchParams(urlState.query),
}))

import ContactsPage from '../page'

const CONTACT = {
  id: 'contact-1',
  name: 'Acme Services',
  address: '0x2222222222222222222222222222222222222222',
  created_at: '2026-05-12T00:00:00Z',
  updated_at: '2026-05-12T00:00:00Z',
}

const ACCOUNT = {
  id: 'acc-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453 as number | undefined,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
  account_type: 'delegator_hybrid',
}

const SECOND_ACCOUNT = {
  ...ACCOUNT,
  id: 'acc-2',
  name: 'Savings',
  account_address: '0x4444444444444444444444444444444444444444',
  chain_id: 84532,
  is_default: false,
}

function setupContacts(overrides = {}) {
  const refetch = vi.fn().mockResolvedValue(undefined)
  const addContact = vi.fn().mockResolvedValue(CONTACT)
  mockUseContacts.mockReturnValue({
    contacts: [],
    loading: false,
    error: null,
    refetch,
    addContact,
    updateContact: vi.fn().mockResolvedValue(CONTACT),
    deleteContact: vi.fn().mockResolvedValue(undefined),
    resolveAddress: vi.fn(),
    ...overrides,
  })
  return { addContact, refetch }
}

const SECOND_CONTACT = {
  id: 'contact-2',
  name: 'Gnosis Vendor',
  address: '0x3333333333333333333333333333333333333333',
  created_at: '2026-05-12T00:00:00Z',
  updated_at: '2026-05-12T00:00:00Z',
}

describe('ContactsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chainsState.map = new Map()
    urlState.query = ''
    authState.accounts = [ACCOUNT]
    window.history.replaceState(null, '', '/contacts')
  })

  it('shows a retryable error state when contacts cannot load', () => {
    const { refetch } = setupContacts({
      error: 'We could not load your contacts. Try again in a moment.',
    })

    render(<ContactsPage />)

    expect(screen.getByText('Contacts could not load')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(refetch).toHaveBeenCalledOnce()
  })

  it('shows the empty state and opens the add contact modal', () => {
    setupContacts()

    render(<ContactsPage />)

    expect(screen.getByText('No saved recipients yet')).toBeInTheDocument()
    // A user with no contacts gets no toolbar: there is nothing to search.
    expect(screen.queryByTestId('list-toolbar')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add your first contact' }))

    expect(screen.getByRole('dialog', { name: 'Add contact' })).toBeInTheDocument()
    expect(screen.getByLabelText('Recipient address')).toBeInTheDocument()
  })

  it('submits a new contact with trimmed values', async () => {
    const { addContact } = setupContacts()

    render(<ContactsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Add your first contact' }))
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: '  Acme Services  ' } })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: `  ${CONTACT.address}  ` } })
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add contact' })).getByRole('button', { name: 'Add contact' }))

    await waitFor(() => {
      expect(addContact).toHaveBeenCalledWith('Acme Services', CONTACT.address)
    })
  })

  it('disables the header close button while a contact is saving (#4562)', async () => {
    let resolveAdd!: (value: unknown) => void
    setupContacts({
      addContact: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveAdd = resolve
          }),
      ),
    })

    render(<ContactsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Add your first contact' }))
    const dialog = screen.getByRole('dialog', { name: 'Add contact' })
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Acme Services' } })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: CONTACT.address } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add contact' }))

    // The ✕ is on by default now; this dialog guards Escape and the backdrop
    // with `!saving`, so the ✕ has to be guarded too.
    const closeButton = within(dialog).getByRole('button', { name: 'Close' })
    await waitFor(() => expect(closeButton).toBeDisabled())
    fireEvent.click(closeButton)
    expect(screen.getByRole('dialog', { name: 'Add contact' })).toBeInTheDocument()

    resolveAdd(CONTACT)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add contact' })).not.toBeInTheDocument())
  })

  it('renders saved recipients with a Send button and a ⋯ menu (#4642)', () => {
    setupContacts({ contacts: [CONTACT] })

    render(<ContactsPage />)

    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.getByText('0x2222…2222')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to Acme Services' })).toBeInTheDocument()

    // The three icon buttons are now menu items, not deleted.
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Acme Services' }))
    expect(screen.getByRole('menuitem', { name: 'Copy address' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('renders the row through the shared Row primitive, not a tinted hand-built box (#4642)', () => {
    setupContacts({ contacts: [CONTACT] })

    const { container } = render(<ContactsPage />)

    // The DS reserves `--v2-surface` for callouts and headers; the row's old
    // hover tint is gone. (The Send button's own ghost hover is the Button
    // primitive's, not the row's.)
    const row = container.querySelector('.divide-y > div') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.className).not.toContain('hover:bg-')
    // The Monogram rides the Row's leading slot, sized to the 36px mark.
    const leading = row.querySelector('.h-9.w-9')
    expect(leading).not.toBeNull()
    expect(leading!.querySelector('span')).not.toBeNull()
  })

  it('shows the chains a contact has activity on', () => {
    chainsState.map = new Map([[CONTACT.address.toLowerCase(), [100, 8453]]])
    setupContacts({ contacts: [CONTACT] })

    render(<ContactsPage />)

    // Scope to the "Used on" badge row so we don't match the facet's options.
    const badges = screen.getByText('Used on').parentElement as HTMLElement
    expect(within(badges).getByText('Base')).toBeInTheDocument()
    expect(within(badges).getByText('Gnosis Chain')).toBeInTheDocument()
  })

  it('renders the ListToolbar with the standard placeholder, and no hand-built input', () => {
    setupContacts({ contacts: [CONTACT] })

    render(<ContactsPage />)

    const search = screen.getByRole('searchbox', { name: 'Search contacts' })
    expect(search).toHaveAttribute('placeholder', 'Search contacts')
    // The fields the search matches are the accessible description, not the
    // placeholder.
    expect(screen.getByText('by name or address')).toHaveClass('sr-only')
    // The hand-built search is gone: no pl-9 Input with a floating icon.
    expect(screen.queryByLabelText('Search contacts', { selector: 'input[type="text"]' })).toBeNull()
  })

  it('filters by an address fragment', () => {
    chainsState.map = new Map([
      [CONTACT.address.toLowerCase(), [8453]],
      [SECOND_CONTACT.address.toLowerCase(), [100]],
    ])
    setupContacts({ contacts: [CONTACT, SECOND_CONTACT] })

    render(<ContactsPage />)

    expect(within(screen.getByTestId('list-summary')).getByTestId('list-toolbar-count')).toHaveTextContent(/^2 contacts$/)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search contacts' }), {
      target: { value: '2222' },
    })

    // Browser filtering: every keystroke re-renders the list.
    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.queryByText('Gnosis Vendor')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('list-summary')).getByTestId('list-toolbar-count')).toHaveTextContent(/^1 of 2 contacts$/)
  })

  it('offers the network facet only with more than one chain, and filters with it', async () => {
    chainsState.map = new Map([
      [CONTACT.address.toLowerCase(), [8453]],
      [SECOND_CONTACT.address.toLowerCase(), [100]],
    ])
    setupContacts({ contacts: [CONTACT, SECOND_CONTACT] })

    render(<ContactsPage />)

    // Default scope is "all" — both chains' contacts show.
    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.getByText('Gnosis Vendor')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Network: All$/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Gnosis Chain' }))

    expect(screen.getByText('Gnosis Vendor')).toBeInTheDocument()
    expect(screen.queryByText('Acme Services')).not.toBeInTheDocument()
    // The network scope round-trips through the URL under the key every
    // page uses.
    await waitFor(() => expect(window.location.search).toContain('chainId=100'))
  })

  it('hides the network facet when every contact is on one chain', () => {
    chainsState.map = new Map([[CONTACT.address.toLowerCase(), [8453]]])
    setupContacts({ contacts: [CONTACT] })

    render(<ContactsPage />)

    expect(screen.getByTestId('list-toolbar')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Network:/ })).toBeNull()
  })

  it('applies q and chainId read back from the URL', () => {
    chainsState.map = new Map([
      [CONTACT.address.toLowerCase(), [8453]],
      [SECOND_CONTACT.address.toLowerCase(), [100]],
    ])
    urlState.query = 'q=gnosis&chainId=100'
    setupContacts({ contacts: [CONTACT, SECOND_CONTACT] })

    render(<ContactsPage />)

    expect(screen.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('gnosis')
    expect(screen.getByText('Gnosis Vendor')).toBeInTheDocument()
    expect(screen.queryByText('Acme Services')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('list-summary')).getByTestId('list-toolbar-count')).toHaveTextContent(/^1 of 2 contacts$/)
  })

  it('drops a chainId that is not a network id instead of showing it as a filter', async () => {
    setupContacts({ contacts: [CONTACT] })

    urlState.query = 'chainId=abc'
    window.history.replaceState(null, '', '/contacts?chainId=abc')
    render(<ContactsPage />)

    await waitFor(() => expect(window.location.search).toBe(''))
    expect(screen.queryByRole('button', { name: /^Remove Network/ })).toBeNull()
    expect(within(screen.getByTestId('list-summary')).getByTestId('list-toolbar-count')).toHaveTextContent(/^1 contact$/)
  })

  it('shows the standard no-match state, and its Clear filters returns to the default', async () => {
    chainsState.map = new Map([
      [CONTACT.address.toLowerCase(), [8453]],
      [SECOND_CONTACT.address.toLowerCase(), [100]],
    ])
    urlState.query = 'q=zzz'
    window.history.replaceState(null, '', '/contacts?q=zzz')
    setupContacts({ contacts: [CONTACT, SECOND_CONTACT] })

    render(<ContactsPage />)

    expect(screen.getByText('No contacts match these filters')).toBeInTheDocument()
    expect(
      screen.getByText('Try a different search, or clear filters to see everything.'),
    ).toBeInTheDocument()
    // The toolbar stays, so the cause stays editable.
    expect(screen.getByTestId('list-toolbar')).toBeInTheDocument()

    fireEvent.click(
      within(screen.getByTestId('contacts-no-match')).getByRole('button', { name: 'Clear filters' }),
    )
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(screen.getByRole('searchbox', { name: 'Search contacts' })).toHaveValue('')
    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.getByText('Gnosis Vendor')).toBeInTheDocument()
  })
})

/**
 * #4570: the contact delete is a `ConfirmDialog`, not a bespoke `Modal`. The
 * dialog carries the delete's own busy verb and its failure, so neither is
 * lost by moving onto the shared component.
 *
 * #4642: Delete moved into the row's ⋯ menu, so the dialog is reached through
 * it — the confirmation itself is unchanged.
 */
describe('ContactsPage — delete confirmation (#4570)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chainsState.map = new Map()
    urlState.query = ''
    authState.accounts = [ACCOUNT]
    window.history.replaceState(null, '', '/contacts')
  })

  function openDeleteDialog() {
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Acme Services' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    return screen.getByRole('dialog', { name: 'Delete contact' })
  }

  it('renders the shared ConfirmDialog with the contact named in the body', () => {
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    const dialog = openDeleteDialog()

    expect(within(dialog).getByText(/This removes the saved\s+name from Haven/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Delete contact' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('shows "Deleting…" on the confirm button while the delete is in flight', async () => {
    let resolveDelete!: () => void
    const deleteContact = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )
    setupContacts({ contacts: [CONTACT], deleteContact })
    render(<ContactsPage />)

    const dialog = openDeleteDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete contact' }))

    // The dialog's own verb, not ConfirmDialog's generic "Working…".
    const busy = await within(dialog).findByRole('button', { name: 'Deleting…' })
    expect(busy).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Working…' })).not.toBeInTheDocument()

    resolveDelete()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete contact' })).not.toBeInTheDocument())
  })

  it('shows the failure inside the dialog and keeps it open', async () => {
    const deleteContact = vi.fn().mockRejectedValue(new Error('nope'))
    setupContacts({ contacts: [CONTACT], deleteContact })
    render(<ContactsPage />)

    const dialog = openDeleteDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete contact' }))

    expect(
      await within(dialog).findByText('We could not delete this contact. Try again.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Delete contact' })).toBeInTheDocument()
    // The action is available again for a retry.
    expect(within(dialog).getByRole('button', { name: 'Delete contact' })).toBeEnabled()
  })
})

/**
 * #4642 — Send from a contact, the ⋯ menu's Copy address, and the null-chain
 * rule.
 *
 * The launcher is the dashboard's, extracted (#4642): one account opens Send
 * directly, two ask through the account picker first, and an account with no
 * resolved chain cannot send at all.
 */
describe('ContactsPage — Send and the row menu (#4642)', () => {
  const originalClipboard = navigator.clipboard
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    chainsState.map = new Map()
    urlState.query = ''
    authState.accounts = [ACCOUNT]
    window.history.replaceState(null, '', '/contacts')
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
  })

  it('pins the subtitle and the empty-state body to the exact copy', () => {
    setupContacts()
    render(<ContactsPage />)

    expect(
      screen.getByText(
        'Save the wallet addresses you pay often. Haven shows their names in Send, on the review screen and in your transactions.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Add a contact for any wallet address you pay often. Haven shows the name in Send, on the review screen and in your transactions.',
      ),
    ).toBeInTheDocument()
  })

  it('with one valid account, Send opens the Send dialog with the contact preset', () => {
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Send to Acme Services' }))

    const send = screen.getByTestId('delegation-send-modal')
    expect(send).toHaveTextContent(`${ACCOUNT.account_address}|${ACCOUNT.chain_id}|${CONTACT.address}`)
    // One account: the picker never enters it.
    expect(screen.queryByRole('heading', { name: 'Choose an account to send from' })).toBeNull()
  })

  it('with two valid accounts, the picker opens first and then Send carries the preset', () => {
    authState.accounts = [ACCOUNT, SECOND_ACCOUNT]
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Send to Acme Services' }))

    // The picker asks first; the Send dialog is not mounted yet.
    expect(screen.getByRole('heading', { name: 'Choose an account to send from' })).toBeInTheDocument()
    expect(screen.queryByTestId('delegation-send-modal')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Savings/ }))

    const send = screen.getByTestId('delegation-send-modal')
    expect(send).toHaveTextContent(
      `${SECOND_ACCOUNT.account_address}|${SECOND_ACCOUNT.chain_id}|${CONTACT.address}`,
    )
  })

  it('with one account and no resolved chain, Send is disabled and its reason is described', () => {
    authState.accounts = [{ ...ACCOUNT, chain_id: undefined }]
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    const send = screen.getByRole('button', { name: 'Send to Acme Services' })
    expect(send).toBeDisabled()

    const describedBy = send.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const reason = document.getElementById(describedBy!)
    expect(reason).not.toBeNull()
    expect(reason).toHaveTextContent("No network yet. You can't send from this account.")
  })

  it('with a mixed two-account set, the null-chain row is non-interactive and the valid one sends', () => {
    authState.accounts = [{ ...SECOND_ACCOUNT, chain_id: undefined }, ACCOUNT]
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    // One account can send, so the row's Send stays enabled.
    const send = screen.getByRole('button', { name: 'Send to Acme Services' })
    expect(send).toBeEnabled()
    expect(send).not.toHaveAttribute('aria-describedby')

    fireEvent.click(send)

    // The null-chain account is a static row carrying its reason, not a button.
    expect(screen.getByText("No network yet. You can't send from this account.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Savings/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Main account/ }))

    const modal = screen.getByTestId('delegation-send-modal')
    expect(modal).toHaveTextContent(`${ACCOUNT.account_address}|${ACCOUNT.chain_id}|${CONTACT.address}`)
  })

  it('with several accounts and none resolved, Send is disabled with a reason', () => {
    authState.accounts = [
      { ...ACCOUNT, chain_id: undefined },
      { ...SECOND_ACCOUNT, chain_id: undefined },
    ]
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    const send = screen.getByRole('button', { name: 'Send to Acme Services' })
    expect(send).toBeDisabled()
    const reason = document.getElementById(send.getAttribute('aria-describedby')!)
    expect(reason).toHaveTextContent("None of your accounts has a network yet. You can't send from them.")
  })

  it('Copy address writes through the clipboard hook and announces success', async () => {
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Acme Services' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy address' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CONTACT.address))
    expect(mockToastSuccess).toHaveBeenCalledWith('Address copied.')
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('Copy address announces a failure with the full address to copy by hand', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Acme Services' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy address' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    const message = mockToastError.mock.calls[0][0] as string
    expect(message).toContain(CONTACT.address)
    expect(mockToastSuccess).not.toHaveBeenCalled()
  })

  it('Edit in the menu opens the edit dialog', () => {
    setupContacts({ contacts: [CONTACT] })
    render(<ContactsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Acme Services' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))

    expect(screen.getByRole('dialog', { name: 'Edit contact' })).toBeInTheDocument()
  })
})
