/**
 * /design-system visual regression (#897, epic #904) — the one UNIVERSAL
 * (CI-blocking, not ship-next-dependent) visual guard. The page renders
 * deterministic demo data for every shared primitive, so any unreviewed pixel
 * drift in ui/haven components fails the PR here with a visible diff.
 *
 * BASELINES ARE LINUX-RENDERED (committed under __screenshots__/linux/): CI is
 * the judge; macOS font rendering differs, so this spec is skipped locally
 * unless VISUAL_REGRESSION=1. Intended visual changes: regenerate baselines in
 * the same PR — see docs/contributing/ship-playbooks/frontend.md §4
 * ("Updating visual baselines") for the CI-artifact flow.
 */
import { expect, test } from '@playwright/test'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, so the
// screenshot evidence (#896) and this pixel gate always render the same widths.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; shared with scripts/screenshot.mjs so both capture
// paths un-clip the shell the same way and are held to the same guard (#1738).
import { assertCaptureNotBlank, unclipScrollShell } from '../scripts/full-page-capture.mjs'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{
  name: string
  width: number
  height: number
}>

test.describe('design-system visual regression', () => {
  test.skip(
    process.env.VISUAL_REGRESSION !== '1',
    'Linux-rendered baselines — run via the CI job (or VISUAL_REGRESSION=1 in a Linux container)',
  )

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
  })

  for (const vp of VIEWPORTS) {
    test(`/design-system renders pixel-stable (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      // Determinism: fonts loaded, no animation mid-flight.
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      // The app shell clips at h-screen/overflow-hidden, so a `fullPage`
      // capture paints only the first viewport and leaves a very long white
      // tail. Until #1738 these baselines were 95%+ blank, which made this
      // gate pass vacuously for every primitive below the fold. Un-clip, then
      // PROVE the capture is not blank before letting it stand as a baseline —
      // a pixel gate whose baseline is empty compares white to white forever.
      await unclipScrollShell(page)
      const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
      await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
        label: `/design-system · ${vp.name}`,
        viewportDevicePx: vp.height * devicePixelRatio,
      })

      await expect(page).toHaveScreenshot(`design-system-${vp.name}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        // Tiny tolerance for AA jitter; real drift is orders of magnitude larger.
        maxDiffPixelRatio: 0.005,
      })
    })
  }
})
