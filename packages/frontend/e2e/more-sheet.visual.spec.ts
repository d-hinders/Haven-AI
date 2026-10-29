/**
 * Visual regression for the phone "More" sheet (#4053): the floating card the
 * tab bar's More cell opens, in light and dark.
 *
 * No baseline showed the open phone menu before #4053 — the drawer it
 * replaced was only ever captured closed — so this is the first pixel guard
 * on it. The clip runs from the card's top to the viewport bottom, because
 * the shading is the design (#4058): the card floats over the tab bar, and
 * the scrim dims everything beneath it to the bottom edge — no scrim edge, no
 * undimmed strip, no part of the pill showing.
 */
import { expect, test } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { mockHavenApi, seedAuthenticatedSession, waitForDrawerOpen } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{ name: string; width: number; height: number }>
const MOBILE = VIEWPORTS.find((vp) => vp.name === 'mobile')
if (!MOBILE) {
  throw new Error('visual gate: evidence-viewports.mjs carries no "mobile" viewport')
}

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

test.describe('More sheet visual regression (#4053)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    if (schemeOf(testInfo) === 'dark') {
      await page.addInitScript((themeKey: string) => {
        window.localStorage.setItem(themeKey, 'dark')
      }, THEME_STORAGE_KEY)
    }
  })

  test('open sheet over the tab bar (mobile)', async ({ page }, testInfo) => {
    const scheme = schemeOf(testInfo)
    await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height })
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await waitForDrawerOpen(page)
    // The click leaves the pointer where the More cell was — and since #4058
    // the card covers that spot, so its Log out row would render in its hover
    // tint. Park the pointer on the scrim, above the card, so the baseline
    // shows the sheet at rest (a tap on a phone leaves no hover there).
    await page.mouse.move(4, 4)

    const sheet = page.locator('[data-more-sheet]')
    // State anchors before the shot: the identity row has rendered (no
    // longer a link — #4358), and the destinations are the four the tab bar
    // lacks plus Settings.
    await expect(sheet.getByText('Ada Lovelace')).toBeVisible()
    await expect(sheet.getByRole('navigation', { name: 'All sections' }).getByRole('link')).toHaveCount(5)
    await expect(sheet.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()

    // Card top to the bottom of the viewport: the card and the shading beneath it.
    const top = (await sheet.boundingBox())!.y
    await expect(page).toHaveScreenshot(`more-sheet-open-mobile${scheme === 'dark' ? '-dark' : ''}.png`, {
      ...SNAPSHOT_OPTIONS,
      clip: { x: 0, y: Math.floor(top), width: MOBILE.width, height: MOBILE.height - Math.floor(top) },
    })
  })
})
