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
 *     slow render (see the `contentRegionFound` assertion below), and a
 *     `test.fail()` that flips to "expected to fail, but passed" on an
 *     unrelated slow frame is a false alarm pointed at the wrong person.
 *   - Delete the entry in the pull request that fixes the issue — not later.
 *
 * Note that this exempts the CONTENT half only. `documentOverflows` is
 * asserted unconditionally above it and never had an exemption, so a route
 * listed here is still gated against escaping the shell entirely.
 */
const KNOWN_CONTENT_OVERFLOW: Partial<Record<(typeof ROUTES)[number], string>> = {}

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

      // ...and wait for the SIDEBAR too, not just the content region (#1779).
      //
      // `Sidebar` is `dynamic(..., { ssr: false })`, so it renders a chunk
      // later than `<main>` does. Until it does, the shell has no leading
      // element at all and `<main>` sits at x=0 — which is the same reading a
      // correctly-anchored shell gives. The viewport anchor below therefore
      // passed under the very mutation it exists to catch, on 3 of 4 routes,
      // in the run that was supposed to prove it: the measurement had simply
      // happened first. The one route that went red was the slow one.
      //
      // Caught by running the mutation rather than by reading, and it is the
      // same silent-no-op shape `contentRegionFound` was added for one issue
      // ago — a guard that passes because the thing it measures had not
      // rendered yet. The toggle is the sidebar's own `lg:hidden` control, so
      // waiting for it is exactly "the mobile shell is now laid out".
      await page.getByRole('button', { name: 'Open sidebar' }).waitFor()

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

      // The VIEWPORT-ABSOLUTE anchor (#1779). Everything asserted above this
      // point compares a box to itself — `scrollWidth` against `clientWidth`,
      // of the same element — so all of it is invariant under a change that
      // moves the entire shell. Found by mutation, not by reading: swapping the
      // mobile toggle's `fixed` for `relative` puts it in flow as a 32px flex
      // item ahead of the content column, and `<main>` goes
      //
      //     left   0 → 32
      //     width  393 → 361      (the column is `flex-1 min-w-0`, so it
      //     right  393 → 393       SHRINKS rather than overflowing)
      //
      // — the whole app shell displaced 32px, a dead gutter of page background
      // down the left of every authenticated route, and `contentOverflowBy`
      // still reads `361 - 361 = 0`. Three mobile specs passed it.
      //
      // Note which half does the work, because the plausible-looking version of
      // this assertion is the useless one: `contentRight === viewportWidth`
      // holds under the mutation (393 either way) and catches nothing on its
      // own. `contentLeft === 0` is what goes red. Both are asserted because
      // together they say the real invariant — below `lg` the drawer is
      // `fixed`, so it consumes no layout and the content region owns the FULL
      // width of the screen — which also catches a gutter opening on the right.
      expect(
        { left: overflow.contentLeft, right: overflow.contentRight },
        `content region is not anchored to the viewport: ${JSON.stringify(overflow)}`,
      ).toEqual({ left: 0, right: overflow.viewportWidth })

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
