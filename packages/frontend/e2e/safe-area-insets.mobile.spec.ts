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
import {
  mockHavenApi,
  seedAuthenticatedSession,
  openReceiveDialog,
  waitForDrawerOpen,
} from './fixtures/haven-api'

/**
 * An iPhone's portrait insets, near enough: 47pt of status bar under a Dynamic
 * Island, 34pt of home indicator. The exact numbers do not matter to any
 * assertion — every one of them reads the value back rather than hard-coding
 * the consequence — but they have to be large enough that a missing rule is
 * unambiguous rather than lost in a rounding error.
 */
const INSET_TOP = 47
const INSET_BOTTOM = 34

/**
 * The bottom tab bar's height (#2731), which the two bottom reservations below
 * now have to clear as well as the inset. Written as a NUMBER rather than read
 * from the token deliberately: reading `--v2-tab-bar-h` here would make the
 * assertion agree with the CSS by construction, and this file exists to catch
 * the CSS being wrong. 62 since #4058: the floating pill's 52px cells, its
 * `py-1` and its 1px border.
 *
 * The pill floats `max(12px, inset)` above the bottom edge. At this file's
 * INSET_BOTTOM (34) that is the inset itself, so every "bar + inset" sum
 * below is also "bar + its float gap" — and the shell test pins the gap.
 */
const TAB_BAR_H = 62

/**
 * A dim layer that actually dims: any colour, at an alpha that reads as a
 * scrim. Deliberately NOT `TAB_BAR_H`'s treatment — that constant is an
 * independent literal because it feeds a three-term sum where a dropped term
 * has to be caught. This is a bare identity against one declaration, and
 * pinning `rgba(26, 31, 54, 0.66)` would redden a #2819 guard when a designer
 * retunes the dim or the palette migrates to `oklch()`/`color-mix()`, neither
 * of which is the defect. The property under test is non-zero alpha, so assert
 * that — the same argument this file already makes about `--v2-bg` further up.
 */
const DIM_FILL = /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.[3-9]\d*\s*\)$/

/**
 * A fully opaque fill: `rgb(...)`, or `rgba(...)` at alpha 1. Shape rather than
 * palette, for the same reason `DIM_FILL` is — `--v2-surface` is free to change
 * without reddening a #2819 guard; ceasing to be opaque is not.
 */
const OPAQUE_FILL = /^(rgb\([^)]*\)|rgba\(\s*\d+,\s*\d+,\s*\d+,\s*1\s*\))$/

/** 390x844 is the iPhone the demo runs on (#2736), not Pixel 5's 393x727. */
const VIEWPORT = { width: 390, height: 844 }

/**
 * The three routes the acceptance criteria name, with whether each one's
 * content actually OVERFLOWS `<main>` at this viewport under the mocked
 * fixture. That flag is not bookkeeping: the scroll-to-end check is the only
 * assertion that exercises `<main>`'s bottom padding as geometry, and on a
 * route whose content fits there is nothing near the bottom to find, so the
 * check passes having proved nothing. Measured, not assumed — `/dashboard`
 * overflows; `/transactions` did not until #3763 gave the fixture a second
 * eip3009 row (the unrecorded-settlement state the baseline has to
 * photograph), which pushes the table past 390x844 exactly as this file's
 * "day the fixture grows" clause anticipates — promoted to carrying the
 * geometry rather than left proving less than the table claims. `/agents`
 * did not until #3165 put the list toolbar (search,
 * two facets, sort, count line) above the fixture's cards, which is exactly
 * the "day the fixture grows" case below — promoted to carrying the
 * geometry rather than left proving less than the table claims. So all
 * three routes carry the geometry and all three carry the padding readback.
 */
const ROUTES = [
  { path: '/dashboard', overflows: true },
  { path: '/agents', overflows: true },
  { path: '/transactions', overflows: true },
] as const

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
 * Scoped to the chrome — the rail (`aside`, which matches nothing below `lg`
 * where it is hidden), the More cell (`[aria-label="Open sidebar"]`; the four
 * tab links are not scanned) and any open dialog, the More sheet included —
 * and
 * deliberately NOT to the scroll region, because a control passing through the
 * bottom 34px mid-scroll is what a scroll region does, not a defect. What the
 * scroll region owes the home indicator is that its content can be scrolled
 * CLEAR of it, and that is asserted separately below, at the one scroll
 * position where it is a real claim: the end. There is no bare `header` here
 * since #4029: the top bar is gone, and the only `<header>` left on a route is
 * `ui/PageHeader`'s, INSIDE the scroll region — scanning it would flag
 * ordinary scrolled content as chrome offenders.
 *
 * Elements outside the viewport are skipped rather than counted: the hidden
 * rail has no box (#4053), and everything below the fold is
 * simply not on screen. Skipping them is why the first version of this helper
 * was wrong — it reported a transaction row at y=1591 as sitting under a home
 * indicator 750px above it.
 */
async function chromeControlsInBands(page: Page, top: number, bottom: number) {
  return page.evaluate(
    ({ top, bottom }) => {
      const roots = Array.from(
        document.querySelectorAll<HTMLElement>('aside, [role="dialog"], [aria-label="Open sidebar"]'),
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
        // Not on screen at all (off either edge).
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
    // The status-bar strip is `[data-safe-area-band]`, rendered by the shell
    // directly above the scroll region since #4029 — there is no top bar
    // (`[data-app-bar]`/`[data-app-chrome]` are gone) for it to be a child
    // of, and a bare `querySelector('header')` would now find `PageHeader`'s
    // header INSIDE the scroll region, which is exactly the silent re-point
    // this helper refuses. Measuring the BAND directly is the point: the
    // user-facing property is that the shell reserves the inset in an opaque,
    // unblurred strip, whatever renders it.
    const band = document.querySelector('[data-safe-area-band]') as HTMLElement | null
    const main = document.getElementById('main-content')
    const toggle = document.querySelector('[aria-label="Open sidebar"]') as HTMLElement | null
    return {
      // The inset the band actually consumes — the property under test.
      bandHeight: band ? Math.round(band.getBoundingClientRect().height) : null,
      bandBackdropFilter: band ? getComputedStyle(band).backdropFilter : null,
      bandBackground: band ? getComputedStyle(band).backgroundColor : null,
      // Viewport-anchored: the band spans the frame edge to edge, so the
      // reserved strip cannot be pushed sideways by a bad landscape inset rule.
      bandLeft: band ? Math.round(band.getBoundingClientRect().left) : null,
      mainPaddingBottom: main ? getComputedStyle(main).paddingBottom : null,
      mainOverscroll: main ? getComputedStyle(main).overscrollBehaviorY : null,
      // By attribute, not `parentElement.parentElement`: a wrapper inserted
      // between `<main>` and the frame would silently retarget the assertion.
      frameOverscroll: (() => {
        const frame = main?.closest('[data-app-frame]')
        return frame ? getComputedStyle(frame).overscrollBehaviorY : null
      })(),
      toggleTop: toggle ? Math.round(toggle.getBoundingClientRect().top) : null,
      // The floating pill's distance from the bottom edge (#4058).
      barBottomGap: (() => {
        const bar = document.querySelector('nav[data-mobile-tab-bar]')
        return bar ? Math.round(window.innerHeight - bar.getBoundingClientRect().bottom) : null
      })(),
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

  for (const { path: route, overflows } of ROUTES) {
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
      expect(shell.bandHeight, 'the safe-area band must consume --v2-safe-top').toBe(INSET_TOP)
      expect(
        shell.mainPaddingBottom,
        'the scroll region pads its own 24px PLUS the tab bar PLUS the home indicator — all three, not two of them',
      ).toBe(`${24 + TAB_BAR_H + INSET_BOTTOM}px`)
      // The floating pill sits exactly ON the home-indicator inset (#4058):
      // `max(12px, inset)`, not 12px stacked on top of it, which would float
      // it visibly high on a notched phone.
      expect(shell.barBottomGap, 'the pill floats on the inset, not above it').toBe(INSET_BOTTOM)

      // The chrome as a whole is GONE (#4029): the band IS the top chrome now,
      // so its own height is the reservation — the inset, opaque, in an
      // element of its own. Nothing else above `<main>` grows by the inset
      // any more.
      expect(shell.bandHeight, 'the safe-area band must consume --v2-safe-top').toBe(INSET_TOP)

      // THE FIX (#2819). The band is opaque and carries no backdrop-filter, so
      // no composited blur layer spans the status bar and nothing there can
      // retain a stale frame of an overlay that has unmounted.
      expect(
        shell.bandBackdropFilter,
        'the status-bar band must not be a backdrop-filter layer',
      ).toBe('none')
      // Opacity is the property under test, so assert THAT rather than a palette
      // value — a change to `--v2-bg` should not redden a #2819 guard. `rgb(...)`
      // with no alpha channel is what "opaque" computes to.
      expect(
        shell.bandBackground,
        'the status-bar band must be opaque, not a translucent blur of what is beneath',
      ).toMatch(/^rgb\([^)]+\)$/)
      // Viewport-anchored (#1779): a relative check cannot see the whole strip
      // move sideways, which is what a bad landscape inset rule would do.
      expect(shell.bandLeft).toBe(0)

      // The toggle is `fixed` with its own offsets, so it would sit in the
      // reserved bands however the chrome above the page is built — the
      // assertion survives the top bar's removal (#4029) unchanged.
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
      // Wait for the route's own content on EVERY route before measuring its
      // scroll box. These screens fetch client-side, so the shell exists (the
      // toggle is up) a beat before there is anything in `<main>` — the #1771
      // trap, where a box that has not been filled yet measures 0 and reads as
      // "fits". Waiting only on the `overflows: true` branch, which is what the
      // first version did, left the `false` rows asserting that an UNRENDERED
      // page does not scroll: true, vacuous, and green through any regression.
      // So the wait is on content existing, which both branches share, rather
      // than on overflow, which is the thing under test.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const m = document.getElementById('main-content')
              return m ? m.innerText.trim().length : 0
            }),
          { message: `${route} must render content into #main-content`, timeout: 15_000 },
        )
        .toBeGreaterThan(30)

      const atEnd = await controlsUnderIndicatorAtScrollEnd(page, INSET_BOTTOM)
      expect(atEnd.scrolled, 'the authenticated shell must expose #main-content').toBe(true)
      if (!atEnd.scrolled) return
      // Asserted, never merely reported — it was computed and left unread in
      // the first version, which is what a review caught. Both directions are
      // pinned: a route declared to overflow must, or its geometry check below
      // is vacuous; a route declared not to must NOT, because the day the
      // fixture grows it should be promoted to carrying the geometry rather
      // than silently continuing to prove less than the table claims.
      expect(
        atEnd.scrollable,
        `${route} is declared overflows: ${overflows} at ${VIEWPORT.width}x${VIEWPORT.height}; the table in ROUTES no longer matches the fixture`,
      ).toBe(overflows)
      expect(
        atEnd.offenders,
        `scrolled to the end, ${route} leaves no control under the home indicator`,
      ).toEqual([])
    })
  }

  test('the open More sheet floats above the home indicator, over the bar, below the status band (#4058)', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await applyInsets(page)
    // Settled, not merely visible: mid-slide the sheet's box is still moving,
    // and every bottom edge below would be read off a part-way sheet.
    await waitForDrawerOpen(page)

    const sheet = await page.evaluate(() => {
      const el = document.querySelector('[data-more-sheet]') as HTMLElement
      const scrim = document.querySelector('[data-more-sheet-scrim]') as HTMLElement
      const bar = document.querySelector('nav[data-mobile-tab-bar]') as HTMLElement
      const profile = el.querySelector('a[href="/profile"]') as HTMLElement
      const logOut = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Log out')!
      const r = el.getBoundingClientRect()
      const b = bar.getBoundingClientRect()
      const s = scrim.getBoundingClientRect()
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        barBottom: Math.round(b.bottom),
        barBottomGap: Math.round(window.innerHeight - b.bottom),
        scrimTop: Math.round(s.top),
        scrimBottom: Math.round(s.bottom),
        profileBottom: Math.round(profile.getBoundingClientRect().bottom),
        logOutBottom: Math.round(logOut.getBoundingClientRect().bottom),
        viewportHeight: window.innerHeight,
      }
    })

    // Control: the bar consumes the injected inset (it floats ON it), so a
    // home indicator exists in this run.
    expect(sheet.barBottomGap).toBe(INSET_BOTTOM)
    // The card floats on the inset too — `max(8px, inset)` — so it ends above
    // the home indicator, and over the bar rather than at its top edge (#4053's
    // geometry, replaced by #4058).
    expect(sheet.bottom).toBe(sheet.viewportHeight - INSET_BOTTOM)
    expect(sheet.bottom).toBeGreaterThanOrEqual(sheet.barBottom)
    // ...and never climbs into the status-bar band.
    expect(sheet.top).toBeGreaterThanOrEqual(INSET_TOP)
    // The scrim shades from below the status band to the very bottom edge.
    expect(sheet.scrimTop).toBe(INSET_TOP)
    expect(sheet.scrimBottom).toBe(sheet.viewportHeight)
    // Its first and last rows sit above the home indicator.
    expect(sheet.profileBottom).toBeLessThanOrEqual(sheet.viewportHeight - INSET_BOTTOM)
    expect(sheet.logOutBottom).toBeLessThanOrEqual(sheet.viewportHeight - INSET_BOTTOM)

    const offenders = await chromeControlsInBands(page, INSET_TOP, INSET_BOTTOM)
    expect(offenders, 'the open sheet puts no control in a reserved band').toEqual([])
  })

  /**
   * `ui/SidePanel` on `/transactions` — an acceptance route, and the surface
   * where the first version of this change was wrong: the inset sat on the
   * OPTIONAL footer row, and `TransactionDetailPanel`, the only shipped caller,
   * passes no footer. So the clearance was dead code at the one call site that
   * exists, and the panel's scroll body met the home indicator with 20px of its
   * own padding. Nothing here covered it, which is why it took a review.
   */
  test('the transaction detail panel clears both bands, with no footer to pad', async ({
    page,
  }) => {
    await page.goto('/transactions')
    await page.getByRole('button', { name: /View details for/ }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await applyInsets(page)

    const panel = await page.evaluate(() => {
      const el = document.querySelector('[role="dialog"]') as HTMLElement
      const style = getComputedStyle(el)
      const body = el.querySelector('.overflow-y-auto') as HTMLElement | null
      if (body) body.scrollTop = body.scrollHeight
      const controls = Array.from(el.querySelectorAll<HTMLElement>('a[href], button')).filter(
        (c) => {
          const r = c.getBoundingClientRect()
          return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < window.innerHeight
        },
      )
      return {
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        hasFooter: !!el.querySelector('[data-side-panel-footer]'),
        lowestControlBottom: Math.round(
          Math.max(...controls.map((c) => c.getBoundingClientRect().bottom)),
        ),
        viewportHeight: window.innerHeight,
      }
    })

    // CONTROL first, and it is on the PANEL — the element that has to carry the
    // inset whether or not a footer exists.
    expect(panel.paddingTop).toBe(`${INSET_TOP}px`)
    expect(panel.paddingBottom).toBe(`${INSET_BOTTOM}px`)
    // Pins the shape the defect depended on: this caller renders no footer, so
    // a footer-row inset would be unreachable here. If a footer ever arrives,
    // this line fails and whoever adds it re-reads the reasoning above.
    expect(panel.hasFooter, 'TransactionDetailPanel renders no footer row').toBe(false)
    expect(panel.lowestControlBottom).toBeLessThanOrEqual(panel.viewportHeight - INSET_BOTTOM)
  })

  /**
   * `ui/Toast` — the other surface pinned to the bottom edge, and the one that
   * appears after most write actions, so its dismiss button is the control most
   * likely to land in the home indicator's band.
   *
   * Driven from the Receive dialog's "Copy address", which raises a real
   * toast on `/dashboard`. The obvious trigger — `/design-system`'s "Show
   * toast" button — was measured and rejected: that route is ~1,575 elements
   * and compiling it in `next dev` starved every other test in this project,
   * turning the whole file red with `page.goto` timeouts rather than with
   * anything about safe areas.
   */
  test('a toast clears the home indicator', async ({ page }) => {
    await openReceiveDialog(page)
    await applyInsets(page)
    await page.getByRole('button', { name: 'Copy address' }).click()
    await expect(page.getByText('Address copied').last()).toBeVisible()

    const toast = await page.evaluate(() => {
      const region = document.querySelector('[role="status"][aria-live="polite"]') as HTMLElement
      const dismiss = region.querySelector(
        '[aria-label="Dismiss notification"]',
      ) as HTMLElement | null
      return {
        bottom: getComputedStyle(region).bottom,
        regionBottom: Math.round(region.getBoundingClientRect().bottom),
        dismissBottom: dismiss ? Math.round(dismiss.getBoundingClientRect().bottom) : null,
        viewportHeight: window.innerHeight,
      }
    })

    // CONTROL: the region consumes the inset rather than its old flat 1rem.
    // #2731 added the tab bar to this offset, and all three terms ADD. (Since
    // #4058 the bar floats on `max(12px, inset)`, which is the inset here.) An
    // earlier revision of this line read `max(16, inset) + bar`, which is what
    // the CSS said at the time and was wrong in the same way: the (then
    // edge-to-edge) bar padded itself with the inset, so folding the inset into a `max()` with the
    // gutter collapsed the gap between toast and bar to ZERO at inset 34 —
    // both edges landed on 90px. Three owners, three terms.
    expect(toast.bottom, 'the toast region must clear the tab bar AND --v2-safe-bottom').toBe(
      `${TAB_BAR_H + INSET_BOTTOM + 16}px`,
    )
    // ...and the gap is real, not zero-by-arithmetic. This is what the earlier
    // form would have failed.
    expect(
      toast.regionBottom,
      'the toast must clear the bar with a visible gutter, not touch it',
    ).toBeLessThanOrEqual(toast.viewportHeight - INSET_BOTTOM - TAB_BAR_H)
    expect(toast.regionBottom).toBeLessThanOrEqual(toast.viewportHeight - INSET_BOTTOM)
    // The half that matters: a dismiss button inside the band is read by the OS
    // as a swipe-up, not a tap.
    expect(toast.dismissBottom).not.toBeNull()
    expect(toast.dismissBottom!).toBeLessThanOrEqual(toast.viewportHeight - INSET_BOTTOM)
  })

  /**
   * `ReceiveFundsModal` (the receive dialog's pre-#4094 shape) is one of the
   * overlays that build their own
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
    await openReceiveDialog(page)
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

    // This overlay sets NO `--v2-safe-gutter`, so each side is `max(0px,
    // inset)` — exactly the inset, and `padding: 0` on a device with neither.
    // (`ui/Modal`, which does set a 1rem gutter, is the other case, and the
    // inset test in `modal-action-row-reachability.spec.ts` covers it.)
    expect(dialog.paddingTop).toBe(`${INSET_TOP}px`)
    expect(dialog.paddingBottom).toBe(`${INSET_BOTTOM}px`)
    expect(dialog.panelTop).toBeGreaterThanOrEqual(INSET_TOP)
    expect(dialog.panelBottom).toBeLessThanOrEqual(dialog.viewportHeight - INSET_BOTTOM)

    const offenders = await chromeControlsInBands(page, INSET_TOP, INSET_BOTTOM)
    expect(offenders, 'an open overlay puts no control in a reserved band').toEqual([])
  })
  /**
   * What covers the status-bar band, now that the scrim is gone (#2819, #2820).
   *
   * #2819's device symptom is that the band goes grey when the mobile nav
   * opens and STAYS grey after it closes. PR #2824 shipped one mechanism and
   * the device pass falsified it. The candidate that replaced it was the
   * drawer scrim — `.v2-modal-backdrop` on a `fixed inset-0` element, which
   * under `viewport-fit: cover` paints the strip a dark translucent slate.
   *
   * #2820 then removed that scrim below `lg`: the drawer is `w-full` now, so
   * there is nothing beside it left to dim. That does NOT close #2819, and the
   * issue says so — the full-screen drawer covers the same strip with its own
   * near-white `--v2-surface`. If the mechanism is "the strip does not repaint
   * after something is drawn over it", the residue just becomes white on
   * white: invisible rather than fixed, and back the next time a coloured
   * overlay covers that strip.
   *
   * #4053 replaced the drawer with a bottom sheet whose scrim STOPS at the
   * inset, so the navigation no longer reaches the band at all. This pins
   * what is there instead:
   *
   * - with the More sheet open, the shell's own OPAQUE band — nothing of the
   *   sheet or its scrim. A dim value here would mean the nav scrim came back
   *   into the strip.
   * - a modal backdrop, which is now the only `.v2-modal-backdrop` over the
   *   safe area on the demo path — and therefore the whole of the operator's
   *   discriminating test. Opening and closing Receive uses that class with no
   *   navigation involved: band goes grey there and the defect belongs to
   *   `.v2-modal-backdrop` over the safe area rather than to the nav.
   *
   * That comparison rests on a premise worth locking, because it is not
   * obvious and it is one refactor from silently untrue. Receive's backdrop is
   * `absolute inset-0` inside a `fixed inset-0` wrapper carrying
   * `.v2-safe-overlay`, which reserves the notch as `padding-top` — and
   * padding does not shrink an absolutely positioned child, because `inset-0`
   * resolves against the PADDING box. The backdrop therefore starts at y=0
   * while the panel inside it starts at 47. Add `top-[var(--v2-safe-top)]` to
   * it, or swap that padding for `inset`, and Receive stops covering the strip
   * while still looking entirely correct on screen. "Band stays white" would
   * then read as *not the backdrop* when it only meant *this test stopped
   * asking the question*.
   *
   * `elementFromPoint` inside the band, not just the bounding box: a box that
   * SPANS the strip is not the same claim as a box that covers it. What this
   * still cannot see is #2819 itself — a stale composited layer is invisible
   * to every DOM query. This locks the premise; the phone answers the issue.
   */
  test('the status band stays opaque under the More sheet, and a modal backdrop covers it (#2819)', async ({
    page,
  }) => {
    const coverage = async (selector: string) =>
      page.evaluate((sel) => {
        const found = Array.from(document.querySelectorAll<HTMLElement>(sel))
        if (found.length !== 1) {
          throw new Error(`expected exactly one ${sel}, found ${found.length}`)
        }
        const target = found[0]
        const rect = target.getBoundingClientRect()
        // Right of centre, and 8px down — inside a 47px band by any rounding.
        const sampleX = window.innerWidth - 20
        // Composed, not the element's own: an ancestor at `opacity: 0` hides it
        // just as completely, and neither is visible to `backgroundColor` or to
        // `getBoundingClientRect`.
        let composedOpacity = 1
        for (let el: Element | null = target; el; el = el.parentElement) {
          composedOpacity *= Number(getComputedStyle(el).opacity)
        }
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          background: getComputedStyle(target).backgroundColor,
          composedOpacity,
          coversTopBand: document.elementFromPoint(sampleX, 8) === target,
          // Which chrome element, if any, covers the sample POINT — not which
          // one reaches past it horizontally. Comparing right edges was the
          // wrong question: Receive's panel is `mx-4 max-w-lg`, so at 390px its
          // right edge is 374 and clears `sampleX`, while the panel sits centred
          // and comes nowhere near y=8. Only containment answers that.
          //
          // This exists so that when something DOES move over the sample point,
          // the failure names it, instead of `coversTopBand` going red and
          // reading like the surface stopped reaching the band.
          occludedBy: ['aside', '[role="dialog"]', '.v2-modal-backdrop'].filter((s) => {
            const el = document.querySelector(s)
            if (!el || el === target || el.contains(target)) return false
            const r = el.getBoundingClientRect()
            return r.left <= sampleX && r.right >= sampleX && r.top <= 8 && r.bottom >= 8
          }),
          sampleX,
          viewportHeight: window.innerHeight,
        }
      }, selector)

    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await applyInsets(page)
    await waitForDrawerOpen(page)

    // With the More sheet open (#4053), the status-bar band is still the
    // shell's OPAQUE band — the sheet's scrim stops at the inset rather than
    // dimming the strip, because a translucent layer in that strip is exactly
    // what #2819 saw stick on a device. This replaces #2820's "the drawer
    // covers the band opaquely": the navigation now covers it not at all.
    const scrimTop = await page.evaluate(
      () => Math.round((document.querySelector('[data-more-sheet-scrim]') as HTMLElement).getBoundingClientRect().top),
    )
    expect(scrimTop, 'the scrim starts below the status-bar band').toBe(INSET_TOP)
    const band = await page.evaluate(() => {
      const sampleX = window.innerWidth - 20
      const top = document.elementFromPoint(sampleX, 8) as HTMLElement | null
      let composedOpacity = 1
      for (let el: Element | null = top; el; el = el.parentElement) {
        composedOpacity *= Number(getComputedStyle(el).opacity)
      }
      return {
        insideSheetOrScrim: !!top?.closest('[data-more-sheet], [data-more-sheet-scrim]'),
        background: top ? getComputedStyle(top).backgroundColor : null,
        composedOpacity,
      }
    })
    expect(band.insideSheetOrScrim, 'nothing of the sheet is in the status-bar band').toBe(false)
    expect(band.background, 'the band is covered opaquely').toMatch(OPAQUE_FILL)
    expect(band.composedOpacity).toBe(1)

    // `openReceiveDialog` navigates, which destroys the document and the
    // style tag injected above. The second `applyInsets` is REQUIRED, not
    // redundant — without it every inset below resolves to 0. (The control that
    // follows would catch its removal, which is the point of the control.)
    await openReceiveDialog(page)
    await applyInsets(page)

    // The same control on the other surface: the overlay reserves the notch in
    // padding, which is the thing that must NOT shrink the backdrop below it.
    const overlayPaddingTop = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]') as HTMLElement
      return getComputedStyle(panel.closest('.v2-safe-overlay') as HTMLElement).paddingTop
    })
    expect(overlayPaddingTop).toBe(`${INSET_TOP}px`)

    const modal = await coverage('.v2-modal-backdrop')
    expect(modal.occludedBy, 'the sample point must be clear of the dialog panel').toEqual([])
    expect(modal.top, "the overlay's padding must not push its backdrop out of the band").toBe(0)
    expect(modal.bottom, 'and the backdrop reaches the home indicator').toBe(modal.viewportHeight)
    expect(modal.coversTopBand, 'the backdrop covers the band with no navigation involved').toBe(
      true,
    )
    // Dim, where #2820's drawer was opaque. This is the surface the operator's
    // discriminating test actually exercises, so what it puts on the strip is
    // the whole of what that test asks about.
    expect(modal.background, 'and it covers the band with a DIM layer').toMatch(DIM_FILL)
    expect(modal.composedOpacity, 'and is not faded out of existence').toBe(1)
  })
})
