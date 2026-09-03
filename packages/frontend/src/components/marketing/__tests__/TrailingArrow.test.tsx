import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TrailingArrow } from '../TrailingArrow'

/**
 * The shared marketing trailing arrow (#1954).
 *
 * The page-level suites (`app/__tests__/page.test.tsx`,
 * the retired investor-briefing page test,
 * `BrandBandButton.test.tsx`) are what prove each SURFACE uses this and stays
 * hidden — that is where the real regression lives, because the failure mode
 * #1954 documents is a hand-copy nobody enumerated, which a component test
 * cannot see.
 *
 * This file guards the two things only the component can own: the decorative
 * pair is baked in and cannot be forgotten at a call site, and the extraction
 * is PIXEL-NEUTRAL — the emitted markup is the same string the six hand-copies
 * emitted, which is the entire basis on which #1867's "keep it byte-identical"
 * decision survives being unified.
 */
describe('TrailingArrow', () => {
  it('carries the decorative pair with nothing required of the call site', () => {
    const { container } = render(<TrailingArrow />)
    const svg = container.querySelector('svg')!

    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
  })

  it('emits the same geometry the six hand-copies emitted', () => {
    const { container } = render(<TrailingArrow />)
    const svg = container.querySelector('svg')!

    // Every number here was read off the copies being replaced, not chosen.
    // If one of them moves, the extraction has stopped being free and the
    // marketing baselines need re-rendering — which is what should go red.
    expect(svg).toHaveAttribute('class', 'w-3.5 h-3.5')
    expect(svg).toHaveAttribute('viewBox', '0 0 16 16')
    expect(svg).toHaveAttribute('fill', 'none')
    expect(svg).toHaveAttribute('stroke', 'currentColor')
    expect(svg).toHaveAttribute('stroke-width', '1.75')

    const path = svg.querySelector('path')!
    expect(path).toHaveAttribute('d', 'M3.5 8h9M9 4.5L12.5 8 9 11.5')
    expect(path).toHaveAttribute('stroke-linecap', 'round')
    expect(path).toHaveAttribute('stroke-linejoin', 'round')
  })

  it('appends a call-site class without dropping its own', () => {
    // `app/page.tsx`'s hover nudge is the only variation across the six
    // instances, and it has to survive the extraction to keep it pixel-neutral.
    const { container } = render(
      <TrailingArrow className="transition-transform group-hover:translate-x-0.5" />,
    )

    expect(container.querySelector('svg')).toHaveAttribute(
      'class',
      'w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5',
    )
  })
})
