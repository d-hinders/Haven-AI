import { expect } from 'vitest'

/**
 * #4491: a container that hosts a `DropdownMenu` must not clip.
 *
 * The menu panel is `absolute` inside the trigger's `relative` wrapper and is
 * NOT portalled (`components/ui/DropdownMenu.tsx`), so any ancestor whose
 * `overflow` is not `visible` cuts it off at that ancestor's edge. The same
 * holds for the other in-flow popovers (`list-menu` family, `WalletButton`,
 * `Sidebar`). See `docs/product/design-system.md` § Cards.
 *
 * **This is a class proxy, not a layout measurement.** jsdom applies no
 * Tailwind CSS, so nothing here can measure a clipped box; it walks the
 * panel's ancestors and fails on any class or inline style that WOULD clip in
 * a real browser. The real-browser proof is
 * `e2e/budget-menu-focus.spec.ts` (the last item's box is inside the viewport
 * and `document.elementFromPoint` at its centre returns it).
 *
 * **jsdom-only — never call it on a full page.** The authenticated shell
 * always has an `overflow-hidden` / `overflow-y-auto` scroller above every
 * menu (`AuthenticatedShell.tsx`); that is the page scroller, where a menu
 * scrolls with the page rather than being clipped. The walk therefore stops at
 * the test container (the topmost element under `<body>`), so a component
 * rendered on its own is checked and a whole page is not.
 */
const CLIPPING_CLASS =
  /(^|\s|:)(overflow(-[xy])?-(hidden|clip|auto|scroll)|truncate|line-clamp-\d+)(\s|$)/

/** A short, readable name for the offending element in the failure message. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const testId = el.getAttribute('data-testid')
  if (testId) return `<${tag} data-testid="${testId}">`
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 3).join(' ')
  return cls ? `<${tag} class="${cls}">` : `<${tag}>`
}

/** The topmost element under `<body>` — React Testing Library's container. */
function testContainer(el: Element): Element | null {
  let node: Element | null = el
  while (node?.parentElement && node.parentElement !== document.body) {
    node = node.parentElement
  }
  return node
}

/**
 * Assert that nothing between the menu panel and the test container clips.
 *
 * Starts at the panel's `parentElement`: the panel itself carries
 * `overflow-hidden` (`DropdownMenu.tsx`) to clip its own rounded corners, which
 * is not the bug — the bug is an ancestor clipping the panel.
 *
 * @param menuEl the `role="menu"` panel (e.g. `screen.getByRole('menu')`)
 * @param stopAt optional explicit stop element; defaults to the test container
 */
export function expectMenuNotClipped(menuEl: Element, stopAt?: Element | null): void {
  const stop = stopAt ?? testContainer(menuEl)
  const offenders: string[] = []

  let el = menuEl.parentElement
  while (el && el !== stop && el !== document.body && el !== document.documentElement) {
    const className = el.getAttribute('class') ?? ''
    const match = className.match(CLIPPING_CLASS)
    if (match) {
      offenders.push(`${describeElement(el)} — class "${match[0].trim()}"`)
    }
    for (const prop of ['overflow', 'overflowX', 'overflowY'] as const) {
      const value = el.style[prop]
      if (value && value !== 'visible') {
        offenders.push(`${describeElement(el)} — inline style ${prop}: ${value}`)
      }
    }
    el = el.parentElement
  }

  expect(
    offenders,
    'a container that hosts a DropdownMenu must not clip — the panel is in flow, not portalled (#4491)',
  ).toEqual([])
}
