import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { PRESENTATION_LABELS } from '@/lib/machine-payment-lifecycle'

describe('StatusBadge (#2147)', () => {
  /**
   * `rounded-full` is a STADIUM — a one-line shape. Wrapped text turns it into
   * an over-rounded blob that stops reading as a status chip.
   *
   * Nothing in the app wrapped until #2147 seeded `needs_attention`, whose
   * "Needs attention" is the longest label the lifecycle vocabulary can produce
   * and the first to wrap at 390 inside the activity table's narrow column
   * (`haven-design-reviewer`'s should-fix, found on the capture that state's
   * first-ever rendering produced). The pairing is the whole point: the shape
   * and the no-wrap rule have to travel together, so a later `rounded-full`
   * that loses `whitespace-nowrap` is a regression this catches.
   */
  it('keeps the stadium on one line', () => {
    const { container } = render(<StatusBadge tone="warning">Needs attention</StatusBadge>)
    const badge = container.firstElementChild!
    expect(badge.className).toContain('rounded-full')
    expect(badge.className).toContain('whitespace-nowrap')
  })

  it('renders every machine-payment lifecycle label through the same one-line badge', () => {
    // Non-vacuity, and the reason the rule matters HERE rather than in the
    // abstract: these are the labels `TransactionsTable` puts in the narrowest
    // column the app has. A new multi-word member added to
    // `MachinePaymentFlowStatus` inherits the guard instead of rediscovering
    // the wrap on a screenshot.
    expect(PRESENTATION_LABELS.length).toBeGreaterThan(0)
    for (const label of PRESENTATION_LABELS) {
      const { container } = render(<StatusBadge tone="warning">{label}</StatusBadge>)
      expect([label, container.firstElementChild!.className.includes('whitespace-nowrap')]).toEqual([
        label,
        true,
      ])
    }
  })
})
