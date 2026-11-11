import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialogResult } from '@/components/ui/DialogResult'

/**
 * #4702: the success mark plays `Milestone` Step. The suite-wide stub answers
 * `prefers-reduced-motion: reduce`, so the motion cases override `matchMedia`
 * explicitly — under `reduce` the class is absent by design.
 */
function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  setReducedMotion(true)
})

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

  describe('the success mark plays Milestone Step (#4702)', () => {
    it('success plays check-pop and no bloom', () => {
      setReducedMotion(false)
      const { container } = render(<DialogResult state="success" title="Budget updated" />)
      expect(container.querySelector('.animate-check-pop')).toBeTruthy()
      expect(container.querySelector('.v2-animate-bloom')).toBeNull()
    })

    it('busy and error do not animate', () => {
      setReducedMotion(false)
      const busy = render(<DialogResult state="busy" title="Waiting for your approval…" />)
      expect(busy.container.querySelector('.animate-check-pop')).toBeNull()
      busy.unmount()
      const error = render(<DialogResult state="error" title="Budget update failed" />)
      expect(error.container.querySelector('.animate-check-pop')).toBeNull()
    })

    it('play={false} is static, which is what /design-system shows until Replay', () => {
      setReducedMotion(false)
      const { container } = render(<DialogResult state="success" title="Budget updated" play={false} />)
      expect(container.querySelector('.animate-check-pop')).toBeNull()
      expect(container.querySelector('.v2-animate-bloom')).toBeNull()
    })

    it('strength="peak" adds the bloom for a first-in-your-Haven-life moment', () => {
      setReducedMotion(false)
      const { container } = render(<DialogResult state="success" title="First payment" strength="peak" />)
      expect(container.querySelector('.animate-check-pop')).toBeTruthy()
      expect(container.querySelector('.v2-animate-bloom')).toBeTruthy()
    })

    it('under reduce the class is absent for every strength', () => {
      setReducedMotion(true)
      const { container } = render(<DialogResult state="success" title="Budget updated" strength="peak" />)
      expect(container.querySelector('.animate-check-pop')).toBeNull()
      expect(container.querySelector('.v2-animate-bloom')).toBeNull()
    })
  })

  describe('announce (#4702)', () => {
    it('adds role="status" to success and error for a caller that does not move focus', () => {
      const success = render(<DialogResult state="success" title="Budget updated" announce />)
      expect(screen.getByRole('status').textContent).toContain('Budget updated')
      success.unmount()
      render(<DialogResult state="error" title="Budget update failed" announce />)
      expect(screen.getByRole('status').textContent).toContain('Budget update failed')
    })

    it('never wraps busy — its Spinner already carries the title as a status region', () => {
      render(<DialogResult state="busy" title="Waiting for your approval…" announce />)
      expect(screen.getAllByRole('status')).toHaveLength(1)
    })

    it('is off by default, so a caller that moves focus does not announce twice', () => {
      render(<DialogResult state="success" title="Budget updated" />)
      expect(screen.queryByRole('status')).toBeNull()
    })
  })
})
