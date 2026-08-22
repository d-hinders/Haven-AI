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

/**
 * ── Why these are absolute pixel counts and not a ratio (#1805) ──────────────
 *
 * This gate used `maxDiffPixelRatio: 0.005` and nothing else, with the comment
 * "tiny tolerance for AA jitter; real drift is orders of magnitude larger".
 * That reasoning was sound for a viewport-sized capture and stopped being sound
 * as `/design-system` grew, because a RATIO budget scales with page length
 * while the shell it protects does not:
 *
 *   capture   dimensions       total px     0.5% budget   the 56px TopBar band
 *   mobile    390 x 29,012     11,314,680   56,573 px     21,840 px  (0.19%)
 *   desktop   1,280 x 17,746   22,714,880   113,574 px    58,240 px  (0.26%)
 *
 * (The desktop band is 1,040 wide, not 1,280 — the sidebar column sits beside
 * the header, not above it. #1805's table assumed the viewport width.)
 *
 * Every pixel of the top bar could change on either viewport and this gate
 * would still pass. Not hypothetical: #1804 moved the mobile sidebar toggle 4px
 * and slid `NetworkSwitcher` from x=36 to x=68, went green here, and left the
 * mobile baseline 2,084 pixels stale — every one of them in rows 0..55, the
 * TopBar band. That is #1760.
 *
 * ── The numbers, measured rather than chosen ─────────────────────────────────
 *
 * Measured on ubuntu-24.04 CI with the pinned Chromium, comparing each run
 * against baselines generated in a DIFFERENT run (2026-08-22; runs
 * 32570448262 / 32570717514 / 32571085181 / 32571554168):
 *
 *   run-to-run jitter, all four captures, at threshold 0.02:   0 pixels
 *
 * Zero — across 22.7M desktop pixels, twice, and again after a baseline
 * refresh. There was never antialiasing jitter for a 0.5% budget to absorb, for
 * a reason one layer down: Playwright runs pixelmatch with `includeAA: false`,
 * so antialiased pixels are DETECTED AND EXCLUDED before any budget is
 * consulted. The budget was never what protected us from AA.
 *
 * So these sit just off the floor rather than "comfortably above jitter":
 *
 *   full page   500 px   113x tighter than the old mobile budget, 227x desktop.
 *                        0.0044% / 0.0022% of the captures. Catches #1804's
 *                        2,084px shell change by 4.2x.
 *   top bar     100 px   0.46% of the mobile band, 0.17% of the desktop one.
 *                        Catches #1804's change by 20x, and a 1px hairline
 *                        across the mobile bar (390px) by 3.9x.
 *
 * Neither is zero on purpose: a runner-image or Chromium bump can legitimately
 * nudge a few pixels, and a gate that goes flat red for every PR is a gate
 * someone disables. A few hundred pixels of slack costs nothing here — the
 * smallest real change we have a measurement for is 4x the full-page floor.
 *
 * ── Why the ratio is gone rather than kept alongside ─────────────────────────
 *
 * Playwright applies `Math.min(maxDiffPixels, ratio x width x height)` when both
 * are given, so a 0.005 ratio next to a 500px floor is inert at any capture
 * above 100,000 pixels — which is every height this page will ever have. An
 * inert knob is worse than none: it reads as a second line of defence and is
 * not one.
 *
 * ── The per-pixel threshold, a separate knob that was also wrong ─────────────
 *
 * `threshold` is pixelmatch's per-pixel colour tolerance: a pixel counts as
 * different only once its YIQ delta exceeds `35215 x threshold^2`. Playwright
 * defaults to 0.2 — i.e. 1,408.6, twice pixelmatch's own default — and against
 * our palette that is blind by a wide margin:
 *
 *   --v2-bg #ffffff  ->  --v2-surface #f6f9fc      delta      24.0
 *   --v2-bg #ffffff  ->  --v2-surface-2 #eef2f7    delta      98.6
 *   --v2-border      ->  --v2-border-strong        delta     125.9
 *   a brand-indigo focus halo vs a blue one        delta   1,012.8
 *
 * None of those reaches 1,408.6. A component repainted in the wrong surface
 * token, or a focus halo that changes colour — #1760's actual case — would not
 * have been caught by a budget of ANY size, because not one pixel would have
 * been counted as different in the first place. At 0.02 (maxDelta 14.1) every
 * step in our own palette is visible, and the measurement above says it costs
 * zero jitter.
 *
 * ── "Changed but tolerated" vs "unchanged" (#1760) ───────────────────────────
 *
 * #1760 asks whether a sub-threshold-but-nonzero diff should report itself
 * rather than look identical to no diff at all. The answer taken here is to
 * remove the gap instead of instrumenting it: with measured jitter at 0 and a
 * budget of 500, "tolerated but nonzero" is a 1..500 pixel window that nothing
 * real fits in. The companion half is in the regeneration workflow, which now
 * runs `--update-snapshots=all`: a bare `--update-snapshots` means "changed",
 * which re-applies THIS tolerance, so sub-budget drift used to be not merely
 * un-failed but un-refreshable.
 */
const FULL_PAGE_MAX_DIFF_PIXELS = 500
const TOP_BAR_MAX_DIFF_PIXELS = 100
const PIXEL_THRESHOLD = 0.02

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

      // ── The app shell, on its own, BEFORE un-clipping ──────────────────────
      // A second capture of a region already inside the full-page one, because
      // one number cannot serve both a whole-page budget and a shell-sized
      // regression: the band is 0.19% (mobile) / 0.26% (desktop) of the
      // capture, so any budget loose enough to survive page-wide churn is loose
      // enough to swallow the entire chrome. Scoping the region is what makes
      // "the shell is protected" a property rather than a coincidence of how
      // quiet the rest of the page happens to be — and it makes an INTENDED
      // shell change reviewable as a 390x56 image diff instead of a 29,012px
      // one.
      //
      // Captured before `unclipScrollShell`, which rewrites height/overflow on
      // the shell's ancestors: anything captured after it is a shape no user
      // ever sees. The top bar happens to be unaffected either way — "capture
      // the pristine state first" is what keeps that true when the shell
      // changes.
      const topBar = page.locator(APP_TOP_BAR)
      // A locator matching nothing would make the screenshot below error, but
      // one matching TWO would silently capture the first — the failure shape
      // this gate exists to close. Assert the count, don't assume it.
      await expect(topBar).toHaveCount(1)
      await expect(topBar).toHaveScreenshot(`design-system-topbar-${vp.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: TOP_BAR_MAX_DIFF_PIXELS,
        threshold: PIXEL_THRESHOLD,
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

      await expect(page).toHaveScreenshot(`design-system-${vp.name}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
        threshold: PIXEL_THRESHOLD,
      })
    })
  }
})
