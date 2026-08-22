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

/**
 * The app shell's top bar, located by its POSITION IN THE SHELL rather than by
 * tag or class. `<header>` alone is ambiguous — `ui/PageHeader` renders one too,
 * and `/design-system` shows it — and a class string is the thing this gate is
 * supposed to be checking, not the thing it should trust to find its subject.
 * The top bar is the header immediately preceding the shell's scroll root
 * (`(authenticated)/layout.tsx`), and nothing else on any route is.
 */
const APP_TOP_BAR = 'xpath=//*[@id="main-content"]/preceding-sibling::header[1]'

// PROBE COMMIT (#1805) — zero budget, so a comparison against the committed
// baselines reports the EXACT differing-pixel count instead of passing
// silently. Replaced with the measured numbers before this lands.
const FULL_PAGE_MAX_DIFF_PIXELS = 0
const FULL_PAGE_MAX_DIFF_PIXEL_RATIO = 0
const TOP_BAR_MAX_DIFF_PIXELS = 0

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
      test.setTimeout(180_000) // PROBE only
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      // Determinism: fonts loaded, no animation mid-flight.
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      // ── The app shell, on its own, BEFORE un-clipping ──────────────────────
      // Captured first on purpose: `unclipScrollShell` rewrites height/overflow
      // on the shell's ancestors, so anything captured after it is a shape the
      // user never sees. The top bar is unaffected either way, but "capture the
      // pristine state first" is the rule that keeps that true if the shell
      // changes.
      const topBar = page.locator(APP_TOP_BAR)
      // A locator that matched nothing would make the screenshot below error,
      // but one that matched TWO would silently capture the first — the failure
      // shape this gate exists to close. Assert the count, don't assume it.
      await expect(topBar).toHaveCount(1)
      await expect.soft(topBar).toHaveScreenshot(`design-system-topbar-${vp.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: TOP_BAR_MAX_DIFF_PIXELS,
        threshold: 0.02, // PROBE 3: measure jitter at a tight per-pixel threshold
        timeout: 20_000, // PROBE: one attempt, report the count, do not retry
      })

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

      await expect.soft(page).toHaveScreenshot(`design-system-${vp.name}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
        maxDiffPixelRatio: FULL_PAGE_MAX_DIFF_PIXEL_RATIO,
        threshold: 0.02, // PROBE 3: measure jitter at a tight per-pixel threshold
        timeout: 20_000, // PROBE: one attempt, report the count, do not retry
      })
    })
  }
})
