/**
 * `ConfirmDialog`'s two new props (#4570): `busyLabel` and `error`.
 *
 * Every confirmation in the app goes through this component, so the two things
 * a caller could previously only get by hand-rolling a `Modal` — its own busy
 * verb and a place to show the action's failure — live here now. The contact
 * delete and the company-details delete are the first callers; these cases pin
 * the component's own contract, not theirs.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ConfirmDialog from '../ConfirmDialog'

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  return render(
    <ConfirmDialog
      open
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      title="Delete contact"
      body="This removes the saved name from Haven."
      confirmLabel="Delete contact"
      {...props}
    />,
  )
}

describe('ConfirmDialog busy label (#4570)', () => {
  it('defaults to "Working…" — U+2026, never three full stops', () => {
    renderDialog({ loading: true })

    const busy = screen.getByRole('button', { name: 'Working…' })
    expect(busy).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Working...' })).not.toBeInTheDocument()
  })

  it('uses the caller\'s own verb while loading', () => {
    renderDialog({ loading: true, busyLabel: 'Deleting…' })

    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Working…' })).not.toBeInTheDocument()
  })

  it('shows the confirm label again once the action settles', () => {
    const { rerender } = renderDialog({ loading: true, busyLabel: 'Deleting…' })
    rerender(
      <ConfirmDialog
        open
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        title="Delete contact"
        body="This removes the saved name from Haven."
        confirmLabel="Delete contact"
        busyLabel="Deleting…"
      />,
    )

    expect(screen.getByRole('button', { name: 'Delete contact' })).toBeEnabled()
  })
})

describe('ConfirmDialog error slot (#4570)', () => {
  it('renders the failure inside the dialog, under the body', () => {
    renderDialog({ error: <p role="alert">We could not delete this contact. Try again.</p> })

    const dialog = screen.getByRole('dialog', { name: 'Delete contact' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'We could not delete this contact. Try again.',
    )
    // The dialog stays open: the error belongs where the action was taken.
    expect(screen.getByRole('dialog', { name: 'Delete contact' })).toBeInTheDocument()
  })

  it('renders nothing extra when there is no error', () => {
    renderDialog()

    const dialog = screen.getByRole('dialog', { name: 'Delete contact' })
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the confirm action available after a failure', () => {
    const onConfirm = vi.fn()
    renderDialog({ onConfirm, error: <p role="alert">Nope.</p> })

    fireEvent.click(screen.getByRole('button', { name: 'Delete contact' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
