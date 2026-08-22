/**
 * Mobile-viewport gating smoke (#1768).
 *
 * Runs under the `chromium-mobile` project (Pixel 5 device emulation) — see the
 * project comment in `playwright.config.ts`. This file exists because until
 * #1768 no mobile viewport gated a pull request at all: `chromium-mobile` was
 * configured but only a manual `workflow_dispatch` ever ran it, so #1749 (the
 * "Open sidebar" toggle hit-tested under `TopBar` and unopenable below `lg` on
 * every authenticated route) could ship without a single check going red.
 *
 * WHAT BELONGS HERE: behaviour that is only wrong at a small width or under a
 * touch pointer — layout overflow, hit-testing, tap targets, mobile-only
 * disclosure. Behaviour that does not depend on the viewport belongs in the
 * desktop specs; duplicating it here just doubles CI time.
 *
 * WHAT DOES NOT BELONG HERE: anything carrying committed SCREENSHOT BASELINES.
 * `design-system.visual.spec.ts` sets its own viewports and its baselines are
 * captured at deviceScaleFactor 1 with no project suffix in the filename;
 * re-running it under Pixel 5's DSF 2.75 would fail on scale rather than on a
 * defect. Note the rule is about baselines, not about setting a viewport —
 * `mobile-nav-layering.mobile.spec.ts` sweeps five widths in this project quite
 * happily, because it compares geometry rather than pixels.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  collectBrowserErrors,
  expectNoHorizontalOverflow,
  mockHavenApi,
  seedAuthenticatedSession,
  unexpectedBrowserErrors,
} from './fixtures/haven-api'

// Authenticated routes a user reaches from primary navigation. Each is checked
// for the one failure mode that is invisible at 1280px: content wider than the
// screen.
const ROUTES = ['/dashboard', '/agents', '/transactions', '/approvals'] as const

/**
 * Routes with a KNOWN, FILED content-overflow defect. The route still runs —
 * rendering and console errors are still asserted — only the overflow
 * assertion is exempted, and only with an issue number.
 *
 * **Currently empty, and that is the point.** `/transactions` was the first
 * and so far only entry: found by this gate on its own first real run, filed
 * as #1772, exempted by name rather than dropped, and removed again when the
 * fix landed. The assertion below now gates every route in `ROUTES`.
 *
 * Rules for adding one back, learned from that round trip:
 *
 *   - Only with an issue number AND the measured numbers, so the next reader
 *     inherits the diagnosis instead of re-measuring it.
 *   - Never drop the route instead. That is how a gate quietly stops covering
 *     things, which is the failure #1768 exists to close.
 *   - Never `test.fail()` either: the measurement is timing-sensitive on a
 *     slow render (see the `found` assertion below), and a `test.fail()` that
 *     flips to "expected to fail, but passed" on an unrelated slow frame is a
 *     false alarm pointed at the wrong person.
 *   - Delete the entry in the pull request that fixes the issue — not later.
 */
const KNOWN_CONTENT_OVERFLOW: Partial<Record<(typeof ROUTES)[number], string>> = {}

/**
 * Horizontal overflow of the CONTENT REGION, measured on its own scroll box.
 *
 * Why the shared `expectNoHorizontalOverflow` is not enough — found the hard
 * way, by the #1768 mutation, which this spec's first version passed:
 *
 *   The authenticated shell wraps everything in `overflow-hidden` twice
 *   (`layout.tsx`: the `flex h-screen … overflow-hidden` root and the
 *   `flex-1 flex flex-col min-w-0 overflow-hidden` column). Content that
 *   overflows is therefore CLIPPED — it never grows
 *   `documentElement.scrollWidth`, which is all the shared helper compares.
 *   A deliberate `w-[120vw]` on `/dashboard` sailed through it, green, on a
 *   real CI run.
 *
 * That is worse than no check: the content is genuinely unreachable — cut off
 * at the bezel with no way to scroll to it — and the page-level metric reports
 * a clean fit. `<main id="main-content">` is the element that actually holds
 * the route's content, so compare ITS scroll width against ITS client width.
 *
 * The shared helper's blind spot is repo-wide, not local to this file — every
 * authenticated desktop spec calls it too. Widening it there would change what
 * those specs assert, so it is left alone here and filed separately.
 */
async function measureContentOverflow(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById('main-content')
    if (!main) return { found: false, overflowBy: 0, contentOverflows: false }

    const overflowBy = main.scrollWidth - main.clientWidth

    return {
      found: true,
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: main.scrollWidth,
      clientWidth: main.clientWidth,
      overflowBy,
      // 1px of tolerance for sub-pixel layout rounding. A real overflow is far
      // larger — the two measured so far were the #1768 mutation and #1772's
      // transactions table, both around 100px on a 393px screen.
      contentOverflows: overflowBy > 1,
    }
  })
}

test.describe('mobile viewport', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  /**
   * The meta-guard. This asserts the SHAPE of the coverage, not the product:
   * that this project is real device emulation and not `test.use({ viewport })`
   * wearing a mobile hat. Option 2 in #1768 (drop the project, override the
   * viewport per spec) would leave `maxTouchPoints` at 0 and the UA desktop —
   * so anything touch- or pointer-dependent would silently stop being tested
   * while the specs kept passing. If someone later swaps the project for a
   * viewport override, this test says so out loud.
   */
  test('runs under real device emulation, not a viewport override', async ({ page }) => {
    await page.goto('/dashboard')

    const env = await page.evaluate(() => ({
      maxTouchPoints: navigator.maxTouchPoints,
      hasTouchEvents: 'ontouchstart' in window,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      deviceScaleFactor: window.devicePixelRatio,
      isMobileUserAgent: /Android|Mobile/i.test(navigator.userAgent),
      width: window.innerWidth,
    }))

    expect(env.maxTouchPoints).toBeGreaterThan(0)
    expect(env.hasTouchEvents).toBe(true)
    expect(env.coarsePointer).toBe(true)
    expect(env.deviceScaleFactor).toBeGreaterThan(1)
    expect(env.isMobileUserAgent).toBe(true)
    expect(env.width).toBeLessThan(1024) // below the `lg` breakpoint
  })

  for (const route of ROUTES) {
    test(`${route} fits the screen and renders clean`, async ({ page }) => {
      const browserErrors = collectBrowserErrors(page)

      await page.goto(route)
      await page.waitForLoadState('networkidle')

      // Page level. Kept, but see `measureContentOverflow` — inside the
      // authenticated shell this one cannot fail, so it is the weaker half.
      // (#1771: on `/transactions` it passed while the content region
      // overflowed by a visible margin. Both were true at once.)
      expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })

      // Wait for the shell's content region before measuring it. Without this
      // the helper returned `{ found: false, overflowBy: 0 }` on a slow render
      // — which the overflow assertion would have read as "fits". A check that
      // passes because the page was not there yet is the failure mode this
      // whole spec exists to prevent, so `found` is asserted too: the no-op
      // path must never be silent.
      await page.locator('#main-content').waitFor({ state: 'attached' })

      const overflow = await measureContentOverflow(page)
      expect(overflow, 'content region was never found — measurement was a no-op').toMatchObject({
        found: true,
      })

      const known = KNOWN_CONTENT_OVERFLOW[route]
      if (known) {
        // eslint-disable-next-line no-console
        console.log(`[known content overflow] ${route}: ${known} — ${JSON.stringify(overflow)}`)
      } else {
        // Asserted on the MAGNITUDE rather than the boolean so a failure prints
        // the numbers. `toMatchObject({ contentOverflows: false })` reports only
        // `true` vs `false`, which tells the next reader nothing about how far
        // off the layout is, or at what width — their first two questions.
        expect(overflow.overflowBy, `content region overflows: ${JSON.stringify(overflow)}`)
          .toBeLessThanOrEqual(1)
      }

      expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
    })
  }

  // The navigation-toggle HIT-TEST — the #1749 defect class, where a stacking
  // regression leaves the toggle visible, enabled and `toBeVisible()`-green
  // while nothing can tap it — lives in `mobile-nav-layering.mobile.spec.ts`,
  // in this same project. It is not duplicated here.
  //
  // Worth recording how it got there. While building this file the hit-test was
  // written here and it FAILED against `dev`: `elementFromPoint` at the toggle's
  // centre returned `TopBar`'s `z-[100]` header, over the toggle's `z-[60]` —
  // #1749, live, found by this gate on its first run. #1769 then merged the fix
  // and its own layering spec, which had used `test.use({ viewport })` inside
  // `chromium-desktop` precisely BECAUSE `chromium-mobile` never gated a PR.
  // That constraint is what #1768 removed, so the spec moved into this project
  // and the hit-test came with it, under a real touch pointer rather than a
  // mouse in a narrow window.
})
