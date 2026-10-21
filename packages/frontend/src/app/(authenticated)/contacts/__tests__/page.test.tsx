import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseContacts, chainsState, urlState } = vi.hoisted(() => ({
  mockUseContacts: vi.fn(),
  chainsState: { map: new Map<string, number[]>() },
  // The page URL, read by `useListUrlState` through `next/navigation`.
  urlState: { query: '' },
}))

vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => mockUseContacts(),
}))

vi.mock('@/hooks/useContactChains', () => ({
  useContactChains: () => ({ chainsByAddress: chainsState.map, loading: false }),
}))

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

  it('renders saved recipients with visible row actions', () => {
    setupContacts({ contacts: [CONTACT] })

    render(<ContactsPage />)

    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.getByText('0x2222…2222')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Acme Services' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Acme Services' })).toBeInTheDocument()
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
