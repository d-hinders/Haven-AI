import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}))

import { MobileTabBar } from '../MobileTabBar'
import { baseNavItems } from '../Sidebar'

/**
 * The presentational tab bar is really inert (#2819).
 *
 * ## Why this test exists
 *
 * `/design-system` renders a `presentational` copy of the bar as an
 * illustration. Its own docstring says a keyboard user must not be navigated
 * off the showcase by it, and it implements that with `inert`.
 *
 * That guard was **inoperative**. The prop was written `inert: '' as unknown as
 * boolean` — the React 18 workaround for a prop React did not yet model. Under
 * React 19, which this package pins, `inert` is a real boolean, and an empty
 * string makes React drop the attribute entirely and warn. So the attribute was
 * never emitted and the bar's four `<Link>`s stayed focusable and in the
 * accessibility tree, which is exactly what the comment above them forbids.
 *
 * Nothing failed. The only signal was a console warning, and the one tool that
 * surfaced it — the screenshot harness — treats console errors as **advisory**
 * (`scripts/screenshot.mjs`, "reports console errors as advisory"), so no gate
 * could go red. It was found by reading a capture's warning count during #2819
 * and would have come back silently the next time someone reached for `inert`.
 *
 * Hence an assertion on the rendered attribute rather than on the source: what
 * broke was React's treatment of a value, which a source grep for `inert`
 * would have found present and correct-looking throughout.
 */
describe('MobileTabBar — the presentational copy is inert (#2819)', () => {
  it('emits the inert attribute, so the illustration takes no focus', () => {
    render(<MobileTabBar items={baseNavItems} presentational activeHref="/agents" />)

    const nav = screen.getByRole('navigation', { hidden: true })
    // React 19 emits `inert=""` for `inert={true}`. The bug shape — `inert: ''`
    // — makes React emit NOTHING, so presence is the whole assertion, and it is
    // the one a source grep cannot make.
    expect(nav.hasAttribute('inert')).toBe(true)
  })

  it('the live bar is NOT inert, or primary navigation would be unreachable', () => {
    // The control that makes the assertion above meaningful: `inert` must be
    // conditional on `presentational`, not unconditional. Without this, setting
    // it always would satisfy the first test and silently break the real bar.
    render(<MobileTabBar items={baseNavItems} />)

    const nav = screen.getByRole('navigation')
    expect(nav.hasAttribute('inert')).toBe(false)
  })
})

/**
 * The one active idiom, asserted on the RENDERED markup (#2818).
 *
 * Before this, the bar's active state had no unit coverage at all — the only
 * automated evidence was the visual baselines, which is evidence a reviewer
 * reads rather than evidence a gate reports, and which was stale on this very
 * change until the Linux regeneration ran. These three cases are what would
 * have gone red if the rail were dropped, applied to every cell, or left
 * visible to the accessibility tree.
 *
 * Asserted on the element, not on a class string in the source: the defect
 * class here is "the active cell renders like the inactive one", and a source
 * grep for `--v2-brand` finds the token in a comment just as happily.
 */
describe('MobileTabBar — active cell marks itself the way the drawer does (#2818)', () => {
  const renderBar = () =>
    render(<MobileTabBar items={baseNavItems} presentational activeHref="/agents" />)

  /** The rail: a 2px brand span, absolutely placed on the cell's top edge. */
  const railOf = (link: HTMLElement) =>
    link.querySelector('span[aria-hidden="true"].absolute')

  it('gives the active cell brand ink and a rail the a11y tree cannot see', () => {
    renderBar()

    const active = screen.getByRole('link', { name: 'Agents' })
    expect(active.className).toContain('text-[var(--v2-brand)]')
    // `relative` is what SCOPES the rail to this cell. Drop it — a plausible
    // tidy-up in a 240-char class stack — and the absolutely-positioned rail
    // resolves against the nearest positioned ancestor, which for the live bar
    // is the `fixed` <nav>: one 2px line across the WHOLE bar instead of over
    // the active cell. Every other assertion here stays green through that
    // edit, which is exactly why this one is separate (round-two review).
    expect(active.className).toContain('relative')

    const rail = railOf(active)
    expect(rail).not.toBeNull()
    // `aria-hidden` because the rail restates `aria-current`, which is already
    // on the link — announcing it twice is the accessibility defect, not the
    // decoration.
    expect(rail?.getAttribute('aria-hidden')).toBe('true')
    expect(rail?.className).toContain('top-0')
    expect(rail?.className).toContain('h-0.5')
    expect(rail?.className).toContain('bg-[var(--v2-brand)]')
  })

  it('leaves every inactive cell in ink-3, with no rail', () => {
    // The control. Without it, a rail rendered unconditionally would satisfy
    // the case above while erasing the distinction the rail exists to draw.
    renderBar()

    for (const name of ['Dashboard', 'Transactions', 'Accounts']) {
      const inactive = screen.getByRole('link', { name })
      expect(inactive.className).toContain('text-[var(--v2-ink-3)]')
      expect(inactive.className).not.toContain('text-[var(--v2-brand)]')
      expect(railOf(inactive)).toBeNull()
    }
  })

  it('keeps aria-current on exactly one tab — the rail did not replace it', () => {
    // The rail is a second, VISUAL cue. It must not have become the only one:
    // `aria-current` is what a screen reader has, and it is unaffected by
    // anything above.
    const { container } = renderBar()

    const current = container.querySelectorAll('a[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAttribute('href', '/agents')
  })
})
