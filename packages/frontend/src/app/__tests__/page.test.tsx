import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import LandingPage from '../page'

/**
 * The landing page's decorative trailing arrows (#1954).
 *
 * ── Why a per-PAGE test when the component already has one ───────────────────
 *
 * `components/marketing/__tests__/TrailingArrow.test.tsx` proves the glyph is
 * hidden. It cannot prove that this page USES it — and "the page still has a
 * raw hand-rolled copy nobody enumerated" is not a hypothetical failure mode
 * here, it is the literal history. #1940 fixed two named definitions and
 * declared the surface done; #1954 then found three more raw `<svg>`s inline in
 * this file with byte-identical path data and no `aria-hidden`, because its
 * inventory had never enumerated them. A component test would have been green
 * throughout.
 *
 * So this file asserts over the RENDERED PAGE: every `<svg>` inside a link, no
 * matter where it came from, is hidden. A fourth hand-copy pasted in tomorrow
 * goes red without anyone having to remember this file exists.
 *
 * ── Why the obvious assertion would not bite ─────────────────────────────────
 *
 * "the link's accessible name is its label" is green with `aria-hidden` and
 * green without it — an `<svg>` with no `<title>` and no `role` contributes
 * nothing to a name computation either way. It is kept below, honestly labelled
 * as a name-is-still-meaningful guard rather than as evidence about
 * `aria-hidden`. The assertion that bites injects a `<title>` into each arrow
 * and re-computes the name, reproducing the exact future the attribute defends
 * against.
 */

/** The one glyph, byte-identical at every call site — see `TrailingArrow`. */
const ARROW_PATH = 'M3.5 8h9M9 4.5L12.5 8 9 11.5'

/**
 * Trailing arrows this page renders: #1954's three, plus the brand band's
 * "Get early access" (already hidden by #1957).
 */
const TRAILING_ARROW_COUNT = 4

/**
 * The blanket `aria-hidden` sweep above covers every `<svg>` in a link, which
 * on this page also catches the two `HavenMark` logos in the header and footer.
 * Those carry `aria-hidden="true"` but NOT `focusable="false"` — measured, not
 * assumed, and deliberately left alone here: it is a shared brand component,
 * outside #1954's scope, and `aria-hidden` is the half that matters to a screen
 * reader (`focusable` is IE-era belt-and-braces). Filed separately rather than
 * folded in, which is why this second assertion is arrow-scoped instead of the
 * sweep simply being widened.
 */
const LINK_LABELS_WITH_ARROWS = [
  // #1954's three, previously raw inline `<svg>`s in this file.
  'See the full walkthrough',
  'See the x402 flow',
  'See the MPP flow',
]

describe('landing page decorative trailing arrows', () => {
  it('hides every glyph inside a link from the accessibility tree', () => {
    const { container } = render(<LandingPage />)

    const glyphs = Array.from(container.querySelectorAll('a svg'))
    // Guard the guard: an empty set would pass the loop below in silence, and
    // this page has had exactly that problem — arrows nobody enumerated.
    expect(glyphs.length).toBeGreaterThanOrEqual(TRAILING_ARROW_COUNT)

    for (const glyph of glyphs) {
      expect(glyph).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('gives every trailing arrow the full decorative pair, not just aria-hidden', () => {
    const { container } = render(<LandingPage />)

    const arrows = Array.from(container.querySelectorAll('a svg')).filter((svg) =>
      Array.from(svg.querySelectorAll('path')).some((p) => p.getAttribute('d') === ARROW_PATH),
    )
    // Exact, not a floor. A dropped call site is as much a regression as an
    // unhidden one, and #1954 exists because an inventory undercounted.
    expect(arrows).toHaveLength(TRAILING_ARROW_COUNT)

    for (const arrow of arrows) {
      expect(arrow).toHaveAttribute('aria-hidden', 'true')
      expect(arrow).toHaveAttribute('focusable', 'false')
    }
  })

  it.each(LINK_LABELS_WITH_ARROWS)(
    'keeps %s’s arrow out of its accessible name once the glyph gains nameable content',
    (label) => {
      const { container } = render(<LandingPage />)

      // The three #1954 arrows are the LAST descendant of their control, and
      // two of them sit inside a whole-card link whose accessible name is the
      // card's prose. Find the control by the glyph rather than the reverse.
      const link = Array.from(container.querySelectorAll('a')).find((a) =>
        (a.textContent ?? '').trim().endsWith(label),
      )
      expect(link, `no link ending in "${label}"`).toBeTruthy()

      const arrow = link!.querySelector('svg')
      expect(arrow, `no trailing arrow inside "${label}"`).toBeTruthy()

      // Stand in for the `<title>` a future editor adds — the exact change
      // `aria-hidden` is here to survive.
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = 'Arrow pointing right'
      arrow!.appendChild(title)

      expect(link!).toHaveAccessibleName(new RegExp(label))
      expect(link!).not.toHaveAccessibleName(/Arrow pointing right/)
    },
  )

  it('leaves each arrowed control a meaningful name of its own', () => {
    render(<LandingPage />)

    // NOT evidence about `aria-hidden` (see the header) — evidence that hiding
    // the glyph left each control nameable, which is the precondition for
    // calling the glyph decorative at all. Every one of #1954's three trails
    // text that already states the destination, so none is icon-only.
    expect(screen.getByRole('link', { name: /See the full walkthrough/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /See the x402 flow/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /See the MPP flow/ })).toBeTruthy()
  })
})
