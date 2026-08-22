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
 * WHAT DOES NOT BELONG HERE: anything that iterates viewports itself. The
 * visual-regression spec does, and its baselines are captured at
 * deviceScaleFactor 1 — re-running it under Pixel 5's DSF 3 would fail on
 * scale, not on a defect.
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

      expect(await expectNoHorizontalOverflow(page)).toMatchObject({ hasOverflow: false })
      expect(unexpectedBrowserErrors(browserErrors)).toEqual([])
    })
  }

  /**
   * DELIBERATELY NOT HERE YET — the navigation-toggle hit-test.
   *
   * The #1749 defect class needs an assertion that the toggle is the element
   * the browser actually hands a tap at its own centre: a stacking regression
   * parks another element on top while the button stays visible, enabled and
   * `toBeVisible()`-green. It was written for this file and it FAILS on `dev`
   * as of 2026-08-22, because #1749 is still live here —
   * `document.elementFromPoint` at the toggle's centre returns
   * `TopBar`'s `<header class="relative z-[100]">`, over the toggle's `z-[60]`.
   *
   * That is a working gate finding a real bug, which is the whole point of
   * #1768. It is not committed in this PR for one reason only: the fix lives
   * in PR #1769 (#1749), which is open on another branch, and this PR must not
   * reach into it or land a knowingly red check. It is also not stubbed with
   * `test.fixme` — a spec that cannot fail is the same defect one layer up.
   *
   * Follow-up, recorded on #1769: once it merges, move its
   * `test.use({ viewport })` spec into this file (where it gets real device
   * emulation instead of a viewport override) and add the hit-test with it.
   */


})
