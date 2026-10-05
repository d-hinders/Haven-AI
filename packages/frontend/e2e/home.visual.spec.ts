/**
 * `/` visual regression, GATE-ON build (#3574).
 *
 * This harness's webServer sets `NEXT_PUBLIC_HAVEN_SITE_PREVIEW=1`
 * (playwright.config.ts, #3573), so `/` here IS the new page: the nine
 * sections of the redesigned home, static. With the gate off (production
 * until slice 7) the route renders the legacy page, whose own look is pinned
 * by nothing — accepted for this slice per epic #3572's e2e rule, the same
 * accepted residual the retargeted focus spec carries.
 *
 * Desktop and mobile in the light theme, plus desktop in the dark theme:
 * white and tinted sections and the product frames take their dark forms;
 * the navy and indigo bands are identical in both themes. Baselines are
 * Linux-rendered by the *Update visual baselines* dispatch, never locally
 * (frontend playbook §4) — `expected` there must name `home-desktop.png`,
 * `home-mobile.png` and `home-desktop-dark.png` exactly.
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

test.describe('/ (new home) visual regression', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  // The dark project (`chromium-desktop-dark`) runs this spec too. Under it
  // the theme is seeded BEFORE navigation, so the no-flash bootstrap stamps
  // `data-theme="dark"` on the first paint; desktop only — no mobile dark
  // baseline for this spec.
  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    // The baselines are the SETTLED page (slice 2, #3574). This slice added
    // the mockup's loops (#3575); every one falls back to its settled state
    // under `prefers-reduced-motion: reduce` (home-motion.test.tsx asserts
    // it), so the capture emulates reduce and no loop can run into a
    // baseline — belt to `animations: 'disabled'`'s braces.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    if (schemeOf(testInfo) === 'dark') {
      await page.addInitScript((themeKey: string) => {
        window.localStorage.setItem(themeKey, 'dark')
      }, THEME_STORAGE_KEY)
    }
  })

  for (const vp of VIEWPORTS) {
    test(`home renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/')

      // The dev server's overlay ("N · n Issues") renders in a
      // `nextjs-portal` web component the baselines never saw — same hide as
      // `scripts/screenshot.mjs` (and mobile-nav-layering.mobile.spec.ts);
      // CI runs the standalone production server, where it doesn't exist.
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' })

      // The hero renders as the page's <h1> — the anchor that proves THIS
      // page, not the legacy one, answered.
      await expect(
        page.getByRole('heading', { level: 1, name: 'Give your agent a budget, not your credit card.' }),
      ).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })

      // The nine sections, in the mockup's order.
      for (const heading of [
        'Autonomy ends at the point of payment.',
        'Three steps. Your agent pays for what it needs, within a budget you set.',
        'Bring your own agent. Bring your own harness.',
        'Every payment appears in your bookkeeping tool.',
        'The rails for agent payments are being built right now.',
        'An over-budget payment reverts automatically.',
        'Any agent. Any rail. Every payment accounted for.',
        'Give your agent a budget.',
      ]) {
        await expect(page.getByRole('heading', { name: heading })).toHaveCount(1)
      }

      // Mobile carries the same content with no horizontal scroll.
      if (vp.name === 'mobile') {
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
        const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
        expect(scrollWidth, 'horizontal scroll on mobile').toBeLessThanOrEqual(clientWidth + 1)
      }

      // The step 3 terminal wraps, never scrolls sideways (#3644), at every
      // viewport this spec runs.
      const terminal = await page.evaluate(() => {
        const node = document.querySelector('[data-connector-terminal]')
        return node ? { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth } : null
      })
      expect(terminal, 'step 3 terminal rendered').not.toBeNull()
      expect(terminal!.scrollWidth, 'step 3 terminal scrolls sideways').toBeLessThanOrEqual(terminal!.clientWidth + 1)

      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('.animate-pulse')).toHaveCount(0)

      await unclipScrollShell(page)
      const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
      await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
        label: `home · ${vp.name}`,
        viewportDevicePx: vp.height * devicePixelRatio,
      })

      await expect(page).toHaveScreenshot(`home-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
        threshold: PIXEL_THRESHOLD,
      })
    })
  }
})
