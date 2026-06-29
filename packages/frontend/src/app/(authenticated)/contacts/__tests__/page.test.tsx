import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseContacts, chainsState, scopeState, mockSetScope } = vi.hoisted(() => ({
  mockUseContacts: vi.fn(),
  chainsState: { map: new Map<string, number[]>() },
  scopeState: { scope: 'all' as number | 'all' },
  mockSetScope: vi.fn(),
}))

vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => mockUseContacts(),
}))

vi.mock('@/hooks/useContactChains', () => ({
  useContactChains: () => ({ chainsByAddress: chainsState.map, loading: false }),
}))

vi.mock('@/hooks/useActiveChain', () => ({
  useChainScope: () => ({
    scope: scopeState.scope,
    setScope: mockSetScope,
    activeChainId: 8453,
    chains: [],
  }),
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
    scopeState.scope = 'all'
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
    expect(screen.getByText('0x2222...2222')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Acme Services' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Acme Services' })).toBeInTheDocument()
  })

  it('shows the chains a contact has activity on', () => {
    chainsState.map = new Map([[CONTACT.address.toLowerCase(), [100, 8453]]])
    setupContacts({ contacts: [CONTACT] })

    render(<ContactsPage />)

    // Scope to the "Used on" badge row so we don't match the filter dropdown's options.
    const badges = screen.getByText('Used on').parentElement as HTMLElement
    expect(within(badges).getByText('Base')).toBeInTheDocument()
    expect(within(badges).getByText('Gnosis Chain')).toBeInTheDocument()
  })

  it('offers a network filter and never collapses to the active chain by default', () => {
    chainsState.map = new Map([
      [CONTACT.address.toLowerCase(), [8453]],
      [SECOND_CONTACT.address.toLowerCase(), [100]],
    ])
    setupContacts({ contacts: [CONTACT, SECOND_CONTACT] })

    render(<ContactsPage />)

    // Default scope is "all" — both chains' contacts show regardless of active chain.
    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.getByText('Gnosis Vendor')).toBeInTheDocument()

    const select = screen.getByLabelText('Filter contacts by network')
    fireEvent.change(select, { target: { value: '100' } })
    expect(mockSetScope).toHaveBeenCalledWith(100)
  })

  it('filters to contacts with activity on the selected chain', () => {
    chainsState.map = new Map([
      [CONTACT.address.toLowerCase(), [8453]],
      [SECOND_CONTACT.address.toLowerCase(), [100]],
    ])
    scopeState.scope = 8453 // manual override active
    setupContacts({ contacts: [CONTACT, SECOND_CONTACT] })

    render(<ContactsPage />)

    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.queryByText('Gnosis Vendor')).not.toBeInTheDocument()
  })
})
