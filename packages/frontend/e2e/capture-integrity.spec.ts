/**
 * Full-page captures are not blank below the fold (#1738).
 *
 * The design-quality workflow (#900, #904) routes every `area:frontend` PR
 * through a rendered review over `npm run screenshot` PNGs, and pixel-compares
 * `/design-system` against committed baselines (#897). Both read a
 * `fullPage: true` capture — and both were reading captures that carried one
 * viewport of content and tens of thousands of blank rows, because the app
 * shell clips at `h-screen` / `overflow-hidden` and only `<main>` scrolls.
 *
 * Nothing announced it. The PNGs were the right size, had a correct top strip,
 * and compared clean against baselines that were blank in the same places. A
 * reviewer — and `haven-design-reviewer` — was being handed evidence that could
 * not show a defect.
 *
 * This spec runs in the ordinary browser job, so it guards every frontend PR
 * rather than only the ones that reach the visual-regression job. Delete the
 * `unclipScrollShell` call from `captureFullPage` and it fails.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, shared with scripts/screenshot.mjs
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, the capture path both evidence surfaces go through
import { TALL_FACTOR, captureFullPage, inspectCapture } from '../scripts/full-page-capture.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{
  name: string
  width: number
  height: number
}>

test.describe('full-page capture integrity', () => {
  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of VIEWPORTS) {
    test(`/design-system captures its whole height (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
      const viewportDevicePx = vp.height * devicePixelRatio

      // Throws if the capture is blank below the fold — that assertion IS the
      // regression guard, and it is the same one the screenshot script and the
      // visual spec run.
      const buffer = await captureFullPage(page, {
        label: `/design-system · ${vp.name}`,
        viewportDevicePx,
      })
      const result = await inspectCapture(buffer, { viewportDevicePx })

      // Keep the test from going vacuous. `blankBelowFold` can only be false
      // for an honest reason if there IS content below the fold to be blank —
      // if `/design-system` ever shrank to a single screen this spec would pass
      // while proving nothing, which is the exact failure mode it exists to
      // catch, one level up.
      expect(
        result.height,
        'the capture must extend well past one viewport, or this spec proves nothing',
      ).toBeGreaterThan(viewportDevicePx * TALL_FACTOR)

      expect(result.blankBelowFold).toBe(false)

      // The observed failure painted exactly one viewport out of 30,000+ rows.
      // A capture that reaches most of the way down cannot be that.
      expect(result.paintedRatio).toBeGreaterThan(0.5)
    })
  }
})
