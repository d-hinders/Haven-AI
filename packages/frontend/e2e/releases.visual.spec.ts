/**
 * `/releases` visual regression (#3304, epic #3302).
 *
 * The public "what changed / do I need to update" page every `client_update`
 * hint and both discovery documents point at. Its body is `@haven_ai/core`'s
 * release data, rendered server-side; the update commands need the backend's
 * connector channel, which the server fetches from `GET /discovery`. The
 * visual harness runs no backend (it mocks the API inside the BROWSER, and
 * this fetch happens on the Next server), so the page renders its honest
 * "channel unknown" state: every command replaced by the sentence that says
 * why. That state is the deterministic one, and it is asserted below so a
 * baseline can never silently capture a different one.
 *
 * Light only, desktop and mobile — a public marketing-shell page with no
 * theme-specific surface of its own. Baselines are Linux-rendered by the
 * *Update visual baselines* dispatch, never locally (frontend playbook §4).
 */
import { expect, test } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the #1738 un-clip and the #1936 non-blank proof.
import { assertCaptureNotBlank, unclipScrollShell } from '../scripts/full-page-capture.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: string; width: number; height: number }>

const PIXEL_THRESHOLD = 0.02
const FULL_PAGE_MAX_DIFF_PIXELS = 150
const ANCHOR_TIMEOUT_MS = 60_000

test.describe('releases page visual regression', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  for (const vp of VIEWPORTS) {
    test(`releases renders pixel-stable (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/releases')

      await expect(page.getByRole('heading', { name: 'Releases', exact: true })).toBeVisible({
        timeout: ANCHOR_TIMEOUT_MS,
      })
      // All five packages, in update order, each with its released version.
      for (const name of ['@haven_ai/connect', '@haven_ai/signer', '@haven_ai/mcp', '@haven_ai/cli', '@haven_ai/sdk']) {
        await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1)
      }
      // The deterministic state: no backend, so no channel, so no command —
      // and never a guessed `@alpha` (#2422).
      await expect(page.getByText(/could not be read just now/)).toHaveCount(5)
      await expect(page.getByText('@alpha')).toHaveCount(0)

      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('.animate-pulse')).toHaveCount(0)

      await unclipScrollShell(page)
      const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
      await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
        label: `releases · ${vp.name}`,
        viewportDevicePx: vp.height * devicePixelRatio,
      })

      await expect(page).toHaveScreenshot(`releases-${vp.name}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
        threshold: PIXEL_THRESHOLD,
      })
    })
  }
})
