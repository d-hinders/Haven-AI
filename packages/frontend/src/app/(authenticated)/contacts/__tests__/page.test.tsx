import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseContacts = vi.fn()

vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => mockUseContacts(),
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
  mockUseContacts.mockReturnValue({
    contacts: [],
    loading: false,
    error: null,
    refetch,
    addContact: vi.fn().mockResolvedValue(CONTACT),
    updateContact: vi.fn().mockResolvedValue(CONTACT),
    deleteContact: vi.fn().mockResolvedValue(undefined),
    resolveAddress: vi.fn(),
    ...overrides,
  })
  return { refetch }
}

describe('ContactsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('renders saved recipients with visible row actions', () => {
    setupContacts({ contacts: [CONTACT] })

    render(<ContactsPage />)

    expect(screen.getByText('Acme Services')).toBeInTheDocument()
    expect(screen.getByText('0x2222...2222')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Acme Services' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Acme Services' })).toBeInTheDocument()
  })
})
