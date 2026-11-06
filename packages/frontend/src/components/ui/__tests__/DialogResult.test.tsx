import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DialogResult } from '@/components/ui/DialogResult'

/**
 * #4564: the shared dialog outcome screen. Three states, one shape — the
 * busy state must use #4563's `Spinner` (whose rotation is motion-gated), and
 * the tone must come from the state, never from the caller.
 */
describe('DialogResult (#4564)', () => {
  it('busy renders the shared Spinner as a status region named by the title', () => {
    const { container } = render(
      <DialogResult state="busy" title="Waiting for your approval…" description="Approve in your wallet." />,
    )
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Waiting for your approval…')
    // #4563's Spinner: the rotation is gated, never an ungated animate-spin.
    const spinner = container.querySelector('.motion-safe\\:animate-spin')
    expect(spinner).toBeTruthy()
    expect(container.querySelector('.animate-spin:not(.motion-safe\\:animate-spin)')).toBeNull()
    expect(screen.getByText('Approve in your wallet.')).toBeTruthy()
  })

  it('success renders the tick in the success tone', () => {
    const { container } = render(<DialogResult state="success" title="Budget updated" />)
    expect(screen.getByText('Budget updated').className).toContain('font-medium')
    expect(container.querySelector('.bg-\\[var\\(--v2-success-soft\\)\\]')).toBeTruthy()
    expect(container.querySelector('.text-\\[var\\(--v2-success\\)\\]')).toBeTruthy()
  })

  it('error renders the cross in the danger tone', () => {
    const { container } = render(
      <DialogResult state="error" title="Budget update failed" description="Nothing changed." />,
    )
    expect(container.querySelector('.bg-\\[var\\(--v2-danger-soft\\)\\]')).toBeTruthy()
    expect(container.querySelector('.text-\\[var\\(--v2-danger\\)\\]')).toBeTruthy()
    expect(screen.getByText('Nothing changed.')).toBeTruthy()
  })

  it('renders extra notices in the same narrow column as the description', () => {
    render(
      <DialogResult state="error" title="New budget is live — one step left" description="Stop the old one.">
        <p>It is held in two parts.</p>
      </DialogResult>,
    )
    const extra = screen.getByText('It is held in two parts.')
    expect(extra.parentElement?.className).toContain('max-w-xs')
    expect(extra.parentElement?.className).toContain('text-xs')
  })

  it('omits the description block entirely when there is nothing to say', () => {
    const { container } = render(<DialogResult state="success" title="Budget updated" />)
    expect(container.querySelector('.max-w-xs')).toBeNull()
  })
})
