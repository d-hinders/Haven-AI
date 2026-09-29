/**
 * `/demo` visual regression (#3477) — the investor demo page.
 *
 * `/demo` 404s on a build with the production env convention
 * (`src/lib/demo-gate.ts`'s `isDemoPageVisible`), and this visual harness's
 * `webServer` otherwise builds exactly that way (no `NEXT_PUBLIC_HAVEN_ENV`,
 * see `playwright.config.ts`). `HAVEN_DEMO_PAGE_VISIBLE=1` is the server-only
 * override `playwright.config.ts` sets for this reason — production never
 * sets it, so it changes nothing about a real deployment.
 *
 * Desktop and mobile only, light theme — a public marketing-shell page with
 * no theme-specific surface of its own (same footprint as `/releases`).
 * Baselines are Linux-rendered by the *Update visual baselines* dispatch,
 * never locally (frontend playbook §4) — `expected` there must name
 * `demo-desktop.png` and `demo-mobile.png` exactly.
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

test.describe('/demo visual regression', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  for (const vp of VIEWPORTS) {
    test(`demo renders pixel-stable (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/demo')

      await expect(
        page.getByRole('heading', { name: 'See a Haven agent pay, in about 10 minutes' }),
      ).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })

      // All eight steps present, in order.
      for (const title of [
        'Create your account',
        'Fund it with test USDC',
        'Connect an agent',
        'Approve its budget with your passkey',
        "Check that it's connected",
        'Buy a joke',
        'Try to overspend',
        'What you just saw',
      ]) {
        await expect(page.getByRole('heading', { name: title })).toHaveCount(1)
      }

      // Mobile carries the same content with no horizontal scroll — the copy
      // says laptop-first, but the page must still render honestly on a phone.
      if (vp.name === 'mobile') {
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
        const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
        expect(scrollWidth, 'horizontal scroll on mobile').toBeLessThanOrEqual(clientWidth + 1)
      }

      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('.animate-pulse')).toHaveCount(0)

      await unclipScrollShell(page)
      const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
      await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
        label: `demo · ${vp.name}`,
        viewportDevicePx: vp.height * devicePixelRatio,
      })

      await expect(page).toHaveScreenshot(`demo-${vp.name}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
        threshold: PIXEL_THRESHOLD,
      })
    })
  }
})
