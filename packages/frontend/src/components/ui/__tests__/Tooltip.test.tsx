/**
 * `Tooltip` reachability and width (#2038).
 *
 * ## What these tests can and cannot prove
 *
 * jsdom has no layout engine, so **nothing here is a rendering claim**. Tab
 * order, tap handling and dismissal are behavioural and are proven here by
 * assertion. The width defect is not: whether a 200-character label wraps
 * inside a 393px viewport instead of rendering as one bar is a geometry
 * question, and the only assertion in this repo that can fail on long content
 * *specifically* lives in `e2e/tooltip-reachability.mobile.spec.ts`, which
 * measures the real bubble in a real browser. The class-shape test below is a
 * cheap guard on the mechanism, not evidence about the result — a three-word
 * label would pass it identically, which is exactly how the defect shipped.
 *
 * And a screenshot could not have caught any of this either: a tooltip that is
 * not open is in no capture, and tab order is not a pixel.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Tooltip } from '../Tooltip'

const LONG_LABEL =
  'Haven records this when an agent connects with a current version of the connector. Agents connected earlier keep working exactly as they are — only the label is missing.'

/** The wrapper the primitive renders around whatever the caller passed. */
function triggerOf(child: HTMLElement): HTMLElement {
  const wrapper = child.parentElement
  if (!wrapper) throw new Error('trigger wrapper not found')
  return wrapper
}

/** A touch press, as React sees it. jsdom has no PointerEvent constructor. */
function tap(el: HTMLElement) {
  fireEvent.pointerDown(el, { pointerType: 'touch' })
}

describe('Tooltip reachability (#2038)', () => {
  it('puts a non-interactive trigger in the tab order and opens on keyboard focus', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <Tooltip label="0x1111111111111111111111111111111111111111" mono>
        <span data-testid="child">0x1111…1111</span>
      </Tooltip>,
    )
    const trigger = triggerOf(screen.getByTestId('child'))

    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.tab()

    expect(trigger).toHaveFocus()
    const bubble = screen.getByRole('tooltip')
    expect(bubble).toHaveTextContent('0x1111111111111111111111111111111111111111')
    expect(trigger.getAttribute('aria-describedby')).toBe(bubble.getAttribute('id'))

    // This primitive is what made the span focusable, so the focus treatment
    // is part of this change — a bare browser outline beside `Table`'s and
    // `Sidebar`'s brand rings on the same page is the primitive's own defect.
    expect(trigger.className).toContain('focus-visible:ring-2')
    expect(trigger.className).toContain('focus-visible:ring-brand/80')
  })

  it('leaves an interactive trigger as the only tab stop and still opens on its focus', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <Tooltip label="Sorts the 40 loaded transactions" side="bottom">
        <button type="button">Amount</button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Amount' })

    await user.tab()

    expect(button).toHaveFocus()
    expect(triggerOf(button)).not.toHaveFocus()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Sorts the 40 loaded transactions')

    // And NO ring on the wrapper: the button carries its own identical one,
    // so a second here would draw two rings around a single control.
    expect(triggerOf(button).className).not.toContain('focus-visible:ring-2')
  })

  it('opens on tap and closes on a second tap where the trigger is not interactive', () => {
    render(
      <Tooltip label={LONG_LABEL}>
        <span data-testid="child">not recorded</span>
      </Tooltip>,
    )
    const trigger = triggerOf(screen.getByTestId('child'))

    tap(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent(LONG_LABEL)

    tap(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not toggle on tap where the trigger owns its own tap', () => {
    const onClick = vi.fn()
    render(
      <Tooltip label="Account menu">
        <button type="button" onClick={onClick}>
          Menu
        </button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Menu' })

    tap(button)

    // The kebab opens a menu, the sort header sorts, the address link
    // navigates. A tap-toggle here would fire alongside the real action and
    // leave a bubble over whatever the tap just opened.
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('refuses focus and tap when the trigger sits inside a composite control', async () => {
    const user = userEvent.setup({ delay: null })
    const openDetails = vi.fn()
    render(
      // `AgentCard`'s real shape: the whole card is one composite link, and
      // `McpServerName` renders inside it.
      <div role="link" tabIndex={0} onClick={openDetails} aria-label="View Research agent">
        <Tooltip label={LONG_LABEL}>
          <span data-testid="child">not recorded</span>
        </Tooltip>
      </div>,
    )
    const card = screen.getByRole('link', { name: 'View Research agent' })
    const trigger = triggerOf(screen.getByTestId('child'))

    await user.tab()
    expect(card).toHaveFocus()
    expect(trigger).not.toHaveFocus()
    expect(trigger).not.toHaveAttribute('tabindex')

    tap(trigger)
    // The card navigates on tap. A toggle here would fire alongside it and
    // strand a bubble over the page the user just left for.
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('ignores the synthetic mouse events Chrome emits right after a tap', () => {
    // The mutation that proved this test was missing: `haven-reviewer` removed
    // the suppression and all 8 tests stayed green. Without it, the mouse path
    // reopens what the tap closed — and on a trigger nested in a card link it
    // opens a bubble that then outlives the navigation.
    render(
      <Tooltip label={LONG_LABEL}>
        <span data-testid="child">not recorded</span>
      </Tooltip>,
    )
    const trigger = triggerOf(screen.getByTestId('child'))

    tap(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    tap(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()

    // Chrome's compatibility sequence, arriving a moment later.
    fireEvent.mouseEnter(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('never opens through the mouse path on a trigger it refuses to own', () => {
    render(
      <div role="link" tabIndex={0} aria-label="View Research agent">
        <Tooltip label={LONG_LABEL}>
          <span data-testid="child">not recorded</span>
        </Tooltip>
      </div>,
    )
    const trigger = triggerOf(screen.getByTestId('child'))

    tap(trigger)
    fireEvent.mouseEnter(trigger)

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('lets a hybrid device hover again once the tap echo has passed', () => {
    // The other half of the trade-off, and the reason the suppression is a
    // WINDOW and not a latch: on a touchscreen laptop, one incidental tap must
    // not kill hover on this trigger for the rest of its life.
    //
    // NOTE what this does NOT prove. Five seconds is far past any plausible
    // value of the constant, so this passes identically at 300ms or 4000ms.
    // It pins that the window EXPIRES, never that 1000 is the right width —
    // that needs a real-device trace (#2046).
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-25T12:00:00Z'))
      render(
        <Tooltip label={LONG_LABEL}>
          <span data-testid="child">not recorded</span>
        </Tooltip>,
      )
      const trigger = triggerOf(screen.getByTestId('child'))

      tap(trigger)
      tap(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()

      vi.setSystemTime(new Date('2026-08-25T12:00:05Z'))
      fireEvent.mouseEnter(trigger)
      expect(screen.getByRole('tooltip')).toHaveTextContent(LONG_LABEL)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses a tapped-open tooltip on Escape', () => {
    render(
      <Tooltip label={LONG_LABEL}>
        <span data-testid="child">not recorded</span>
      </Tooltip>,
    )
    const trigger = triggerOf(screen.getByTestId('child'))

    tap(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('dismisses a tapped-open tooltip on an outside press', () => {
    render(
      <>
        <Tooltip label={LONG_LABEL}>
          <span data-testid="child">not recorded</span>
        </Tooltip>
        <button type="button">elsewhere</button>
      </>,
    )
    const trigger = triggerOf(screen.getByTestId('child'))

    tap(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('gives the bubble a wrapping mechanism rather than a single unbreakable line', () => {
    // MECHANISM ONLY — see the file header. The result at 390px is proven in
    // `e2e/tooltip-reachability.mobile.spec.ts`, by measurement.
    render(
      <Tooltip label={LONG_LABEL}>
        <span data-testid="child">not recorded</span>
      </Tooltip>,
    )
    tap(triggerOf(screen.getByTestId('child')))

    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).not.toContain('whitespace-nowrap')
    expect(bubble.className).toContain('max-w-[min(20rem,calc(100vw-1rem))]')
    expect(bubble.className).toContain('break-words')
  })
})
