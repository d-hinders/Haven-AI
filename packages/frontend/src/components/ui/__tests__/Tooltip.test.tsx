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

/**
 * Run `body` with ONLY the clock this primitive reads under our control.
 *
 * `toFake: ['performance']` is exact rather than tidy. `Tooltip` stamps and
 * compares `performance.now()` and sets no timers at all, so faking the
 * scheduler as well would fake something the component never touches — and
 * `vi.setSystemTime`, which the pre-#2046 version of the expiry test used,
 * moves `Date` WITHOUT moving `performance.now()`. That test would now pass
 * for the wrong reason (an unadvanced monotonic clock cannot be inside a
 * window seeded at `-Infinity`) if this file had not been moved to
 * `advanceTimersByTime`.
 *
 * Fake time also matters for a duller reason: a real `sleep` here would make
 * the boundary cases race the machine's load, and a flaky boundary test gets
 * re-run until green rather than read.
 */
function withMonotonicClock(body: (advance: (ms: number) => void) => void) {
  vi.useFakeTimers({ toFake: ['performance'] })
  try {
    body((ms) => vi.advanceTimersByTime(ms))
  } finally {
    vi.useRealTimers()
  }
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
      // A composite-card consumer can still embed `McpServerName`; this test
      // keeps the tooltip from becoming an extra keyboard target there.
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
    // This one is deliberately far outside the window, so it stays true for
    // any plausible constant — it pins that the window EXPIRES AT ALL. Where
    // the edge actually sits is measured in the `#2046` block below; do not
    // read this test as evidence about the width.
    withMonotonicClock((advance) => {
      render(
        <Tooltip label={LONG_LABEL}>
          <span data-testid="child">not recorded</span>
        </Tooltip>,
      )
      const trigger = triggerOf(screen.getByTestId('child'))

      tap(trigger)
      tap(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()

      advance(5_000)
      fireEvent.mouseEnter(trigger)
      expect(screen.getByRole('tooltip')).toHaveTextContent(LONG_LABEL)
    })
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

/**
 * The width of the touch-to-mouse suppression window (#2046).
 *
 * ## What the pre-#2046 suite proved, and what it claimed
 *
 * It claimed the window works. It proved the window *expires*: the expiry test
 * advanced five seconds, which is outside 300 ms, 1000 ms and 4000 ms alike,
 * so it passed identically at every one of them. Changing
 * `MOUSE_AFTER_TOUCH_MS` left the whole suite green. That is an assertion
 * wearing a test's clothes — the same defect class as a locator that resolves
 * to the wrong element or a floor measured against the wrong node: the
 * instrument runs, returns clean, and answers a different question.
 *
 * ## Why these tests hardcode 1000 instead of importing the constant
 *
 * Importing `MOUSE_AFTER_TOUCH_MS` and computing `WINDOW - 1` / `WINDOW` from
 * it would read as the DRY choice and would rebuild exactly the defect being
 * fixed: a test that derives its expectations from the constant it exists to
 * pin moves with every mutation of that constant and can never fail. The
 * literal is the point. If the value is deliberately changed, these two tests
 * SHOULD go red and be updated in the same commit as the evidence for the new
 * number.
 *
 * ## Boundary, both sides
 *
 * `echoingATouch()` is `elapsed < MOUSE_AFTER_TOUCH_MS`, so 999 ms is the last
 * suppressed millisecond and 1000 ms is the first honoured one. Asserting both
 * fixes the edge from either direction: shortening the window reddens the
 * first test, lengthening it reddens the second.
 */
describe('Tooltip touch-to-mouse suppression window (#2046)', () => {
  /** Deliberately a literal — see the block comment above. */
  const WINDOW_MS = 1000

  /** Tap twice (open, then close), then let `ms` of monotonic time pass. */
  function tapThenWait(advance: (ms: number) => void, ms: number): HTMLElement {
    render(
      <Tooltip label={LONG_LABEL}>
        <span data-testid="child">not recorded</span>
      </Tooltip>,
    )
    const trigger = triggerOf(screen.getByTestId('child'))
    tap(trigger)
    tap(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    advance(ms)
    return trigger
  }

  it('still suppresses the mouse path 1ms before the window closes (999ms after a tap)', () => {
    withMonotonicClock((advance) => {
      const trigger = tapThenWait(advance, WINDOW_MS - 1)

      fireEvent.mouseEnter(trigger)

      // Goes red if the window is ever shortened — 400 ms, 300 ms, anything
      // below 1000 ms honours this event instead of swallowing it.
      expect(screen.queryByRole('tooltip')).toBeNull()
    })
  })

  it('honours the mouse path the instant the window closes (1000ms after a tap)', () => {
    withMonotonicClock((advance) => {
      const trigger = tapThenWait(advance, WINDOW_MS)

      fireEvent.mouseEnter(trigger)

      // Goes red if the window is ever lengthened, and is the half that keeps
      // a touchscreen laptop's hover alive.
      expect(screen.getByRole('tooltip')).toHaveTextContent(LONG_LABEL)
    })
  })

  it('re-arms the full window from the latest touch, not from the first', () => {
    // `haven-reviewer`'s finding on this block: every other case here advances
    // once from a single stamp, so none of them could tell a window measured
    // from the LAST touch from one measured from the first. On a hybrid device
    // that is the difference between a second tap suppressing its own echo and
    // a second tap being handled by a window that has already expired.
    withMonotonicClock((advance) => {
      render(
        <Tooltip label={LONG_LABEL}>
          <span data-testid="child">not recorded</span>
        </Tooltip>,
      )
      const trigger = triggerOf(screen.getByTestId('child'))

      tap(trigger)
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      advance(900)

      // Far enough past the first tap that a window anchored there would have
      // 899 ms left, and 1899 ms will have elapsed by the assertion below.
      tap(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()

      advance(WINDOW_MS - 1)
      fireEvent.mouseEnter(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()

      // And still a window, not a latch: one more millisecond releases it.
      advance(1)
      fireEvent.mouseEnter(trigger)
      expect(screen.getByRole('tooltip')).toHaveTextContent(LONG_LABEL)
    })
  })

  it('hovers on a fresh page load, before any touch has happened', () => {
    // `performance.now()` counts from the page's time origin, so early in a
    // page's life it is a small number. With `lastTouchAt` seeded `0` — the
    // seed the pre-#2046 `Date.now()` version used, where 0 means 1970 and is
    // harmless — the swap would have read as "touched at page load" and killed
    // every hover for the first second of every page. The seed is
    // `-Infinity`; this pins it.
    withMonotonicClock((advance) => {
      render(
        <Tooltip label={LONG_LABEL}>
          <span data-testid="child">not recorded</span>
        </Tooltip>,
      )
      const trigger = triggerOf(screen.getByTestId('child'))

      // Well inside the window's width, measured from a zeroed monotonic clock.
      advance(1)
      fireEvent.mouseEnter(trigger)

      expect(screen.getByRole('tooltip')).toHaveTextContent(LONG_LABEL)
    })
  })
})
