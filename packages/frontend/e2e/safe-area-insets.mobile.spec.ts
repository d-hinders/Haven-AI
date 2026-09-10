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

/**
 * The bottom tab bar's height (#2731), which the two bottom reservations below
 * now have to clear as well as the inset. Written as a NUMBER rather than read
 * from the token deliberately: reading `--v2-tab-bar-h` here would make the
 * assertion agree with the CSS by construction, and this file exists to catch
 * the CSS being wrong.
 */
const TAB_BAR_H = 56

/** 390x844 is the iPhone the demo runs on (#2736), not Pixel 5's 393x727. */
const VIEWPORT = { width: 390, height: 844 }

/**
 * The three routes the acceptance criteria name, with whether each one's
 * content actually OVERFLOWS `<main>` at this viewport under the mocked
 * fixture. That flag is not bookkeeping: the scroll-to-end check is the only
 * assertion that exercises `<main>`'s bottom padding as geometry, and on a
 * route whose content fits there is nothing near the bottom to find, so the
 * check passes having proved nothing. Measured, not assumed — `/dashboard`
 * overflows, `/agents` and `/transactions` do not, because the fixture seeds
 * two agents and a handful of transactions. So `/dashboard` carries the
 * geometry and all three carry the padding readback.
 */
const ROUTES = [
  { path: '/dashboard', overflows: true },
  { path: '/agents', overflows: false },
  { path: '/transactions', overflows: false },
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
    // `<header>` is the whole chrome band since #2819; the blurred 56px bar is
    // its `[data-app-bar]` child and the status-bar strip its `[data-safe-area-band]`.
    // `[data-app-chrome]`, not `querySelector('header')`: `ui/PageHeader` also
    // renders a `<header>`, so the bare tag is the ambiguity #1820 argued against.
    const chrome = document.querySelector('[data-app-chrome]') as HTMLElement | null
    const bar = document.querySelector('[data-app-bar]') as HTMLElement | null
    const band = document.querySelector('[data-safe-area-band]') as HTMLElement | null
    const main = document.getElementById('main-content')
    const toggle = document.querySelector('[aria-label="Open sidebar"]') as HTMLElement | null
    return {
      // #2819 split the status-bar band OUT of the blurred header, so the
      // inset is now the band's height rather than the header's padding. The
      // user-facing property is unchanged and asserted the same way: the chrome
      // as a whole reserves 56px + the inset, and no control sits in the band.
      bandHeight: band ? Math.round(band.getBoundingClientRect().height) : null,
      bandBackdropFilter: band ? getComputedStyle(band).backdropFilter : null,
      bandBackground: band ? getComputedStyle(band).backgroundColor : null,
      chromeHeight: chrome ? Math.round(chrome.getBoundingClientRect().height) : null,
      chromeBackdropFilter: chrome ? getComputedStyle(chrome).backdropFilter : null,
      headerHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null,
      headerBackdropFilter: bar ? getComputedStyle(bar).backdropFilter : null,
      headerLeft: chrome ? Math.round(chrome.getBoundingClientRect().left) : null,
      mainPaddingBottom: main ? getComputedStyle(main).paddingBottom : null,
      mainOverscroll: main ? getComputedStyle(main).overscrollBehaviorY : null,
      // By attribute, not `parentElement.parentElement`: a wrapper inserted
      // between `<main>` and the frame would silently retarget the assertion.
      frameOverscroll: (() => {
        const frame = main?.closest('[data-app-frame]')
        return frame ? getComputedStyle(frame).overscrollBehaviorY : null
      })(),
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

      // The chrome as a whole still grows by the inset rather than squashing the
      // bar's contents into the same 56px — the status bar sits over the app's
      // own background, not over its controls.
      expect(shell.chromeHeight, 'the chrome grows by the top inset').toBe(56 + INSET_TOP)
      expect(shell.headerHeight, 'the bar itself stays 56px').toBe(56)

      // THE FIX (#2819). The band is opaque and carries no backdrop-filter, so
      // no composited blur layer spans the status bar and nothing there can
      // retain a stale frame of an overlay that has unmounted. The bar keeps
      // its blur — content scrolls under it, which is what the blur is for.
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
      // `toContain('blur(')` with a non-zero radius, not `not.toBe('none')`,
      // which `blur(0px)` would satisfy while blurring nothing.
      expect(shell.headerBackdropFilter, 'the bar itself keeps its blur').toMatch(
        /blur\((?!0px\))[^)]+\)/,
      )
      // And the blur is on the BAR, not on the element spanning the status bar.
      expect(
        shell.chromeBackdropFilter,
        'the chrome band as a whole must not be a backdrop-filter layer',
      ).toBe('none')
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
   * Driven from the Receive-funds modal's "Copy address", which raises a real
   * toast on `/dashboard`. The obvious trigger — `/design-system`'s "Show
   * toast" button — was measured and rejected: that route is ~1,575 elements
   * and compiling it in `next dev` starved every other test in this project,
   * turning the whole file red with `page.goto` timeouts rather than with
   * anything about safe areas.
   */
  test('a toast clears the home indicator', async ({ page }) => {
    await openReceiveFundsModal(page)
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
    // #2731 added the tab bar to this offset, and all three terms ADD. An
    // earlier revision of this line read `max(16, inset) + bar`, which is what
    // the CSS said at the time and was wrong in the same way: the bar already
    // pads itself with the inset, so folding the inset into a `max()` with the
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
   * `ReceiveFundsModal` is one of the overlays that build their own
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
   * #2819's diagnosis rests on a geometric premise, and this locks it.
   *
   * The status-bar band goes grey when the More drawer opens and stays grey
   * after it closes, on a device, in the installed shell. PR #2824 shipped one
   * mechanism (the header's `backdrop-filter`) and the device pass falsified
   * it. The candidate that replaced it is the drawer scrim: `fixed inset-0`
   * with `.v2-modal-backdrop`, which under `viewport-fit: cover` paints the
   * strip a dark translucent slate.
   *
   * That candidate cannot be told apart from a drawer-specific one without a
   * second surface using the SAME class with no drawer involved, so the
   * operator was asked to open and close **Receive** on the dashboard: band
   * goes grey there too and the defect belongs to `.v2-modal-backdrop` over the
   * safe area rather than to navigation.
   *
   * The premise that test rests on is that the two backdrops really do cover
   * the same strip — and it is not obvious, because they are built
   * differently. The scrim is `fixed inset-0`. Receive's is `absolute inset-0`
   * inside a `fixed inset-0` wrapper that carries `.v2-safe-overlay`, which
   * reserves the notch as `padding-top`. Padding does not shrink an absolutely
   * positioned child — `inset-0` resolves against the wrapper's PADDING box —
   * so the backdrop still starts at y=0 while the panel inside it starts at 47.
   * Swap that padding for `inset`, or add `top-[var(--v2-safe-top)]` to either
   * backdrop, and Receive stops covering the strip while still looking correct
   * on screen. The operator's "band stays white" would then read as
   * "drawer-specific" when it only meant "this test no longer asks the
   * question" — a false negative aimed at the next fix.
   *
   * `elementFromPoint` inside the band is the assertion that matters: a box
   * that SPANS the strip is not the same claim as a box that PAINTS it, and
   * only the second one produces a grey band.
   */
  test('the drawer scrim and a modal backdrop paint the same reserved band (#2819)', async ({
    page,
  }) => {
    const coverage = async () =>
      page.evaluate(() => {
        const found = Array.from(document.querySelectorAll<HTMLElement>('.v2-modal-backdrop'))
        if (found.length !== 1) {
          throw new Error(`expected exactly one mounted backdrop, found ${found.length}`)
        }
        const backdrop = found[0]
        const rect = backdrop.getBoundingClientRect()
        // Right of the drawer, which is itself opaque and would answer for the
        // scrim underneath it. 8px down is inside a 47px band by any rounding.
        const sampleX = window.innerWidth - 20
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          background: getComputedStyle(backdrop).backgroundColor,
          paintsTopBand: document.elementFromPoint(sampleX, 8) === backdrop,
          viewportHeight: window.innerHeight,
        }
      })

    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await applyInsets(page)
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible()

    // Control, before any geometry is judged: the drawer consumes the injected
    // inset, so the run really is one where a notch exists.
    const drawerPaddingTop = await page.evaluate(
      () => getComputedStyle(document.querySelector('aside') as HTMLElement).paddingTop,
    )
    expect(drawerPaddingTop).toBe(`${INSET_TOP}px`)

    const scrim = await coverage()
    expect(scrim.top, 'the scrim starts at the top of the viewport, not below the notch').toBe(0)
    expect(scrim.bottom).toBe(scrim.viewportHeight)
    expect(scrim.paintsTopBand, 'the scrim is what paints the status-bar band').toBe(true)

    await page.getByRole('button', { name: 'Close sidebar' }).click()
    await expect(page.locator('.v2-modal-backdrop')).toHaveCount(0)

    await openReceiveFundsModal(page)
    await applyInsets(page)

    // The same control on the other surface: the overlay reserves the notch in
    // padding, which is the thing that must NOT shrink the backdrop below it.
    const overlayPaddingTop = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]') as HTMLElement
      return getComputedStyle(panel.closest('.v2-safe-overlay') as HTMLElement).paddingTop
    })
    expect(overlayPaddingTop).toBe(`${INSET_TOP}px`)

    const modal = await coverage()
    expect(modal.top, "the overlay's padding must not push its backdrop out of the band").toBe(0)
    expect(modal.bottom).toBe(modal.viewportHeight)
    expect(modal.paintsTopBand, 'Receive paints the same band with no drawer involved').toBe(true)

    // The premise in one line: same strip, same colour, so the operator's
    // Receive run is a real discriminator and not a differently-built surface
    // that happens to be quiet.
    expect(modal.background).toBe(scrim.background)
  })
})
