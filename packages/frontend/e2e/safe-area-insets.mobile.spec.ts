/**
 * Nothing sits under the notch or the home indicator (#2730, epic #2736).
 *
 * ## What this can and cannot prove
 *
 * `viewport-fit=cover` is a COMPOSITING instruction to the OS: it says the page
 * may paint under the status bar and the home indicator. No browser engine on a
 * desktop CI runner has either, and Chromium exposes no way to emulate one — so
 * a spec written against a raw `env(safe-area-inset-*)` would be asserting
 * against a permanent 0, which is a check that cannot fail. That is precisely
 * why the shell reads `--v2-safe-*` (globals.css) instead of calling `env()` at
 * each use site: overriding those four custom properties reproduces the
 * arithmetic a real notch produces, in a real engine, against the real
 * stylesheet.
 *
 * So: this file proves the PADDING MATH — that every rule consuming an inset
 * consumes it, in the right direction and on the right side, and that no
 * control in the app chrome lands in a reserved band. It does not prove that
 * iOS reports the insets we think it does, nor that the status bar tints
 * correctly. Those are on the device checklist (#2735), and the #2729
 * checklist is the precedent.
 *
 * Each test's FIRST assertions are the control: the computed padding is read
 * back and compared against the inset that was injected, before any geometry
 * is judged. That ordering is what keeps the rest evidence rather than
 * decoration — a rename of `--v2-safe-top` resolves every rule to 0, at which
 * point the bands are empty and every geometric assertion below passes for a
 * reason that has nothing to do with a notch.
 */
import { expect, test, type Page } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession, openReceiveFundsModal } from './fixtures/haven-api'

/**
 * An iPhone's portrait insets, near enough: 47pt of status bar under a Dynamic
 * Island, 34pt of home indicator. The exact numbers do not matter to any
 * assertion — every one of them reads the value back rather than hard-coding
 * the consequence — but they have to be large enough that a missing rule is
 * unambiguous rather than lost in a rounding error.
 */
const INSET_TOP = 47
const INSET_BOTTOM = 34

/** 390x844 is the iPhone the demo runs on (#2736), not Pixel 5's 393x727. */
const VIEWPORT = { width: 390, height: 844 }

const ROUTES = ['/dashboard', '/agents', '/transactions'] as const

/**
 * Overrides the four inset variables on `:root`. Appended to <head>, so it
 * wins on document order against globals.css's own `:root` block at equal
 * specificity. Left and right stay 0: portrait is the orientation the demo is
 * given in, and a landscape sweep would assert different rules (`pl`/`pr`
 * rather than `pt`/`pb`) without adding a defect class this file is about.
 */
async function applyInsets(page: Page) {
  await page.addStyleTag({
    content: `:root{--v2-safe-top:${INSET_TOP}px;--v2-safe-bottom:${INSET_BOTTOM}px;--v2-safe-left:0px;--v2-safe-right:0px}`,
  })
}

/**
 * Controls inside the app CHROME that intersect a reserved band.
 *
 * Scoped to the chrome — the top bar, the drawer, the fixed toggle, an open
 * dialog — and deliberately NOT to the scroll region, because a control passing
 * through the bottom 34px mid-scroll is what a scroll region does, not a
 * defect. What the scroll region owes the home indicator is that its content
 * can be scrolled CLEAR of it, and that is asserted separately below, at the
 * one scroll position where it is a real claim: the end.
 *
 * Elements outside the viewport are skipped rather than counted: the closed
 * drawer is translated off the left edge, and everything below the fold is
 * simply not on screen. Skipping them is why the first version of this helper
 * was wrong — it reported a transaction row at y=1591 as sitting under a home
 * indicator 750px above it.
 */
async function chromeControlsInBands(page: Page, top: number, bottom: number) {
  return page.evaluate(
    ({ top, bottom }) => {
      const roots = Array.from(
        document.querySelectorAll<HTMLElement>('header, aside, [role="dialog"], [aria-label="Open sidebar"]'),
      )
      const nodes = new Set<HTMLElement>()
      for (const root of roots) {
        if (root.matches('a[href], button, input, select, textarea')) nodes.add(root)
        for (const el of root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea')) {
          nodes.add(el)
        }
      }
      const offenders: Array<{ label: string; top: number; bottom: number }> = []
      for (const el of nodes) {
        const rect = el.getBoundingClientRect()
        // Not a hit target: zero-area boxes, and Tailwind's `sr-only`, which is
        // a 1px clipped box holding screen-reader text.
        if (rect.width <= 1 || rect.height <= 1) continue
        if (getComputedStyle(el).visibility === 'hidden') continue
        // Not on screen at all — the closed drawer lives at negative x.
        if (rect.right <= 0 || rect.left >= window.innerWidth) continue
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue
        const label =
          el.getAttribute('aria-label') ||
          (el.textContent ?? '').trim().slice(0, 40) ||
          el.tagName.toLowerCase()
        const hitsTop = rect.top < top
        const hitsBottom = rect.bottom > window.innerHeight - bottom
        if (hitsTop || hitsBottom) {
          offenders.push({ label, top: Math.round(rect.top), bottom: Math.round(rect.bottom) })
        }
      }
      return offenders
    },
    { top, bottom },
  )
}

/**
 * Scrolls `<main>` to the end and reports any control left in the home
 * indicator's band. THIS is what the scroll region's bottom padding buys: not
 * that content never passes under the indicator — it must, that is scrolling —
 * but that the last row can be brought clear of it. Without the padding the
 * final control rests under the indicator with nowhere further to scroll.
 */
async function controlsUnderIndicatorAtScrollEnd(page: Page, bottom: number) {
  return page.evaluate((bottom) => {
    const main = document.getElementById('main-content')
    if (!main) return { scrolled: false as const }
    main.scrollTop = main.scrollHeight
    const offenders: Array<{ label: string; bottom: number }> = []
    for (const el of main.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea')) {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 1 || rect.height <= 1) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue
      if (rect.bottom > window.innerHeight - bottom) {
        offenders.push({
          label:
            el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 40) || el.tagName,
          bottom: Math.round(rect.bottom),
        })
      }
    }
    return {
      scrolled: true as const,
      // Reported so a page too short to scroll cannot pass this test for the
      // wrong reason — it is a legitimate pass, but a different one.
      scrollable: main.scrollHeight > main.clientHeight,
      offenders,
    }
  }, bottom)
}

async function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('header') as HTMLElement | null
    const main = document.getElementById('main-content')
    const toggle = document.querySelector('[aria-label="Open sidebar"]') as HTMLElement | null
    return {
      headerPaddingTop: header ? getComputedStyle(header).paddingTop : null,
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
      headerLeft: header ? Math.round(header.getBoundingClientRect().left) : null,
      mainPaddingBottom: main ? getComputedStyle(main).paddingBottom : null,
      mainOverscroll: main ? getComputedStyle(main).overscrollBehaviorY : null,
      frameOverscroll: main?.parentElement?.parentElement
        ? getComputedStyle(main.parentElement.parentElement).overscrollBehaviorY
        : null,
      toggleTop: toggle ? Math.round(toggle.getBoundingClientRect().top) : null,
      viewportHeight: window.innerHeight,
    }
  })
}

test.describe('safe-area insets — nothing under the notch or the home indicator (#2730)', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await page.setViewportSize(VIEWPORT)
  })

  test('the project is really device-emulated, or nothing here means what it says', async ({
    page,
  }) => {
    // The same meta-guard `navigation.mobile.spec.ts` carries: a `*.mobile.spec.ts`
    // that quietly stopped running under `chromium-mobile` would still pass its
    // layout assertions while covering none of the touch behaviour it claims to.
    await page.goto('/dashboard')
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
  })

  for (const route of ROUTES) {
    test(`${route}: the shell reserves both bands and puts no control in them`, async ({
      page,
    }) => {
      await page.goto(route)
      await page.getByRole('button', { name: 'Open sidebar' }).waitFor()
      await applyInsets(page)

      const shell = await shellGeometry(page)

      // CONTROL, first: the override reached the stylesheet. Every assertion
      // below is trivially true if the insets resolved to 0, so this is what
      // makes the rest evidence rather than decoration.
      expect(shell.headerPaddingTop, 'the top bar must consume --v2-safe-top').toBe(`${INSET_TOP}px`)
      expect(
        shell.mainPaddingBottom,
        'the scroll region pads its own 24px PLUS the home indicator, not one or the other',
      ).toBe(`${24 + INSET_BOTTOM}px`)

      // The bar GROWS by the inset rather than squashing its contents into the
      // same 56px — the status bar then sits over the bar's own background.
      expect(shell.headerHeight, 'the top bar grows by the top inset').toBe(56 + INSET_TOP)
      // Viewport-anchored (#1779): a relative check cannot see the whole shell
      // move sideways, which is what a bad landscape inset rule would do.
      expect(shell.headerLeft).toBe(0)

      // The drawer toggle is `fixed`, so it carries its own offset and would
      // otherwise sit under the status bar with the bar's padding around it.
      expect(shell.toggleTop, 'the sidebar toggle clears the status bar').toBeGreaterThanOrEqual(
        INSET_TOP,
      )

      // Overscroll: refused on the fixed frame, untouched on the scroll region
      // — the second half is the one that is easy to get wrong, and it costs
      // momentum scrolling on a phone.
      expect(shell.frameOverscroll, 'the fixed frame must refuse the bounce').toBe('none')
      expect(shell.mainOverscroll, 'the scroll region must keep native momentum').toBe('auto')

      const offenders = await chromeControlsInBands(page, INSET_TOP, INSET_BOTTOM)
      expect(
        offenders,
        `no chrome control may sit under the status bar or the home indicator on ${route}`,
      ).toEqual([])

      // And the scroll region can be brought clear of the indicator, which is
      // the only thing its bottom padding can promise.
      const atEnd = await controlsUnderIndicatorAtScrollEnd(page, INSET_BOTTOM)
      expect(atEnd.scrolled, 'the authenticated shell must expose #main-content').toBe(true)
      if (!atEnd.scrolled) return
      expect(
        atEnd.offenders,
        `scrolled to the end, ${route} leaves no control under the home indicator`,
      ).toEqual([])
    })
  }

  test('the open drawer clears both bands, footer row included', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await applyInsets(page)
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible()

    const drawer = await page.evaluate(() => {
      const aside = document.querySelector('aside') as HTMLElement
      const kebab = document.querySelector('[aria-label="User menu"]') as HTMLElement
      const profile = document.querySelector('a[aria-label^="Open profile"]') as HTMLElement
      return {
        paddingTop: getComputedStyle(aside).paddingTop,
        paddingBottom: getComputedStyle(aside).paddingBottom,
        kebabBottom: Math.round(kebab.getBoundingClientRect().bottom),
        profileBottom: Math.round(profile.getBoundingClientRect().bottom),
        viewportHeight: window.innerHeight,
      }
    })

    expect(drawer.paddingTop).toBe(`${INSET_TOP}px`)
    expect(drawer.paddingBottom).toBe(`${INSET_BOTTOM}px`)
    // The two controls #2586 already had to rescue once, now measured against
    // the home indicator rather than against each other.
    expect(drawer.kebabBottom).toBeLessThanOrEqual(drawer.viewportHeight - INSET_BOTTOM)
    expect(drawer.profileBottom).toBeLessThanOrEqual(drawer.viewportHeight - INSET_BOTTOM)

    const offenders = await chromeControlsInBands(page, INSET_TOP, INSET_BOTTOM)
    expect(offenders, 'the open drawer puts no control in a reserved band').toEqual([])
  })

  /**
   * `ReceiveFundsModal` is one of the four overlays that build their own
   * `fixed inset-0` wrapper rather than going through `ui/Modal` — so this is
   * the bespoke-wrapper path, and `ui/Modal`'s own path is covered by the inset
   * case in `modal-action-row-reachability.spec.ts`, which opens a real
   * `ui/Modal`. Worth being explicit about, because the first version of this
   * test reached for `.v2-safe-overlay` document-wide and would have found
   * SOME overlay whatever the dialog under test carried: mutating `ui/Modal`
   * back to `p-4` left it green, which is how the mislabelling was caught.
   * `closest()` from the open dialog is what binds the assertion to the
   * overlay actually wrapping it.
   */
  test('an open bespoke overlay keeps its panel and its actions out of both bands', async ({
    page,
  }) => {
    await openReceiveFundsModal(page)
    await applyInsets(page)

    const dialog = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]') as HTMLElement | null
      const overlay = panel?.closest('.v2-safe-overlay') as HTMLElement | null
      if (!overlay || !panel) return { found: false as const }
      const style = getComputedStyle(overlay)
      const rect = panel.getBoundingClientRect()
      return {
        found: true as const,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        panelTop: Math.round(rect.top),
        panelBottom: Math.round(rect.bottom),
        viewportHeight: window.innerHeight,
      }
    })

    expect(dialog.found, 'the open dialog must be wrapped by a safe-area overlay').toBe(true)
    if (!dialog.found) return

    // `max(1rem, inset)`: the 47px inset beats the gutter, the 34px one beats
    // it too, and on a device with neither the overlay is still `p-4`.
    expect(dialog.paddingTop).toBe(`${INSET_TOP}px`)
    expect(dialog.paddingBottom).toBe(`${INSET_BOTTOM}px`)
    expect(dialog.panelTop).toBeGreaterThanOrEqual(INSET_TOP)
    expect(dialog.panelBottom).toBeLessThanOrEqual(dialog.viewportHeight - INSET_BOTTOM)

    const offenders = await chromeControlsInBands(page, INSET_TOP, INSET_BOTTOM)
    expect(offenders, 'an open overlay puts no control in a reserved band').toEqual([])
  })
})
