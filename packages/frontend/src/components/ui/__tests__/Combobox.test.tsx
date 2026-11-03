import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Combobox, type ComboboxGroup, type ComboboxOption } from '../Combobox'
import { Modal } from '../Modal'

const GROUPS: ComboboxGroup[] = [
  {
    id: 'accounts',
    label: 'Your accounts',
    options: [
      { id: 'account:1', title: 'Operating wallet', subtitle: 'Your account · 0x7a58…91c2' },
      { id: 'account:2', title: 'Savings', subtitle: 'Your account · 0x31bc…8d04' },
    ],
  },
  {
    id: 'contacts',
    label: 'Contacts',
    options: [{ id: 'contact:1', title: 'Acme Services', subtitle: 'Saved contact · 0x2c9d…77ab' }],
  },
]

function Harness({
  groups = GROUPS,
  onPick = () => {},
  footer,
}: {
  groups?: ComboboxGroup[]
  onPick?: (option: ComboboxOption) => void
  footer?: string
}) {
  const [query, setQuery] = useState('')
  return (
    <Combobox
      label="Recipient"
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      onPick={onPick}
      footer={footer}
    />
  )
}

/** `sm` and up — the portaled popover. The setup's matchMedia stub answers
 * `false` for everything but `prefers-reduced-motion`, so the inline phone
 * layout is the default in this suite. */
function setDesktop(isDesktop: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isDesktop && query === '(min-width: 640px)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function focusInput() {
  const input = screen.getByRole('combobox', { name: 'Recipient' })
  fireEvent.focus(input)
  return input
}

describe('Combobox — ARIA', () => {
  it('is an editable combobox with aria-autocomplete="list" and a controlled listbox', () => {
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-activedescendant')

    fireEvent.focus(input)
    expect(input).toHaveAttribute('aria-expanded', 'true')

    const listbox = screen.getByRole('listbox')
    expect(input).toHaveAttribute('aria-controls', listbox.id)
    expect(listbox.id).not.toBe('')
  })

  it('names every group by its visible label', () => {
    render(<Harness />)
    focusInput()

    const accounts = screen.getByRole('group', { name: 'Your accounts' })
    const contacts = screen.getByRole('group', { name: 'Contacts' })
    expect(within(accounts).getAllByRole('option')).toHaveLength(2)
    expect(within(contacts).getAllByRole('option')).toHaveLength(1)

    // The name comes from `aria-labelledby` pointing at the visible label, not
    // from a duplicated `aria-label`.
    const labelledBy = accounts.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)).toHaveTextContent('Your accounts')
  })

  it('gives every option an id and marks only the active one aria-selected', () => {
    render(<Harness />)
    const input = focusInput()

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    for (const option of options) {
      expect(option.id).not.toBe('')
      expect(option).toHaveAttribute('aria-selected', 'false')
    }

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const active = screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(active).toHaveLength(1)
    expect(input).toHaveAttribute('aria-activedescendant', active[0].id)
  })
})

describe('Combobox — keyboard', () => {
  it('opens on ArrowDown, moves the active option and scrolls it into view', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })

    // Closed: ArrowDown opens the list and lands on the first option.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    scrollIntoView.mockClear()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('opens on ArrowUp at the last option', () => {
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    const options = screen.getAllByRole('option')
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true')
  })

  it('picks the active option on Enter', () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({ id: 'account:2', title: 'Savings' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes on Tab without picking', () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('Combobox — pointer', () => {
  it('picks on click', () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    focusInput()

    fireEvent.click(screen.getByRole('option', { name: /Acme Services/ }))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({ id: 'contact:1' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('does not blur the input on mousedown over the list', () => {
    render(<Harness />)
    focusInput()
    const listbox = screen.getByRole('listbox')

    const event = createEvent.mouseDown(listbox)
    fireEvent(listbox, event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('closes without picking on an outside click', () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    focusInput()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('closes without picking when focus moves to another element', () => {
    const onPick = vi.fn()
    render(
      <>
        <Harness onPick={onPick} />
        <button type="button">Elsewhere</button>
      </>,
    )
    const input = focusInput()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('Combobox — placement', () => {
  it('portals the list to document.body from `sm` up, so a scrolling Modal body cannot clip it', () => {
    setDesktop(true)
    render(
      <Modal open onClose={() => {}} title="Send">
        <Harness />
      </Modal>,
    )
    const input = screen.getByRole('combobox', { name: 'Recipient' })
    fireEvent.focus(input)

    const popover = document.body.querySelector('[data-combobox-popover]')
    expect(popover).not.toBeNull()
    // A direct child of <body>: outside the dialog's scroll box entirely.
    expect(popover!.parentElement).toBe(document.body)
    expect(document.body.querySelector('[data-modal-body]')!.contains(popover!)).toBe(false)
    expect(popover).toHaveClass('shadow-popover')
  })

  it('renders inline below `sm`, so the on-screen keyboard cannot cover it', () => {
    setDesktop(false)
    render(<Harness />)
    focusInput()

    const popover = document.body.querySelector('[data-combobox-popover]')
    expect(popover).not.toBeNull()
    expect(popover).toHaveAttribute('data-combobox-inline')
    expect(popover!.parentElement).not.toBe(document.body)
  })
})

describe('Combobox — Escape state machine inside a real Modal', () => {
  function ModalHarness() {
    const [open, setOpen] = useState(true)
    const [query, setQuery] = useState('')
    return (
      <Modal open={open} onClose={() => setOpen(false)} title="Send">
        <Combobox
          label="Recipient"
          query={query}
          onQueryChange={setQuery}
          groups={GROUPS}
          onPick={() => {}}
        />
      </Modal>
    )
  }

  it('stage 1: closes the list and leaves the dialog open', () => {
    render(<ModalHarness />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })
    fireEvent.focus(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('stage 2: clears the query and leaves the dialog open', () => {
    render(<ModalHarness />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ac' } })
    expect(input).toHaveValue('ac')

    // First Escape closes the list…
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // …the second clears the query.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('stage 3: with the list closed and the query empty, the dialog gets the Escape', () => {
    render(<ModalHarness />)
    const input = screen.getByRole('combobox', { name: 'Recipient' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ac' } })

    fireEvent.keyDown(input, { key: 'Escape' }) // list closes
    fireEvent.keyDown(input, { key: 'Escape' }) // query clears
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' }) // nothing left to undo here
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('Combobox — empty and status states', () => {
  it('shows the empty message when no group has an option', () => {
    render(<Harness groups={[{ id: 'accounts', label: 'Your accounts', options: [] }]} />)
    focusInput()
    expect(screen.getByText('No matches.')).toBeInTheDocument()
  })

  it('renders a group status line in place of its options', () => {
    render(
      <Harness
        groups={[
          {
            id: 'contacts',
            label: 'Contacts',
            options: [],
            status: { kind: 'error', text: 'Saved recipients are unavailable.' },
          },
        ]}
      />,
    )
    focusInput()
    expect(screen.getByText('Saved recipients are unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('renders the footer line under the list', () => {
    render(<Harness footer="Or paste a wallet address" />)
    focusInput()
    expect(screen.getByText('Or paste a wallet address')).toBeInTheDocument()
  })
})
