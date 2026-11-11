/**
 * Visual regression for the Settings tab strip at phone width, dark (#4571).
 *
 * The 2026-10-30 UX audit's one 375px dark screenshot showed a thin vertical
 * line at the right end of the tab row. It reproduced, and it was a scrollbar:
 * `ui/Tabs`'s list is `overflow-x-auto`, which CSS computes to a scroll
 * container on BOTH axes, and the clipped decoration inside it (the selected
 * tab's `-mb-px` underline overlap, plus the 44px `::after` hit area centred
 * on a 38px tab) overflowed it by 3px vertically. Chrome paints a vertical
 * scrollbar for that overflow, at the right edge of the row.
 *
 * Measured on the real markup at 375x812 dark before the fix: `clientHeight`
 * 37, `scrollHeight` 40, `overflow-y: auto`, and the rightmost 8px of the row
 * painted `#494a4e` instead of the page background. After `overflow-y-hidden`
 * on the list: `scrollHeight` is still 40 (the decoration is still clipped, as
 * it always was) but the list is no longer a vertical scroll container, so no
 * scrollbar can be painted, and no other pixel moved.
 *
 * ## The assertion is the guard; the baseline is documentation
 *
 * Stated plainly because it is the difference between a real check and a green
 * tick: **the pixel comparison cannot see this defect.** Headless Chromium
 * paints overlay scrollbars, and an overlay scrollbar is not in the
 * screenshot — measured by generating this baseline with the fix reverted and
 * diffing it against the fixed one: byte-identical. So the `overflow-y`
 * assertion below is what goes red on a regression, and the PNG is what
 * catches every OTHER change to the row (labels, spacing, tones, the
 * underline). Both are worth having; only one of them is about the scrollbar.
 *
 * ## Why 375 and not the committed `mobile` viewport
 *
 * `scripts/evidence-viewports.mjs` is 1280 and 390, and adding a width there
 * mints blocking baselines for every route in every evidence run (#2006). The
 * finding was measured at 375, so this spec pins 375 itself and says so in the
 * baseline name. It is the only capture in the file, so the extra width costs
 * one PNG.
 *
 * ## Why the clip is the tablist and not the page
 *
 * The line was at the right end of the ROW. A page-level capture would also
 * fail on any unrelated Settings content change, which is the "green tick read
 * wider than the thing it measured" defect #2318 is about. The clip is the
 * tablist's own box, so the baseline is about the tab strip and nothing else.
 */
import { expect, test } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'

/** The width the audit measured at. Not in `evidence-viewports.mjs` — see above. */
const PHONE = { width: 375, height: 812 } as const

const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 50,
  threshold: 0.02,
} as const

test.describe('Settings tab strip at phone width (#4571)', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  test.beforeEach(async ({ page }) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    await page.addInitScript((themeKey: string) => {
      window.localStorage.setItem(themeKey, 'dark')
    }, THEME_STORAGE_KEY)
  })

  test('the tab row paints no scrollbar at 375px in dark mode', async ({ page }) => {
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height })
    await page.goto('/settings')

    const tablist = page.getByRole('tablist', { name: 'Settings sections' })
    await expect(tablist).toBeVisible()
    // State anchors before the shot: the three tabs rendered, and the row is
    // the one the audit measured (General / Security / Business).
    await expect(tablist.getByRole('tab')).toHaveCount(3)
    await expect(tablist.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')

    // The regression itself, asserted as a fact rather than left to the pixels
    // (which cannot see an overlay scrollbar — see the docstring). The list
    // still has 3px of clipped decoration overflow, so `scrollHeight` stays
    // above `clientHeight`; what must not happen is the list being a vertical
    // scroll container, because that is what paints the line.
    const metrics = await tablist.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }))
    expect(metrics.overflowY, 'the tablist must not be a vertical scroll container').toBe('hidden')
    // Non-vacuity: the overflow this guards against is still there to clip. A
    // list that stopped overflowing would pass the assertion above for the
    // wrong reason.
    expect(metrics.scrollHeight, 'the clipped decoration overflow is gone — re-derive this guard').toBeGreaterThan(
      metrics.clientHeight,
    )

    await page.evaluate(() => document.fonts.ready)
    await page.waitForLoadState('networkidle')

    const box = (await tablist.boundingBox())!
    await expect(page).toHaveScreenshot('settings-tabs-375-dark.png', {
      ...SNAPSHOT_OPTIONS,
      clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) },
    })
  })
})
