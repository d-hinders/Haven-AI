/**
 * DropdownMenuItem's focus restore (#4259). After `onSelect`, focus returns to
 * the trigger ONLY when the action left it nowhere — on `<body>`, because the
 * panel unmounted under the focused item, or still inside the closed panel.
 * An action that moved focus (a Modal's dialog, a field it focused) keeps it.
 *
 * Real timers throughout: the restore runs after a `setTimeout(0)`, and faking
 * the clock would let a test pass on an ordering no browser produces.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../DropdownMenu'
import { Modal } from '../Modal'

/** Lets the item's restore tick (and anything queued behind it) run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

function Harness() {
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Row options">⋯</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setSelected('noop')}>Do nothing to focus</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => fieldRef.current?.focus()}>Focus the field</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setModalOpen(true)}>Open a modal</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input ref={fieldRef} aria-label="Budget amount" />
      <output>{selected}</output>
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Stop budget">
        <button type="button">Cancel</button>
      </Modal>
    </>
  )
}

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Row options' })
  fireEvent.click(trigger)
  return trigger
}

describe('DropdownMenuItem focus restore (#4259)', () => {
  it('an action that does not move focus returns it to the trigger', async () => {
    render(<Harness />)
    const trigger = openMenu()
    const item = screen.getByRole('menuitem', { name: 'Do nothing to focus' })
    expect(item).toHaveFocus()

    fireEvent.click(item)

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('noop')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('an action that focuses a field keeps that focus', async () => {
    render(<Harness />)
    const trigger = openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Focus the field' }))

    const field = screen.getByRole('textbox', { name: 'Budget amount' })
    expect(field).toHaveFocus()
    await settle()
    expect(field).toHaveFocus()
    expect(trigger).not.toHaveFocus()
  })

  it('an action that opens a Modal leaves focus inside the dialog', async () => {
    render(<Harness />)
    const trigger = openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open a modal' }))

    const dialog = await screen.findByRole('dialog')
    await settle()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(trigger).not.toHaveFocus()
  })

  it('Escape closes the menu and returns focus to the trigger, as before', async () => {
    render(<Harness />)
    const trigger = openMenu()
    expect(screen.getByRole('menuitem', { name: 'Do nothing to focus' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
