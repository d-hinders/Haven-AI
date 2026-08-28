import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import InvestorBriefingPage from '../page'

/**
 * Every CTA glyph on `/investor-briefing` is decorative (#1940).
 *
 * This page carries the arrow twice over: `BrandBandButton`'s `TrailingArrow`
 * on the closing band, and its own `ArrowIcon` inside every `InvestorButton`
 * (hero primary, hero ghost, sticky header). The component-level guard lives in
 * `components/marketing/__tests__/BrandBandButton.test.tsx`; this file guards
 * the page's own copy, and does it by sweeping EVERY link rather than by naming
 * the three call sites — a fourth `InvestorButton` added later is then covered
 * the day it lands instead of the day someone remembers this file.
 *
 * The second assertion is the reason "decorative" is the right word here rather
 * than an assumption. Two links on this page are labelled "Contact the team"
 * (sticky header and closing band — the hero pair was deduped by #1956), and
 * both render the identical arrow — so the glyph cannot be what
 * distinguishes them, and hiding it removes nothing a listener was using. (They
 * also share one destination, which is why two same-named links is correct
 * and not itself a finding.)
 */

describe('/investor-briefing CTA glyphs', () => {
  it('hides every decorative glyph inside a link from the accessibility tree', () => {
    const { container } = render(<InvestorBriefingPage />)

    const glyphs = Array.from(container.querySelectorAll('a svg'))
    expect(glyphs.length).toBeGreaterThan(0)

    const exposed = glyphs.filter((svg) => svg.getAttribute('aria-hidden') !== 'true')
    expect(
      exposed.map((svg) => `<svg> inside "${svg.closest('a')?.textContent?.trim()}"`),
    ).toEqual([])
  })

  it('leaves each CTA a meaningful accessible name of its own', () => {
    render(<InvestorBriefingPage />)

    const contactLinks = screen.getAllByRole('link', { name: 'Contact the team' })
    expect(contactLinks.length).toBeGreaterThan(1)
    for (const link of contactLinks) {
      expect(link).toHaveAccessibleName('Contact the team')
    }

    expect(screen.getByRole('link', { name: 'View product thesis' })).toHaveAccessibleName(
      'View product thesis',
    )
  })
})
