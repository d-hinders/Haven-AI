/**
 * `/developers` and `/for-agents` visual regression (#3577, epic #3572) — the
 * redesigned For developers and For agents pages.
 *
 * This harness builds with the site gate on (`NEXT_PUBLIC_HAVEN_SITE_PREVIEW=1`,
 * `src/lib/site-gate.ts`), so both routes render the new pages here; with the
 * gate off both 404.
 *
 * Desktop and mobile in the light theme, plus desktop in the dark theme: the
 * white and tinted sections and the package table take their dark forms,
 * the navy and indigo bands stay fixed. Baselines are Linux-rendered by the
 * *Update visual baselines* dispatch, never locally (frontend playbook §4) —
 * `expected` there must name `developers-desktop.png`,
 * `developers-mobile.png`, `developers-desktop-dark.png`,
 * `for-agents-desktop.png`, `for-agents-mobile.png` and
 * `for-agents-desktop-dark.png` exactly. This spec joins
 * `chromium-desktop-dark`'s `testMatch` in the same change that commits its
 * dark baselines (playwright.config.ts).
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

const PAGES = [
  {
    route: '/developers',
    baseline: 'developers',
    h1: 'Bring your own agent. Bring your own harness.',
    h2s: [
      'Three steps to a paying agent.',
      'Keyless where it is hosted. Keyed where it runs.',
      'Quote, sign, pay.',
      'Five packages on npm.',
      'Machine-readable, on the host you use.',
      'Give your agent a budget.',
    ],
  },
  {
    route: '/for-agents',
    baseline: 'for-agents',
    h1: 'You are an AI agent. Here is how to pay with a budget, not a credit card.',
    h2s: [
      'What Haven is, in three sentences',
      'Start here',
      'The sequence',
      'What you run',
      'How to verify',
      'A hand-off script, for the budget step',
      'If you cannot open a browser',
      'Packages and machine-readable files',
      'Your user creates the account. You do the rest.',
    ],
  },
] as const

test.describe('/developers and /for-agents visual regression', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  // The dark project (`chromium-desktop-dark`) runs this spec too. Under it
  // the theme is seeded BEFORE navigation, so the no-flash bootstrap stamps
  // `data-theme="dark"` on the first paint; desktop only — there is no
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

  for (const target of PAGES) {
    for (const vp of VIEWPORTS) {
      test(`${target.route} renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
        const scheme = schemeOf(testInfo)
        test.skip(scheme === 'dark' && vp.name !== 'desktop', 'no mobile dark baseline for this spec')
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto(target.route)

        await expect(page.getByRole('heading', { level: 1, name: target.h1 })).toBeVisible({
          timeout: ANCHOR_TIMEOUT_MS,
        })
        for (const name of target.h2s) {
          await expect(page.getByRole('heading', { level: 2, name })).toHaveCount(1)
        }

        // No horizontal scroll on a phone: the package table scrolls inside
        // its own container, never the page.
        if (vp.name === 'mobile') {
          const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
          const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
          expect(scrollWidth, 'horizontal scroll on mobile').toBeLessThanOrEqual(clientWidth + 1)
        }

        await page.evaluate(() => document.fonts.ready)
        await page.waitForLoadState('networkidle')

        await unclipScrollShell(page)
        const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
        await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
          label: `${target.baseline} · ${vp.name}`,
          viewportDevicePx: vp.height * devicePixelRatio,
        })

        await expect(page).toHaveScreenshot(
          `${target.baseline}-${vp.name}${scheme === 'dark' ? '-dark' : ''}.png`,
          {
            fullPage: true,
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
            threshold: PIXEL_THRESHOLD,
          },
        )
      })
    }
  }
})
