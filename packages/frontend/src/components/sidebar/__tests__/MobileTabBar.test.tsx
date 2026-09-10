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
