/**
 * #4566 — `DashboardActionPickerModal` on `ui/Modal`.
 *
 * The dialog had no direct test before this slice: it was a bespoke
 * `role="dialog"` shell with its own focus trap and Escape handler. Moving it
 * onto `Modal` moves the dismissal and focus-return behaviour into the shared
 * primitive, so this suite pins the three things a caller can still get wrong:
 * picking an account, dismissing without picking one, and giving focus back to
 * the control that opened the dialog.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import type { SmartAccount } from '@/context/AuthContext'

const ACCOUNTS: SmartAccount[] = [
  {
    id: 'acc-1',
    name: 'Main account',
    account_address: '0x1111111111111111111111111111111111111111',
    chain_id: 8453,
    is_default: true,
    created_at: '2026-05-12T00:00:00Z',
    account_type: 'delegator_hybrid',
  },
  {
    id: 'acc-2',
    name: 'Savings',
    account_address: '0x2222222222222222222222222222222222222222',
    chain_id: 84532,
    is_default: false,
    created_at: '2026-06-01T00:00:00Z',
    account_type: 'delegator_hybrid',
  },
]

function renderPicker(overrides: Partial<Parameters<typeof DashboardActionPickerModal>[0]> = {}) {
  const onClose = vi.fn()
  const onSelect = vi.fn()
  const utils = render(
    <DashboardActionPickerModal
      open
      action="receive"
      accounts={ACCOUNTS}
      onClose={onClose}
      onSelect={onSelect}
      {...overrides}
    />,
  )
  return { ...utils, onClose, onSelect }
}

describe('DashboardActionPickerModal (#4566)', () => {
  it('renders nothing when closed', () => {
    renderPicker({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the action in the title and lists every account with its network', () => {
    renderPicker()
    expect(screen.getByRole('heading', { name: 'Choose an account to receive on' })).toBeInTheDocument()
    expect(screen.getByText('Main account')).toBeInTheDocument()
    expect(screen.getByText('Savings')).toBeInTheDocument()
    // The default badge rides the default account only.
    expect(screen.getByText('Default')).toBeInTheDocument()
  })

  it('switches the title for the send action', () => {
    renderPicker({ action: 'send' })
    expect(screen.getByRole('heading', { name: 'Choose an account to send from' })).toBeInTheDocument()
  })

  it('selects the account the user picks', () => {
    const { onSelect, onClose } = renderPicker()
    fireEvent.click(screen.getByRole('button', { name: /Savings/ }))
    expect(onSelect).toHaveBeenCalledWith('acc-2')
    // Picking is not a dismissal: the caller closes the dialog itself.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('dismisses through the ✕, the backdrop and Escape', () => {
    const { onClose, container } = renderPicker()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    const backdrop = container.querySelector('.v2-modal-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop!)
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('gives focus back to the control that opened it', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Receive'
    document.body.appendChild(opener)
    opener.focus()

    const { rerender } = renderPicker()
    // `Modal` moves focus into the body on open — the first account row.
    expect(screen.getByRole('button', { name: /Main account/ })).toHaveFocus()

    rerender(
      <DashboardActionPickerModal
        open={false}
        action="receive"
        accounts={ACCOUNTS}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(opener).toHaveFocus()
    opener.remove()
  })
})

/**
 * #4601 (N5) — the options are `Row`s, not hand-styled buttons.
 *
 * The old buttons carried a tinted `--v2-surface` fill and no `focus-visible`
 * style, so keyboard focus fell back to the browser's default outline
 * (measured on dev at 375 px: `outline: rgb(229, 151, 0) auto 1px`). `Row` with
 * `onClick` renders a full-width `<button>` with the shared brand ring, and the
 * divided container supplies the separation the per-button borders used to.
 */
describe('DashboardActionPickerModal options are Rows (#4601, N5)', () => {
  it('every option is a full-width button carrying the shared focus-visible ring', () => {
    renderPicker()
    for (const name of [/Main account/, /Savings/]) {
      const option = screen.getByRole('button', { name })
      expect(option.tagName).toBe('BUTTON')
      expect(option.className).toContain('w-full')
      expect(option.className).toContain('focus-visible:ring-2')
      expect(option.className).toContain('focus-visible:ring-inset')
      expect(option.className).toContain('focus-visible:ring-brand/80')
    }
  })

  it('no option carries the old tinted surface fill', () => {
    renderPicker()
    for (const name of [/Main account/, /Savings/]) {
      // Matched exactly: `Row`'s `hover:bg-[var(--v2-surface-hover)]` is the
      // expected hover, and it is a different token.
      expect(screen.getByRole('button', { name }).className).not.toContain('bg-[var(--v2-surface)]')
    }
  })

  it('the rows sit in a divided container, since Row has no border of its own', () => {
    const { container } = renderPicker()
    const list = container.querySelector('.divide-y')
    expect(list).not.toBeNull()
    expect(list!.querySelectorAll('button')).toHaveLength(ACCOUNTS.length)
  })
})
