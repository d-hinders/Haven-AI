import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandBandButton } from '../BrandBandButton'

/**
 * The decorative trailing arrow, guarded so it stays decorative (#1940).
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 *
 * `aria-hidden` on a decorative glyph is a one-attribute fact that nothing
 * renders and nothing type-checks. That is exactly how it went missing in the
 * first place — three hand-copies of this arrow existed and none of them
 * carried it, while sibling decorative SVGs in the same two files did. An
 * attribute no test asserts is an attribute the next editor deletes without
 * noticing, so the point of the extraction (#1867) is only banked once
 * something here goes red when it is gone.
 *
 * ── Why the obvious assertion would NOT have caught it ───────────────────────
 *
 * "the link's accessible name is its label" is the assertion this reads like it
 * wants, and on its own it is worthless here: an `<svg>` with no `<title>` and
 * no `role` contributes nothing to a name computation either way, so that
 * expectation is green with `aria-hidden` and green without it. It is kept
 * below — the accessible name really is the thing that must not regress — but
 * it is kept HONESTLY, as a name-is-still-meaningful guard rather than as
 * evidence about `aria-hidden`.
 *
 * The assertion that actually bites reproduces the risk the attribute defends
 * against. `aria-hidden` matters the moment the arrow gains any nameable
 * content, so the test gives it some: it injects a `<title>` into the rendered
 * arrow and re-reads the link's accessible name. Hidden, the name stays the
 * label alone. Un-hidden, the glyph's words land in the announcement. That is a
 * behavioural difference, and removing the attribute turns it red.
 */

/** The arrow inside a rendered band CTA, or a loud failure if there isn't one. */
const arrowOf = (link: HTMLElement): SVGSVGElement => {
  const svg = link.querySelector('svg')
  if (!svg) throw new Error(`no trailing arrow rendered inside "${link.textContent}"`)
  return svg as SVGSVGElement
}

describe('BrandBandButton trailing arrow', () => {
  it('hides the decorative trailing arrow from the accessibility tree', () => {
    render(
      <BrandBandButton href="/signup" trailingArrow>
        Get early access
      </BrandBandButton>,
    )

    const arrow = arrowOf(screen.getByRole('link', { name: 'Get early access' }))
    expect(arrow).toHaveAttribute('aria-hidden', 'true')
    expect(arrow).toHaveAttribute('focusable', 'false')
  })

  it('keeps the arrow out of the accessible name once the glyph gains nameable content', () => {
    render(
      <BrandBandButton href="/signup" trailingArrow>
        Get early access
      </BrandBandButton>,
    )

    const link = screen.getByRole('link', { name: 'Get early access' })
    const arrow = arrowOf(link)

    // Stand in for the `<title>` a future editor adds to this arrow — the exact
    // change `aria-hidden` is here to survive.
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = 'Arrow pointing right'
    arrow.appendChild(title)

    expect(link).toHaveAccessibleName('Get early access')
    expect(link).not.toHaveAccessibleName(/Arrow pointing right/)
  })

  it('announces the link by its own label, arrow or no arrow', () => {
    render(
      <>
        <BrandBandButton href="/signup" trailingArrow>
          Get early access
        </BrandBandButton>
        <BrandBandButton href="/how-it-works" variant="translucent">
          Read the technical overview
        </BrandBandButton>
      </>,
    )

    // Not evidence about `aria-hidden` (see the header) — evidence that hiding
    // the glyph left each control with a meaningful name of its own, which is
    // the precondition for calling the glyph decorative in the first place.
    expect(screen.getByRole('link', { name: 'Get early access' })).toHaveAccessibleName(
      'Get early access',
    )
    expect(
      screen.getByRole('link', { name: 'Read the technical overview' }),
    ).toHaveAccessibleName('Read the technical overview')
  })

  it('renders no arrow at all when trailingArrow is not set', () => {
    render(
      <BrandBandButton href="/how-it-works" variant="translucent">
        Read the technical overview
      </BrandBandButton>,
    )

    const link = screen.getByRole('link', { name: 'Read the technical overview' })
    expect(link.querySelector('svg')).toBeNull()
  })
})
