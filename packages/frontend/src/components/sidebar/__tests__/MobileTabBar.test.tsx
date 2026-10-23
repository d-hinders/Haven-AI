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
 * The bar's own active idiom, asserted on the RENDERED markup (#2818, #4058,
 * #4237).
 *
 * Before #2818 the bar's active state had no unit coverage at all — the only
 * automated evidence was the visual baselines, which is evidence a reviewer
 * reads rather than evidence a gate reports. #4058 gave the bar the app's
 * selection idiom (#4056's `SegmentedControl`); #4237 (owner decision:
 * Revolut's tab bar) replaced it with a NEUTRAL CONCENTRIC CAPSULE — a full
 * `rounded-full` indicator filled with `--v2-tab-bar-indicator`, no outline —
 * and moved the active cell to `--v2-ink` + semibold. The one-active-idiom
 * rule is deliberately relaxed for the bar (the More sheet keeps its brand
 * tint, and the sheet covers the bar while open). These cases go red if the
 * capsule reverts to a different radius, a brand tint or an outline, or if
 * the active cell loses its ink/weight step.
 *
 * Asserted on the element, not on a class string in the source: the defect
 * class here is "the active cell renders like the inactive one", and a source
 * grep for `--v2-tab-bar-indicator` finds the token in a comment just as
 * happily. jsdom computes no `box-shadow`, so the outset focus ring is pinned
 * here by class and in `navigation.mobile.spec.ts` by computed style.
 */
describe('MobileTabBar — active cell carries the selection idiom (#2818, #4058, #4237)', () => {
  const renderBar = () =>
    render(<MobileTabBar items={baseNavItems} presentational activeHref="/agents" />)
  const classes = (el: Element) => el.className.split(/\s+/)
  /** The active shape is painted by an indicator span; the cell stays a rectangle for hit-testing. */
  const indicatorOf = (cell: HTMLElement) => cell.querySelector('[data-tab-indicator]')!

  it('gives the active cell ink + semibold on a rounded-full neutral capsule, with no outline', () => {
    renderBar()

    const active = screen.getByRole('link', { name: 'Agents' })
    expect(classes(active)).toContain('text-[var(--v2-ink)]')
    expect(classes(active)).toContain('font-semibold')
    const capsule = indicatorOf(active)
    expect(capsule.getAttribute('aria-hidden')).toBe('true')
    expect(classes(capsule)).toEqual(
      expect.arrayContaining(['absolute', 'inset-0', 'rounded-full', 'bg-[var(--v2-tab-bar-indicator)]']),
    )
    // No outline anywhere on the indicator — the #4058 brand outline is gone,
    // and with it the `-outline-offset-1` bookkeeping that cleared it under
    // focus. The focus RING (outset, on this same span) is the next test.
    expect(classes(capsule)).not.toContain('outline')
    expect(classes(capsule)).not.toContain('outline-1')
    expect(classes(capsule)).not.toContain('outline-brand')
    // The cell itself is NOT rounded: Chromium hit-tests border-radius, and a
    // rounded cell has dead corners. `relative` scopes the indicator to it.
    expect(classes(active)).not.toContain('rounded-full')
    expect(classes(active)).toContain('relative')
    // The rail is gone: no top-edge decoration.
    expect(active.querySelector('.top-0')).toBeNull()
  })

  it('leaves every inactive cell in ink-3 at font-medium, with no capsule fill and no semibold', () => {
    // The control. Without it, a fill rendered unconditionally would
    // satisfy the case above while erasing the distinction it exists to draw.
    renderBar()

    for (const name of ['Home', 'Activity', 'Accounts']) {
      const inactive = screen.getByRole('link', { name })
      expect(classes(inactive)).toContain('text-[var(--v2-ink-3)]')
      expect(classes(inactive)).toContain('font-medium')
      expect(classes(inactive)).not.toContain('text-[var(--v2-ink)]')
      expect(classes(inactive)).not.toContain('font-semibold')
      const pill = indicatorOf(inactive)
      expect(classes(pill)).not.toContain('bg-[var(--v2-tab-bar-indicator)]')
      expect(classes(pill)).not.toContain('bg-[var(--v2-brand-soft)]')
    }
  })

  it('gives every cell an OUTSET focus ring — no ring-inset anywhere in the bar', () => {
    renderBar()
    for (const name of ['Home', 'Agents', 'Activity', 'Accounts']) {
      const cell = screen.getByRole('link', { name })
      expect(classes(cell)).toEqual(expect.arrayContaining(['group', 'focus-visible:outline-none']))
      const pill = indicatorOf(cell)
      expect(classes(pill)).toEqual(expect.arrayContaining(['group-focus-visible:ring-2', 'group-focus-visible:ring-brand/80']))
      for (const el of [cell, pill]) {
        expect(classes(el)).not.toContain('ring-inset')
        expect(classes(el)).not.toContain('focus-visible:ring-inset')
      }
    }
  })

  it('keeps aria-current on exactly one tab — the visual cue did not replace it', () => {
    // The capsule fill is a second, SUPPLEMENTARY cue. It must not have
    // become the only one: `aria-current` is what a screen reader has.
    const { container } = renderBar()

    const current = container.querySelectorAll('a[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAttribute('href', '/agents')
  })

  it('labels /transactions "Activity" in the bar only (#4058)', () => {
    renderBar()
    const activity = screen.getByRole('link', { name: 'Activity' })
    expect(activity).toHaveAttribute('href', '/transactions')
    expect(screen.queryByRole('link', { name: 'Transactions' })).toBeNull()
    // The rail's own item list is untouched: the override is the bar's.
    expect(baseNavItems.find((i) => i.href === '/transactions')?.label).toBe('Transactions')
  })

  it('labels /dashboard "Home" in the bar only (#4237)', () => {
    // The twin of the Activity override above: the capsule's curved ends must
    // stay off the landing tab's label, so the bar shortens it to "Home"
    // while the rail, the page `h1` and the route keep "Dashboard".
    renderBar()
    const home = screen.getByRole('link', { name: 'Home' })
    expect(home).toHaveAttribute('href', '/dashboard')
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull()
    // The rail's own item list is untouched: the override is the bar's.
    expect(baseNavItems.find((i) => i.href === '/dashboard')?.label).toBe('Dashboard')
  })
})

/**
 * The pill's own surface and edge tokens, pinned on the RENDERED nav (#4063).
 *
 * Before #4063 no test asserted what the pill itself paints: the dark mode
 * read flat because the bar was `bg-[var(--v2-bg)]` on a `--v2-bg` page with
 * only a 1.41:1 `--v2-border` edge (the dark popover shadow is black on
 * near-black). The fix moved the bar to its own token pair —
 * `--v2-tab-bar-bg` / `--v2-tab-bar-border`, aliased to the page ground and
 * plain border in light and redeclared to `--v2-surface-2` /
 * `--v2-border-strong` in both dark blocks — and this pin goes red if the
 * nav silently reverts to the page tokens. Asserted on the element, not the
 * source: a source grep finds the token in a comment just as happily.
 */
describe('MobileTabBar — the pill paints from the tab-bar token pair (#4063)', () => {
  const renderBar = () =>
    render(<MobileTabBar items={baseNavItems} presentational activeHref="/agents" />)

  it('carries the tab-bar surface and edge classes', () => {
    const { container } = renderBar()
    const bar = container.querySelector('[data-mobile-tab-bar]')!
    const classes = bar.className.split(/\s+/)
    expect(classes).toContain('bg-[var(--v2-tab-bar-bg)]')
    expect(classes).toContain('border-[var(--v2-tab-bar-border)]')
  })

  it('no longer paints the page ground and border directly', () => {
    // The control for the pin above: the pre-#4063 classes made the dark pill
    // disappear into the page. Their absence is the regression guard.
    const { container } = renderBar()
    const bar = container.querySelector('[data-mobile-tab-bar]')!
    expect(bar.className).not.toContain('bg-[var(--v2-bg)]')
    expect(bar.className).not.toContain('border-[var(--v2-border)]')
  })
})

/**
 * The bar is still five cells and the theme row is not in it (#2928).
 *
 * The phone theme control lives in the More SHEET this bar's fifth cell opens
 * (#4053; asserted in Sidebar.test.tsx). This bar must not acquire it: #2731
 * fixed the cell count at five and the e2e geometry spec measures five
 * tappable slots, and a control added to the grid would break both — a sixth
 * tab's width for a control that is not a tab.
 *
 * So the claim this file carries for the slice is a negative one over the
 * bar's own subtree, plus the positive control that keeps it honest: the grid
 * still declares exactly five columns, and the four routes plus the More
 * illustration still account for all of them.
 */
describe('MobileTabBar — five cells, and the theme row is not one of them (#2928)', () => {
  const renderBar = () =>
    render(<MobileTabBar items={baseNavItems} presentational activeHref="/agents" />)

  it('lays out exactly five columns', () => {
    const { container } = renderBar()
    const bar = container.querySelector('[data-mobile-tab-bar]')
    expect(bar).not.toBeNull()
    expect(/\bgrid-cols-5\b/.test(bar!.className)).toBe(true)
    // The children are four links and the illustrative fifth cell; nothing
    // else is placed directly in the grid. A control appended here — a toggle
    // among the tabs — changes this count and the e2e slot geometry with it.
    expect(bar!.children).toHaveLength(5)
  })

  it('contains no theme control; the sheet owns it', () => {
    const { container } = renderBar()
    const bar = container.querySelector('[data-mobile-tab-bar]')!
    // The presentational copy has no button at all: its fifth cell is a
    // picture of More.
    expect(bar.querySelectorAll('button')).toHaveLength(0)
    expect(bar.querySelectorAll('[aria-label^="Theme:"]')).toHaveLength(0)
  })

  it('the live bar carries More as its fifth cell — its only button (#4053)', () => {
    const ref = { current: null }
    const { container } = render(
      <MobileTabBar items={baseNavItems} more={{ open: false, onToggle: () => {}, buttonRef: ref }} />,
    )
    const bar = container.querySelector('[data-mobile-tab-bar]')!
    expect(bar.children).toHaveLength(5)
    const buttons = bar.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(bar.children[4]).toBe(buttons[0])
    expect(buttons[0].getAttribute('aria-label')).toBe('Open sidebar')
    expect(bar.querySelectorAll('[aria-label^="Theme:"], [role="radiogroup"]')).toHaveLength(0)
  })
})

/**
 * More only opens (#4058). The sheet covers the bar and carries its own ✕
 * named `Close sidebar`; if this cell still flipped to that name, the harness
 * would find two buttons by it and Playwright's strict mode would fail.
 */
describe('MobileTabBar — the More cell is named Open sidebar in both states (#4058)', () => {
  it.each([false, true])('open=%s', (open) => {
    const ref = { current: null }
    const { container } = render(
      <MobileTabBar items={baseNavItems} more={{ open, onToggle: () => {}, buttonRef: ref }} />,
    )
    const more = container.querySelector('[data-more-toggle]')!
    expect(more.getAttribute('aria-label')).toBe('Open sidebar')
    expect(more.getAttribute('aria-expanded')).toBe(String(open))
    expect(more.textContent).toBe('More')
  })
})
