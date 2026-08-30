'use client'

/**
 * Overlay tooltip for *elaborating* content (#2038).
 *
 * ## What a tooltip is for here
 *
 * It elaborates on something already visible — the full form of a truncated
 * address, the second half of an MCP server pair, a note about what a column
 * sorts. It is **not** a home for essential copy. #2017 settled that: an
 * explanation a user needs in order to judge whether they still control their
 * account belongs in visible text, and moving it out of a tooltip was the fix.
 * `docs/product/design-review.md:108` states both halves of the rule —
 * "available on hover and focus, and do not hide essential instructions".
 * This primitive can now satisfy the first half; the second half stays a call
 * site's responsibility and no amount of reachability transfers it here.
 *
 * ## Reaching the content without a mouse
 *
 * The trigger a caller passes is either interactive already (`Table`'s sort
 * `<button>`, `Sidebar`'s kebab `<button>`, `Address`' explorer `<a>`) or a
 * bare `<span>`/`<p>` that cannot take focus at all. The old wiring assumed
 * the first case everywhere: `onFocus`/`onBlur` on a wrapper `<span>` that
 * never entered the tab order, so on the bare-span call sites the content was
 * mouse-only.
 *
 * So the wrapper adopts focus and tap **only when it has to** — when the
 * trigger is nobody else's control: nothing focusable inside it, and no
 * interactive element around it (`standalone`). That condition is deliberate
 * on all three sides:
 *
 * - it avoids a second tab stop in front of every `<button>` trigger, where
 *   `focusin` already bubbles to the wrapper and the tooltip already opens;
 * - it avoids attaching a tap-toggle to a control that already owns the tap.
 *   `Sidebar`'s kebab opens a menu, `Table`'s header sorts, `Address`' link
 *   navigates. A toggle there would fire alongside the real action and leave a
 *   bubble hanging over whatever the tap just opened;
 * - and it refuses the same job by ancestry. `AgentCard` is a card-wide
 *   composite `role="link"`, so `McpServerName`'s trigger inside it cannot be
 *   tapped without navigating and cannot take focus without nesting a tab stop
 *   inside a single control. **That call site therefore stays hover-only, and
 *   the honest conclusion is #2017's: its copy explains an absence and belongs
 *   in visible text, not behind a tooltip this primitive cannot rescue.**
 *
 * `Address`' copy affordance is safe by construction and worth naming: its
 * `CopyButton` is a *sibling* of the `Tooltip`, not a child, so tapping the
 * address text has never been the same target as tapping copy. The tap-toggle
 * cannot eat a copy.
 *
 * No `role` is asserted on the standalone wrapper. `role="button"` would
 * promise an activation this element does not perform; a focusable element
 * carrying `aria-describedby` is announced correctly without the lie. It does
 * take the brand `focus-visible` ring, because this primitive is what made it
 * focusable — a bare UA outline beside `Table`'s and `Sidebar`'s rings on the
 * same page would be this primitive's own defect, not inherited debt.
 *
 * ## Width
 *
 * The bubble was `whitespace-nowrap` with no cap, so anything longer than a
 * few words rendered as one bar wider than the viewport — invisible to a
 * rendered design review, because a closed tooltip is not in any screenshot.
 * It now wraps inside a cap that is also viewport-relative, and the bubble is
 * clamped back inside the viewport after layout, since a capped-width bubble
 * centred on a trigger near the screen edge still overflows.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export type TooltipProps = {
  label: string
  side?: 'top' | 'bottom'
  mono?: boolean
  block?: boolean
  children: ReactNode
}

type Coords = { top: number; left: number } | null

/** Anything that already takes focus, and therefore already owns tab and tap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A control the trigger sits INSIDE, which owns the tap by ancestry.
 *
 * Measured, not defensive: `AgentCard` makes the whole card a composite
 * `role="link"` with `tabIndex={0}` and an `onClick`, and `McpServerName`
 * renders inside it. A tap-toggle there fires and then the card navigates
 * away; a `tabIndex` there nests a second tab stop inside a single composite
 * control. Both are worse than the defect.
 */
const INTERACTIVE_ANCESTOR = `${FOCUSABLE}, [role="link"], [role="button"], [role="menuitem"], [role="tab"], [role="option"], label`

/**
 * Keep-inside-the-viewport gutter for a floating overlay, in px.
 *
 * Exported since #2067 so the wallet menu's height bound uses THIS number
 * rather than a second one of its own. Two clamping idioms that must agree is
 * how this class of bug returns: the bubble clamps horizontally against it,
 * `WalletPopover` clamps vertically against it, and there is one place to
 * change if the gutter ever moves.
 */
export const VIEWPORT_MARGIN = 8 // design-system-exempt: a shared px constant, not a primitive — nothing to showcase

/**
 * How long a touch suppresses the mouse path, in ms.
 *
 * A WINDOW rather than a sticky flag, and the difference is the hybrid device.
 * Blink emits compatibility `mouseover`/`mouseenter`/`mousemove`/`mousedown`
 * after a tap, which is what reopened a bubble the tap had just closed — and,
 * on a trigger nested in a card link, opened one that then survived the
 * navigation. A latch fixes that and breaks something else: on a touchscreen
 * laptop, one incidental tap would kill hover on that trigger for the rest of
 * the component's life.
 *
 * ## The gap this has to cover, measured (#2046)
 *
 * `touchend` → synthetic `mouseenter`, ten taps in Chromium under Pixel 5
 * device emulation, 2026-08-26: **0.9 ms min, 14.5 ms max**, with and without
 * a responsive `viewport` meta (no legacy click delay was observed in either
 * configuration). The whole compatibility burst — `mouseover` through `click`
 * — landed inside 22.5 ms of `touchend` in the worst trial.
 *
 * Reproduce: a Pixel 5 `browserContext`, a page whose only content is a span
 * with listeners pushing `[type, performance.now()]` for the touch, pointer
 * and mouse events, then `locator.tap()` and read the log.
 *
 * ## What that measurement does and does not settle
 *
 * It settles that 1000 covers the synthetic burst with roughly **69x** of
 * headroom on this engine — the window cannot be too short. It does NOT settle
 * that 1000 is the best value, and the honest reading is that it is generous:
 * a shorter window would cover the same burst and return hover to a
 * touchscreen-laptop user sooner. Shrinking it is a behaviour change with a
 * real trade-off on slower main threads and on engines not measured here
 * (no Android Chrome, no iOS Safari device trace — emulation is Blink, not a
 * phone), so it stays a product decision rather than a silent edit. 1000 is
 * kept, and it is kept with a number beside it instead of an argument.
 *
 * The width is now PINNED, not merely asserted: `Tooltip.test.tsx`'s `#2046`
 * block drives 999 ms and 1000 ms after a tap on a faked monotonic clock, so
 * changing this constant in either direction turns a named test red. That is
 * the part the pre-#2046 suite could not do — its expiry test advanced five
 * seconds and passed identically at 300, 1000 and 4000.
 */
const MOUSE_AFTER_TOUCH_MS = 1000

export function Tooltip({
  label,
  side = 'top',
  mono = false,
  block = false,
  children,
}: TooltipProps) {
  const id = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const bubbleRef = useRef<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<Coords>(null)
  const [mounted, setMounted] = useState(false)
  const [standalone, setStandalone] = useState(false)
  // When this trigger was last touched, on the monotonic clock. The synthetic
  // mouse events browsers emit after a tap must not re-open what the tap just
  // closed.
  //
  // Seeded `-Infinity`, NOT `0`, and the difference is a real defect rather
  // than a style point. `performance.now()` counts from the page's time
  // origin, so a `0` seed reads as "touched at page load" and would suppress
  // every hover for the first `MOUSE_AFTER_TOUCH_MS` of every page — a
  // regression `Date.now()` could not have, since its zero is 1970. Pinned by
  // `hovers on a fresh page load, before any touch has happened`.
  const lastTouchAt = useRef(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Is this trigger nobody else's control — nothing focusable inside it, and
  // no interactive element around it?
  useLayoutEffect(() => {
    const el = triggerRef.current
    if (!el) return
    const ownsFocus = Boolean(el.querySelector(FOCUSABLE))
    const insideAControl = Boolean(el.parentElement?.closest(INTERACTIVE_ANCESTOR))
    setStandalone(!ownsFocus && !insideAControl)
  })

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    if (side === 'bottom') {
      setCoords({ top: rect.bottom + 6, left: centerX })
    } else {
      setCoords({ top: rect.top - 6, left: centerX })
    }
  }, [side])

  useEffect(() => {
    if (!open) return
    updatePosition()
    const handler = () => updatePosition()
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
  }, [open, updatePosition])

  // A wrapped bubble is as wide as its cap allows, so centring it on a trigger
  // near the screen edge pushes it off-screen. Pull it back after layout.
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!open || !el || !coords) return
    const width = el.getBoundingClientRect().width
    if (!width) return
    const half = width / 2
    const min = VIEWPORT_MARGIN + half
    const max = window.innerWidth - VIEWPORT_MARGIN - half
    const clamped = max < min ? window.innerWidth / 2 : Math.min(Math.max(coords.left, min), max)
    if (Math.abs(clamped - coords.left) > 0.5) {
      setCoords({ top: coords.top, left: clamped })
    }
  }, [open, coords])

  // Escape and an outside press dismiss a tapped-open bubble, which no
  // pointer-leave will ever close on a touch device.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onOutside = (event: Event) => {
      const el = triggerRef.current
      if (el && event.target instanceof Node && el.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onOutside, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onOutside, true)
    }
  }, [open])

  /**
   * True only for the compatibility mouse events a tap just produced.
   *
   * `performance.now()`, not `Date.now()`: wall-clock time is non-monotonic,
   * so an NTP correction landing inside the window could widen it, shorten it
   * or invert it. The monotonic clock cannot be stepped (#2046).
   */
  const echoingATouch = () => performance.now() - lastTouchAt.current < MOUSE_AFTER_TOUCH_MS

  const show = () => {
    if (echoingATouch()) return
    setOpen(true)
  }
  const hide = () => {
    if (echoingATouch()) return
    setOpen(false)
  }

  const onPointerDown = (event: { pointerType?: string }) => {
    if (event.pointerType !== 'touch') return
    // Stamped BEFORE the standalone check, and measured rather than tidy:
    // Chrome emits synthetic `mouseenter` after a tap, so without this a tap
    // on a NON-standalone trigger still opened the bubble through the mouse
    // path — and then the card navigated, stranding it over the next page.
    // Suppress the mouse path after every touch; open only where the toggle
    // is ours to own.
    lastTouchAt.current = performance.now()
    if (!standalone) return
    setOpen((wasOpen) => !wasOpen)
  }

  // The brand focus treatment, and only where this primitive is what MADE the
  // element focusable. `Table`'s sort button and `Sidebar`'s kebab carry their
  // own identical ring; adding a second one on the wrapper around them would
  // draw two rings for one control.
  const wrapperClass = [
    block ? 'block' : 'inline-flex',
    standalone
      ? 'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80'
      : '',
  ]
    .filter(Boolean)
    .join(' ')
  const refCallback = (el: HTMLElement | null) => {
    triggerRef.current = el
  }

  const triggerProps = {
    className: wrapperClass,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    onPointerDown,
    // Focus is what makes `onFocus` more than decoration, but a second tab
    // stop in front of an existing button is a regression, not a fix.
    tabIndex: standalone ? 0 : undefined,
    'aria-describedby': open ? id : undefined,
  }

  const bubble =
    mounted && open && coords
      ? createPortal(
          <span
            id={id}
            ref={bubbleRef}
            role="tooltip"
            style={{
              position: 'fixed',
              top: coords.top,
              // `left: 0` + a translated centre, NOT `left: coords.left`.
              // Measured, and the reason a mutation of the clamp below first
              // SURVIVED: a shrink-to-fit fixed element is sized by
              // `viewport - left`, so offsetting it first capped the bubble at
              // 165px on a 320px screen — narrower than its own `max-w`, and
              // never overflowing, so nothing downstream could be wrong. The
              // width cap and the clamp only mean anything once layout sees
              // the whole viewport.
              left: 0,
              transform: `translate(calc(${coords.left}px - 50%), ${side === 'top' ? '-100%' : '0'})`,
            }}
            className={[
              'pointer-events-none z-[var(--v2-z-tooltip)]',
              'bg-[var(--v2-ink)] text-white px-2.5 py-1.5 rounded-md',
              'text-[12px] leading-tight',
              // A cap that is also viewport-relative: 20rem is comfortable on
              // desktop and still leaves a gutter at 390px. `break-words` only
              // engages past the cap, so a 42-character address is unchanged.
              'max-w-[min(20rem,calc(100vw-1rem))] whitespace-normal break-words',
              'shadow-popover',
              mono ? 'font-mono' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {label}
          </span>,
          document.body,
        )
      : null

  return (
    <>
      {block ? (
        <div ref={refCallback as (el: HTMLDivElement | null) => void} {...triggerProps}>
          {children}
        </div>
      ) : (
        <span ref={refCallback as (el: HTMLSpanElement | null) => void} {...triggerProps}>
          {children}
        </span>
      )}
      {bubble}
    </>
  )
}

export default Tooltip
