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
import { expect, test } from '@playwright/test'
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
 * `/transactions` was found by this gate on its first real run, which is the
 * gate working. It is exempted rather than fixed here because fixing it is a
 * rendered-UI change (the table wants an `overflow-x-auto` wrapper) with its
 * own review and its own evidence, and folding that into a CI-plumbing PR
 * would bury it.
 *
 * Deliberately NOT a dropped route — that is how a gate quietly stops covering
 * things. Deliberately NOT `test.fail()` either: the measurement proved
 * timing-sensitive on a slow render (see the `found` assertion below), and a
 * `test.fail()` that flips to "expected to fail, but passed" on an unrelated
 * slow frame is a false alarm pointed at the wrong person.
 *
 * Delete the entry when the issue closes; the assertion below is already
 * written and will start gating that route again the moment it goes.
 */
const KNOWN_CONTENT_OVERFLOW: Partial<Record<(typeof ROUTES)[number], string>> = {
  '/transactions':
    '#1772 — transactions table renders without an overflow-x-auto wrapper, ' +
    'so it drags the WHOLE content pane into horizontal scroll instead of ' +
    'scrolling itself. Measured 94-124px past a 393px box (it varies with ' +
    'how many rows render) — on CI and locally alike.',
}

/**
 * The local `measureContentOverflow` that used to live here was folded into the
 * shared `expectNoHorizontalOverflow` by #1771.
 *
 * It existed because the shared helper compared the DOCUMENT alone, which
 * inside the authenticated shell cannot fail. Overflowing content is absorbed
 * by `<main>`'s own scroll box (it is `overflow-y-auto`, so `overflow-x`
 * computes to `auto`) and stopped by the shell's two `overflow-hidden`
 * ancestors beyond that — either way it never grows
 * `documentElement.scrollWidth`. #1768 proved it: a deliberate `w-[120vw]` on
 * `/dashboard` sailed through, green, on a real CI run. That blind spot was
 * repo-wide rather than local to this file, so widening the shared helper was
 * the actual fix; keeping a second copy here is how the two drift apart.
 *
 * The shared helper now returns both metrics — `documentOverflows` and
 * `contentOverflows` / `contentOverflowBy`, plus `contentRegionFound` so the
 * no-op path stays loud — and `hasOverflow` is their union. The two mean
 * DIFFERENT defects; see the helper's own JSDoc before diagnosing a failure.
 */

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

      // Wait for the shell's content region before measuring it. Without this
      // the helper returns `contentOverflowBy: 0` on a slow render — which the
      // overflow assertion would read as "fits". A check that passes because
      // the page was not there yet is the failure mode this whole spec exists
      // to prevent, so `contentRegionFound` is asserted too: the no-op path
      // must never be silent.
      await page.locator('#main-content').waitFor({ state: 'attached' })

      const overflow = await expectNoHorizontalOverflow(page)
      expect(overflow, 'content region was never found — measurement was a no-op').toMatchObject({
        contentRegionFound: true,
      })

      // The DOCUMENT-level half always applies: it is the only metric that
      // catches something escaping the shell entirely, and unlike the content
      // half it has no known-defect exemption.
      expect(overflow, `document overflows: ${JSON.stringify(overflow)}`).toMatchObject({
        documentOverflows: false,
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
        expect(
          overflow.contentOverflowBy,
          `content region overflows: ${JSON.stringify(overflow)}`,
        ).toBeLessThanOrEqual(1)
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
