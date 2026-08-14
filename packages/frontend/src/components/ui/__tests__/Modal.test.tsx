import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from '../Modal'

function ModalHarness() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open modal
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Example modal" showCloseButton>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>
    </>
  )
}

describe('Modal', () => {
  it('traps focus, closes with Escape, and returns focus to its opener', async () => {
    render(<ModalHarness />)

    const opener = screen.getByRole('button', { name: 'Open modal' })
    opener.focus()
    fireEvent.click(opener)

    const firstAction = screen.getByRole('button', { name: 'First action' })
    const lastAction = screen.getByRole('button', { name: 'Last action' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(lastAction).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())

    expect(firstAction).not.toHaveFocus()
  })

  it('keeps an active execution dialog open when every close affordance is protected', () => {
    const onClose = vi.fn()

    render(
      <Modal
        open
        onClose={onClose}
        title="Approving agent rules"
        showCloseButton
        closeButtonDisabled
        closeOnBackdrop={false}
        closeOnEscape={false}
      >
        <p>Please wait for the approval to finish.</p>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog')
    const backdrop = dialog.firstElementChild
    const closeButton = screen.getByRole('button', { name: 'Close' })

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(backdrop!)
    fireEvent.click(closeButton)

    expect(dialog).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
