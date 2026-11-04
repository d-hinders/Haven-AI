import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RecipientField, type Recipient, type RecipientFieldProps } from '../RecipientField'
import type { Contact } from '@/hooks/useContacts'
import type { SmartAccount } from '@/context/AuthContext'

const SENDING = '0x1111111111111111111111111111111111111111'
// EIP-55 checksummed, so `isAddress` accepts the mixed-case form as well as the
// lowercase one — the paste branch is what these fixtures have to exercise.
const SAVINGS = '0x7A58f0D1c9B4e2A6837F5C1d0E9b4a2C6d8191C2'
const ACME = '0x2c9D0000000000000000000000000000000077ab'
const RESEARCH = '0x31bc000000000000000000000000000000008d04'
const UNKNOWN = '0x3b7E00000000000000000000000000000000D09a'

function account(overrides: Partial<SmartAccount> & Pick<SmartAccount, 'id' | 'account_address' | 'name'>): SmartAccount {
  return {
    chain_id: 8453,
    is_default: false,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function contact(overrides: Partial<Contact> & Pick<Contact, 'id' | 'name' | 'address'>): Contact {
  return {
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const ACCOUNTS: SmartAccount[] = [
  account({ id: 'a1', account_address: SENDING, name: 'Operating wallet', is_default: true }),
  account({ id: 'a2', account_address: SAVINGS, name: 'Savings' }),
  // A different chain: never offered.
  account({ id: 'a3', account_address: '0x9999999999999999999999999999999999999999', name: 'Mainnet account', chain_id: 1 }),
]

const CONTACTS: Contact[] = [
  contact({ id: 'c1', name: 'Acme Services', address: ACME }),
  contact({ id: 'c2', name: 'Research API', address: RESEARCH }),
]

function Harness({
  onChange,
  ...rest
}: Partial<RecipientFieldProps> & { onChange?: (next: Recipient | null) => void }) {
  const [value, setValue] = useState<Recipient | null>(null)
  return (
    <RecipientField
      chainId={8453}
      excludeAddress={SENDING}
      accounts={ACCOUNTS}
      contacts={CONTACTS}
      contactsLoading={false}
      contactsError={null}
      {...rest}
      value={value}
      onChange={(next) => {
        onChange?.(next)
        setValue(next)
      }}
    />
  )
}

function focusInput() {
  const input = screen.getByRole('combobox', { name: 'Recipient' })
  fireEvent.focus(input)
  return input
}

describe('RecipientField — grouping and filtering', () => {
  it('offers your accounts on this chain, then your contacts, and never the sending account', () => {
    render(<Harness />)
    focusInput()

    const accounts = screen.getByRole('group', { name: 'Your accounts' })
    const contacts = screen.getByRole('group', { name: 'Contacts' })

    expect(within(accounts).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Savings'),
    ])
    expect(within(contacts).getAllByRole('option')).toHaveLength(2)
    // The sending account and the other chain's account are both absent.
    expect(screen.queryByText('Operating wallet')).not.toBeInTheDocument()
    expect(screen.queryByText('Mainnet account')).not.toBeInTheDocument()
  })

  it('filters by name or address prefix, case-insensitively', () => {
    render(<Harness />)
    const input = focusInput()

    fireEvent.change(input, { target: { value: 'acme' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Acme Services/ })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '0X31BC' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Research API/ })).toBeInTheDocument()
  })

  it('shows the footer line', () => {
    render(<Harness />)
    focusInput()
    expect(screen.getByText('Or paste a wallet address')).toBeInTheDocument()
  })
})

describe('RecipientField — pasting', () => {
  it('collapses to a saved contact for a known address in mixed case', () => {
    render(<Harness />)
    const input = focusInput()

    // The EIP-55 checksummed form — mixed case, and `isAddress` accepts it.
    fireEvent.change(input, { target: { value: ACME } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Acme Services')
    expect(options[0]).toHaveTextContent('Saved contact')

    // The same address in lower case resolves to the same entry.
    fireEvent.change(input, { target: { value: ACME.toLowerCase() } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Acme Services/ })).toBeInTheDocument()
  })

  it('offers a new address as one option', () => {
    render(<Harness />)
    const input = focusInput()

    fireEvent.change(input, { target: { value: UNKNOWN } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Send to 0x3b7E…D09a')
    expect(options[0]).toHaveTextContent('New address')
  })

  it('resolves an address that is both an own account and a contact as the account', () => {
    const contacts = [...CONTACTS, contact({ id: 'c3', name: 'Savings (saved)', address: SAVINGS })]
    render(<Harness contacts={contacts} />)
    const input = focusInput()

    fireEvent.change(input, { target: { value: SAVINGS.toLowerCase() } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Savings')
    expect(options[0]).toHaveTextContent('Your account')
    expect(options[0]).not.toHaveTextContent('Savings (saved)')
  })
})

describe('RecipientField — the reported value', () => {
  it('reports { address, name, kind } for a picked account', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    focusInput()

    fireEvent.click(screen.getByRole('option', { name: /Savings/ }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ address: SAVINGS, name: 'Savings', kind: 'account' })
  })

  it('reports a pasted new address with kind "new" and no name', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const input = focusInput()

    fireEvent.change(input, { target: { value: UNKNOWN } })
    fireEvent.click(screen.getByRole('option', { name: /Send to/ }))
    expect(onChange).toHaveBeenCalledWith({ address: UNKNOWN, kind: 'new' })
  })

  it('renders the chosen recipient as a chip and clears it with Change recipient', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    focusInput()

    fireEvent.click(screen.getByRole('option', { name: /Acme Services/ }))
    const chip = document.querySelector('[data-recipient-chip]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip).toHaveTextContent('Acme Services')
    expect(chip).toHaveTextContent('Saved contact')
    expect(chip).toHaveTextContent('0x2c9D…77ab')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Change recipient' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(document.querySelector('[data-recipient-chip]')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Recipient' })).toHaveFocus()
  })

  it('renders a new address with a neutral wallet glyph', () => {
    render(<Harness />)
    const input = focusInput()
    fireEvent.change(input, { target: { value: UNKNOWN } })
    fireEvent.click(screen.getByRole('option', { name: /Send to/ }))

    const chip = document.querySelector('[data-recipient-chip]') as HTMLElement
    expect(chip).toHaveTextContent('0x3b7E…D09a')
    expect(chip).toHaveTextContent('New address')
    // No Monogram for an address nobody has named.
    expect(chip.querySelector('.rounded-full')).not.toBeNull()
    expect(chip.querySelector('svg')).not.toBeNull()
  })
})

describe('RecipientField — presetAddress', () => {
  it('shows the short address before the data loads, then resolves to the named chip, calling onChange once', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Harness presetAddress={ACME} contacts={[]} contactsLoading onChange={onChange} />,
    )

    // Before the data arrives: the short address, no name, and no claim about
    // the kind, because a saved contact is not "New address" (epic #4637).
    const chip = document.querySelector('[data-recipient-chip]') as HTMLElement
    expect(chip).toHaveTextContent('0x2c9D…77ab')
    expect(chip).not.toHaveTextContent('New address')
    expect(chip.querySelector('[data-recipient-chip-loading]')).not.toBeNull()
    expect(onChange).not.toHaveBeenCalled()

    rerender(<Harness presetAddress={ACME} contacts={CONTACTS} contactsLoading={false} onChange={onChange} />)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ address: ACME, name: 'Acme Services', kind: 'contact' })
    const resolved = document.querySelector('[data-recipient-chip]') as HTMLElement
    expect(resolved).toHaveTextContent('Acme Services')
    expect(resolved).toHaveTextContent('Saved contact')
    expect(resolved).not.toHaveAttribute('aria-busy')
  })

  it('resolves a preset that is both an own account and a contact as the account', () => {
    const onChange = vi.fn()
    render(
      <Harness
        presetAddress={SAVINGS}
        contacts={[contact({ id: 'c3', name: 'Savings as a contact', address: SAVINGS })]}
        onChange={onChange}
      />,
    )
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ address: SAVINGS, name: 'Savings', kind: 'account' })
  })

  it('draws no new-address glyph while the preset is being looked up', () => {
    render(<Harness presetAddress={ACME} contacts={[]} contactsLoading />)
    const chip = document.querySelector('[data-recipient-chip]') as HTMLElement
    // The one icon left is the Change recipient ✕; the slot holds a skeleton disc.
    expect(chip.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Change recipient' }).querySelector('svg')).not.toBeNull()
    expect(chip.querySelector('.animate-pulse.rounded-full')).not.toBeNull()
    expect(chip).toHaveAttribute('aria-busy', 'true')
  })

  it('resolves a preset address that is an own account as the account', () => {
    const onChange = vi.fn()
    render(<Harness presetAddress={SAVINGS} onChange={onChange} />)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ address: SAVINGS, name: 'Savings', kind: 'account' })
  })

  it('keeps a cleared preset chip cleared, even though presetAddress is still a prop', () => {
    const onChange = vi.fn()
    render(<Harness presetAddress={ACME} onChange={onChange} />)
    expect(document.querySelector('[data-recipient-chip]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Change recipient' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(document.querySelector('[data-recipient-chip]')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Recipient' })).toBeInTheDocument()
  })
})

describe('RecipientField — a cleared chip stays cleared (#4660)', () => {
  const chip = () => document.querySelector('[data-recipient-chip]')
  const clear = () => fireEvent.click(screen.getByRole('button', { name: 'Change recipient' }))
  const neverReportedPreset = (onChange: ReturnType<typeof vi.fn>) =>
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ address: ACME }))

  it('does not come back when contacts finish loading after the user cleared it', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Harness presetAddress={ACME} contacts={[]} contactsLoading onChange={onChange} />,
    )
    clear()
    expect(chip()).toBeNull()

    rerender(<Harness presetAddress={ACME} contacts={CONTACTS} contactsLoading={false} onChange={onChange} />)

    expect(chip()).toBeNull()
    neverReportedPreset(onChange)
  })

  it('does not come back when the contacts fetch fails after the user cleared it', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Harness presetAddress={ACME} contacts={[]} contactsLoading onChange={onChange} />,
    )
    clear()

    rerender(
      <Harness presetAddress={ACME} contacts={[]} contactsLoading={false} contactsError="Nope" onChange={onChange} />,
    )

    expect(chip()).toBeNull()
    neverReportedPreset(onChange)
  })

  it('a picked recipient cleared is not replaced by the preset, contacts loaded', () => {
    const onChange = vi.fn()
    render(<Harness presetAddress={ACME} onChange={onChange} />)
    clear()
    onChange.mockClear()

    fireEvent.click(screen.getByRole('option', { name: /Research API/ }))
    expect(chip()).toHaveTextContent('Research API')
    clear()

    expect(chip()).toBeNull()
    neverReportedPreset(onChange)
  })

  it('a picked recipient cleared is not replaced by the preset, contacts still loading', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Harness presetAddress={ACME} contacts={[]} contactsLoading onChange={onChange} />,
    )
    clear()

    fireEvent.click(screen.getByRole('option', { name: /Savings/ }))
    expect(chip()).toHaveTextContent('Savings')
    clear()
    expect(chip()).toBeNull()

    rerender(<Harness presetAddress={ACME} contacts={CONTACTS} contactsLoading={false} onChange={onChange} />)
    expect(chip()).toBeNull()
    neverReportedPreset(onChange)
  })

  it('a recipient picked while contacts load, cleared after they settle, is not replaced by the preset', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Harness presetAddress={ACME} contacts={[]} contactsLoading onChange={onChange} />,
    )
    clear()
    fireEvent.click(screen.getByRole('option', { name: /Savings/ }))

    rerender(<Harness presetAddress={ACME} contacts={CONTACTS} contactsLoading={false} onChange={onChange} />)
    expect(chip()).toHaveTextContent('Savings')
    clear()

    expect(chip()).toBeNull()
    neverReportedPreset(onChange)
  })

  it('a new preset address after a dismissal still shows and resolves, contacts loaded', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Harness presetAddress={ACME} onChange={onChange} />)
    clear()

    rerender(<Harness presetAddress={RESEARCH} onChange={onChange} />)

    expect(chip()).toHaveTextContent('Research API')
    expect(onChange).toHaveBeenLastCalledWith({ address: RESEARCH, name: 'Research API', kind: 'contact' })
  })

  it('a new preset address after a dismissal shows at once while contacts load, then resolves', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Harness presetAddress={ACME} contacts={[]} contactsLoading onChange={onChange} />,
    )
    clear()

    rerender(<Harness presetAddress={RESEARCH} contacts={[]} contactsLoading onChange={onChange} />)
    expect(chip()).toHaveTextContent('0x31bc…8d04')

    rerender(<Harness presetAddress={RESEARCH} contacts={CONTACTS} contactsLoading={false} onChange={onChange} />)
    expect(chip()).toHaveTextContent('Research API')
    neverReportedPreset(onChange)
  })
})

describe('RecipientField — Enter picks a pasted address', () => {
  it.each<[string, Partial<RecipientFieldProps>]>([
    ['contacts loaded', {}],
    ['contacts loading', { contacts: [], contactsLoading: true }],
    ['contacts failed', { contacts: [], contactsError: 'Nope' }],
  ])('with %s', (_name, props) => {
    const onChange = vi.fn()
    render(<Harness {...props} onChange={onChange} />)
    const input = focusInput()
    fireEvent.change(input, { target: { value: UNKNOWN } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith({ address: UNKNOWN, kind: 'new' })
  })
})

describe('RecipientField — contacts loading and failing', () => {
  it('shows a one-line skeleton while contacts load, and keeps your accounts working', () => {
    render(<Harness contacts={[]} contactsLoading />)
    focusInput()

    expect(document.querySelector('[data-combobox-status="loading"]')).not.toBeNull()
    expect(screen.getByRole('group', { name: 'Your accounts' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Savings/ })).toBeInTheDocument()
  })

  it('shows the failure line and still lets an address be pasted', () => {
    render(<Harness contacts={[]} contactsError="We could not load your contacts." />)
    const input = focusInput()

    expect(
      screen.getByText('Saved recipients are unavailable. You can still paste an address.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Savings/ })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: UNKNOWN } })
    expect(screen.getByRole('option', { name: /Send to/ })).toBeInTheDocument()
  })
})

describe('RecipientField — the contacts prop is live', () => {
  it('shows a contact added to the prop after mount without remounting', () => {
    const { rerender } = render(<Harness contacts={[]} />)
    focusInput()
    expect(screen.queryByRole('option', { name: /Acme Services/ })).not.toBeInTheDocument()

    rerender(<Harness contacts={CONTACTS} />)
    expect(screen.getByRole('option', { name: /Acme Services/ })).toBeInTheDocument()
  })
})
