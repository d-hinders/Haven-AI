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
 * Desktop and mobile in the light theme, plus desktop in the dark theme
 * (#3573): the page wears the redesigned public header and footer, which
 * follow the visitor's theme. Same footprint as `/releases`.
 * Baselines are Linux-rendered by the *Update visual baselines* dispatch,
 * never locally (frontend playbook §4) — `expected` there must name
 * `demo-desktop.png`, `demo-mobile.png` and `demo-desktop-dark.png` exactly.
 */
import { expect, test } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'
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

  // #3573: the dark project (`chromium-desktop-dark`) runs this spec too.
  // Under it the theme is seeded BEFORE navigation, so the no-flash bootstrap
  // stamps `data-theme="dark"` on the first paint; desktop only — there is no
  // mobile dark baseline.
  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    if (schemeOf(testInfo) === 'dark') {
      await page.addInitScript((themeKey: string) => {
        window.localStorage.setItem(themeKey, 'dark')
      }, THEME_STORAGE_KEY)
    }
  })

  for (const vp of VIEWPORTS) {
    test(`demo renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/demo')

      // The hero renders as the page's <h1> (design review round 4) — not
      // Section's `title` prop, which always emits an <h2>.
      await expect(
        page.getByRole('heading', { level: 1, name: 'See a Haven agent pay, in about 10 minutes' }),
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

      // #3478 (slice 1 review): the shipped `<video controls>` paints
      // Chromium's native media UI into the capture, and its buffered-range
      // bar renders download state, not CSS — four captures of the same page
      // froze the bar's right edge at x220/x452/x638/x800 (two red
      // design_visual runs plus both committed baselines), all inside a 4px
      // band at y3107..3110, far over this spec's 150-pixel budget.
      // `animations: 'disabled'`, networkidle and the pulse wait above cannot
      // stabilize it. Three other mechanisms were measured and rejected:
      // a screenshot `mask` paints onto the LIVE page only (playwright-core
      // 1.60.0, `_maskElements` before `takeScreenshot`) while the committed
      // baseline is compared RAW by `compareImages`, so masking the video
      // would diff the whole video box against a baseline that still shows
      // the video (~480k pixels against the same budget); removing the
      // `controls` attribute unmounts the media-controls shadow tree and
      // flips the page's text rasterization from subpixel to grayscale AA
      // (146,093 pixels, 0.04, spread over every text run — a raster mode
      // real visitors never see); hiding only the `-enclosure` subtree keeps
      // the shadow tree mounted and the AA mode identical.
      // This injection runs in the visual harness only, AFTER every
      // structural assertion above has already passed against the shipped
      // UI — real visitors keep `controls` and `preload="metadata"` exactly
      // as shipped.
      await page.addStyleTag({
        content:
          'video::-webkit-media-controls-enclosure { display: none !important; }',
      })

      await unclipScrollShell(page)
      const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
      await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
        label: `demo · ${vp.name}`,
        viewportDevicePx: vp.height * devicePixelRatio,
      })

      await expect(page).toHaveScreenshot(`demo-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
        threshold: PIXEL_THRESHOLD,
      })
    })
  }
})
