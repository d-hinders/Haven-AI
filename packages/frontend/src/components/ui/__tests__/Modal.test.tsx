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

/**
 * The scroll continuation cue (#1893).
 *
 * ## Why this suite drives geometry by hand
 *
 * JSDOM has no layout: every element reports `scrollHeight === clientHeight === 0`,
 * so a "does it overflow" assertion left to JSDOM's own numbers is a check that
 * can never go red. Each test below therefore states the geometry it is testing
 * and then fires the event the component listens for, which exercises the real
 * `scrollHeight > clientHeight + scrollTop` condition in `Modal.tsx`.
 *
 * ## The element under test is NOT `getByRole('dialog')`
 *
 * `role="dialog"` sits on `Modal`'s `fixed inset-0` wrapper, which never
 * scrolls. `scrollBox()` below reaches for `[data-modal-body]` instead, and
 * `measures the scrolling body rather than the role="dialog" wrapper` exists
 * specifically to keep that distinction from quietly regressing into a guard
 * that cannot fail.
 */
function scrollBox(): HTMLElement {
  const body = document.querySelector<HTMLElement>('[data-modal-body]')
  if (!body) throw new Error('Modal rendered no [data-modal-body] scroll box')
  return body
}

function setGeometry(
  element: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  for (const [property, value] of Object.entries(geometry)) {
    Object.defineProperty(element, property, { value, configurable: true, writable: true })
  }
}

function cue() {
  return document.querySelector('[data-modal-scroll-cue]')
}

describe('Modal scroll continuation cue', () => {
  function renderLongModal() {
    return render(
      <Modal
        open
        onClose={vi.fn()}
        title="Replace signing key"
        footer={<button type="button">Cancel</button>}
      >
        <p>A body long enough that its last line falls below the fold.</p>
      </Modal>,
    )
  }

  it('shows the cue while content sits below the fold', () => {
    renderLongModal()
    const body = scrollBox()

    expect(cue()).not.toBeInTheDocument()

    setGeometry(body, { scrollHeight: 1060, clientHeight: 400, scrollTop: 0 })
    fireEvent.scroll(body)

    expect(cue()).toBeInTheDocument()
  })

  it('hides the cue at the end of the scroll rather than leaving it parked', () => {
    renderLongModal()
    const body = scrollBox()

    setGeometry(body, { scrollHeight: 1060, clientHeight: 400, scrollTop: 0 })
    fireEvent.scroll(body)
    expect(cue()).toBeInTheDocument()

    // Fully scrolled: 1060 - 400 = 660.
    setGeometry(body, { scrollHeight: 1060, clientHeight: 400, scrollTop: 660 })
    fireEvent.scroll(body)

    expect(cue()).not.toBeInTheDocument()
  })

  it('shows no cue for a body that fits', () => {
    renderLongModal()
    const body = scrollBox()

    setGeometry(body, { scrollHeight: 400, clientHeight: 400, scrollTop: 0 })
    fireEvent.scroll(body)

    expect(cue()).not.toBeInTheDocument()
  })

  it('raises the cue when the body grows after mount', async () => {
    renderLongModal()
    const body = scrollBox()

    setGeometry(body, { scrollHeight: 400, clientHeight: 400, scrollTop: 0 })
    fireEvent.scroll(body)
    expect(cue()).not.toBeInTheDocument()

    // The re-key flow's residual and resume banners appear after the dialog is
    // already open. Nothing tells `Modal` that happened, so it has to notice.
    setGeometry(body, { scrollHeight: 900, clientHeight: 400, scrollTop: 0 })
    body.appendChild(document.createElement('p'))

    await waitFor(() => expect(cue()).toBeInTheDocument())
  })

  it('measures the scrolling body rather than the role="dialog" wrapper', () => {
    renderLongModal()

    const wrapper = screen.getByRole('dialog')
    const body = scrollBox()

    // The two are different elements, and the one carrying the ARIA role is an
    // ancestor of — not the same node as — the one that scrolls.
    expect(wrapper).not.toBe(body)
    expect(wrapper.contains(body)).toBe(true)
    expect(body.className).toContain('overflow-y-auto')
    expect(wrapper.className).toContain('fixed inset-0')

    // The whole point: an overflowing WRAPPER around a body that fits must
    // produce no cue, because the wrapper is not what the cue is about.
    setGeometry(wrapper, { scrollHeight: 1060, clientHeight: 400, scrollTop: 0 })
    setGeometry(body, { scrollHeight: 400, clientHeight: 400, scrollTop: 0 })

    // Fired on BOTH nodes deliberately. Firing only on the body lets a
    // measure-the-wrapper regression pass for the wrong reason: the listener
    // would be on the wrapper, the body event would reach nothing, and the
    // component would still be sitting on its all-zeros mount-time reading.
    // That exact mutation was run and this assertion stayed green until the
    // wrapper event was added — a check that could not fail.
    fireEvent.scroll(wrapper)
    fireEvent.scroll(body)

    expect(cue()).not.toBeInTheDocument()
  })

  it('keeps the cue clear of the footer, which is outside the scroll box', () => {
    renderLongModal()
    const body = scrollBox()

    setGeometry(body, { scrollHeight: 1060, clientHeight: 400, scrollTop: 0 })
    fireEvent.scroll(body)

    const marker = cue()
    const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement!

    // A cue rendered alongside the footer would describe a region it is not
    // inside — #1893's second structural fact. It must live in the scroll
    // box's own positioned wrapper.
    expect(footer.contains(marker!)).toBe(false)
    expect(marker!.parentElement!.contains(body)).toBe(true)
    expect(marker).toHaveAttribute('aria-hidden', 'true')
    expect(marker!.className).toContain('pointer-events-none')
  })

  it('darkens the edge instead of painting a surface colour over it', () => {
    renderLongModal()
    const body = scrollBox()

    setGeometry(body, { scrollHeight: 1060, clientHeight: 400, scrollTop: 0 })
    fireEvent.scroll(body)

    const marker = cue()!

    // The first implementation was `bg-gradient-to-t from-white`, which assumes
    // the surface behind the cue is white. Rendered over the re-key flow's
    // amber "Before you approve" callout it bleached the callout instead of
    // signalling overflow. A translucent inset shadow composites over whatever
    // is actually painted, so it cannot make that assumption — and it cannot
    // be reintroduced without this assertion going red.
    // `v2-scroll-edge-cue`, NOT `shadow-[var(--v2-shadow-scroll-edge)]`. That
    // Tailwind spelling is dead — a bare `var()` inside `shadow-[…]` is read as
    // a shadow COLOUR, emitting `--tw-shadow: var(--tw-shadow-colored)` against
    // a variable nothing sets, so the computed `box-shadow` is `none`. Measured
    // out of the served stylesheet; the class comment in `globals.css` carries
    // the detail. The browser spec asserts the painted result; this asserts the
    // spelling, so a revert to the dead form fails here first and fast.
    expect(marker.className).toContain('v2-scroll-edge-cue')
    expect(marker.className).not.toMatch(/shadow-\[/)
    expect(marker.className).not.toMatch(/\bbg-gradient-|\bfrom-(white|\[)/)

    // A boundary, not a quantity: 6px regardless of how much is hidden. The
    // second defect was a 32px cue over a 44px overflow, which swallowed the
    // last line rather than hinting at it.
    expect(marker.className).toContain('h-1.5')
    expect(marker.className).not.toMatch(/\bh-(8|10|12|16)\b/)
  })
})
