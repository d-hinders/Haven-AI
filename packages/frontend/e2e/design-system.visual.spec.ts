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
 * The app shell's sidebar — the other half of the same chrome (#1820), located
 * the same structural way and for the same reason.
 *
 * `<aside>` alone is no safer than `<header>` alone was, and a class string is
 * again the thing under test rather than something to locate by. The sidebar is
 * the `<aside>` immediately preceding the COLUMN that holds the scroll root:
 * the shell is `<div class="flex h-screen"><aside/><div><TopBar/><main
 * id="main-content"/></div></div>`, so the sidebar is a sibling of
 * `#main-content`'s PARENT, not of `#main-content` itself. That one level is
 * the whole difference between this locator and the top bar's, and getting it
 * wrong yields a locator that matches nothing — which `toHaveCount(1)` catches.
 *
 * Be honest about what that assertion does and does not buy. It closes the
 * "matches nothing" and "matches several" failures. It does NOT make the
 * locator immune to matching a plausible-but-wrong element: `[1]` on the
 * reverse `preceding-sibling` axis takes the NEAREST preceding `<aside>`, so a
 * future right-rail or notifications panel inserted between the sidebar and the
 * main column would be selected instead, still at count 1. The backstop then is
 * the baseline itself — a different element will not match a 240x800 render of
 * the sidebar — but it fails as "the sidebar drifted" rather than as "the
 * locator moved", so read a surprising failure here with that in mind.
 */
const APP_SIDEBAR = 'xpath=//*[@id="main-content"]/parent::*/preceding-sibling::aside[1]'

/**
 * Below this width the sidebar is an off-canvas drawer (`fixed`,
 * `-translate-x-full`), not shell chrome — `Sidebar.tsx`'s own
 * `DESKTOP_BREAKPOINT_PX`, and the `lg:` breakpoint its classes are gated on.
 *
 * Keyed on the viewport WIDTH rather than on `vp.name === 'desktop'`, so a
 * viewport added to `evidence-viewports.mjs` later is covered or excluded by
 * what it actually renders instead of by what it is called.
 *
 * Measured rather than assumed — and measured on the ELEMENT, because the
 * obvious pixel check is wrong here in a way that looks right. At 390px the
 * aside reports `position: fixed`, `transform: matrix(1,0,0,1,-240,0)` and a
 * bounding rect of `x: -240, width: 240, right: 0`: its right edge is exactly
 * the viewport's left edge, so it contributes nothing to the capture and there
 * is nothing there to scope. At 1280px it is `position: static`, untransformed,
 * `x: 0, width: 240` — in flow, part of the shell.
 *
 * The tempting shortcut is to assert the mobile baseline's x=0..239 band is
 * white. It is NOT: because the drawer is `fixed`, it reserves no space, so
 * `<main>` paints straight through that band and the pixels there are ordinary
 * page content. An earlier draft of this comment claimed whiteness off a
 * too-sparse sample and was wrong — the band being non-white is a CONSEQUENCE
 * of the sidebar being absent, not evidence against it. Measure the element.
 */
const SIDEBAR_MIN_VIEWPORT_WIDTH = 1024

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
 * real fits in. The companion half is in the regeneration workflow, which can
 * be dispatched with `--update-snapshots=all`: `changed` re-applies THIS
 * tolerance, so sub-budget drift is not merely un-failed but un-refreshable
 * under it.
 *
 * #2218 moved that from the workflow's hardcoded default to an explicit `mode`
 * input, because `all` blesses whatever rendered without comparing anything and
 * so re-blessed a PASSING baseline on #2217 (max channel delta 1, 180 px). The
 * default is now `changed` and `all` is the declared exception — which is the
 * right shape for the paragraph above: the un-refreshable window is real, and
 * it is also a 1..500 pixel window that nothing real fits in, so it should cost
 * a deliberate choice rather than be open on every dispatch.
 */
const FULL_PAGE_MAX_DIFF_PIXELS = 500
const TOP_BAR_MAX_DIFF_PIXELS = 100

/**
 * ── The sidebar's budget (#1820) ─────────────────────────────────────────────
 *
 * Same reasoning as the top bar's, with the arithmetic recomputed rather than
 * copied — and the arithmetic is the point, because the sidebar's position in
 * the whole-page capture is worse than the top bar's in a way its raw area
 * hides.
 *
 * Measured off the committed `design-system-desktop.png` (1,280 x 17,746) by
 * scanning the x=0..239 band row by row:
 *
 *   the sidebar's tint (--v2-surface #f6f9fc) and right border
 *   (--v2-border #e6ebf1) run from y=0 to y=663; every row below
 *   is #ffffff, all the way to y=17,745.
 *
 *   non-white pixels in the whole band:  159,329
 *   as a share of the 22,714,880-pixel capture:  0.70%
 *
 * That white tail is the documented consequence of `unclipScrollShell`, not a
 * defect: `lg:h-full` against a now-auto-height parent resolves to `auto`, so
 * the column stops at the bottom of the nav (`full-page-capture.mjs` spells
 * this out and tells reviewers not to file it). Structural, and it means the
 * sidebar contributes signal to only 663 of 17,746 rows.
 *
 * So the whole-page budget of 500 is not a second line of defence here in the
 * way its size suggests. It catches a change that repaints the sidebar wholesale
 * — 159,329 pixels is 318x the budget — but the drifts that actually happen are
 * small and local: an active-state highlight recoloured (one nav row, ~200px of
 * glyph and label), a group heading's weight or tracking, a nav label truncating
 * one character earlier, an icon swapped for a neighbour in the same lucide set.
 * Each of those is a few hundred pixels inside a 500-pixel page-wide allowance
 * that every other primitive on the page is also drawing against.
 *
 * ── The number, measured rather than chosen ──────────────────────────────────
 *
 * #1811's method, repeated: committed at `0`, pushed, and the count read off
 * what CI did with it — against a baseline generated in a DIFFERENT run
 * (baseline from run 32594037862, compared in run 32594208821, both
 * ubuntu-latest with the same cached Chromium).
 *
 *   run-to-run jitter, scoped sidebar capture, threshold 0.02:   0 pixels
 *
 * At a budget of 0 the job went GREEN, which is the strongest form this
 * measurement takes: not "under budget" but literally zero differing pixels.
 *
 * Consistent with the four existing captures, and for the same reason one layer
 * down (pixelmatch runs with `includeAA: false`, so antialiased pixels are
 * excluded before any budget is consulted).
 *
 * 100 is then the same absolute slack the top bar carries, which on this region
 * is far tighter proportionally — 0.05% of the 240 x 800 capture against the top
 * bar's 0.17% of its desktop band. It is not zero for the reason the top bar's
 * is not: a runner-image or Chromium bump may legitimately nudge a few pixels,
 * and a gate that goes flat red every week is a gate someone turns off.
 *
 * ── What 100 buys, from the mutation this shipped with ───────────────────────
 *
 * Recolouring the three nav GROUP HEADINGS one token sideways — `--v2-ink-3`
 * #5d6c85 to `--v2-ink-2` #525f7f, both solid tokens, deliberately not the
 * `/85`-on-a-bare-`var()` shape that compiles to nothing on Tailwind v3.4 and
 * made #1811's first mutation inert (#1818). On CI, both halves RUN rather than
 * being argued from one number (the scoped assertion precedes the full-page one
 * and short-circuits it, so the counterfactual needed its own run with the
 * scoped block disabled):
 *
 *   this scoped capture, budget 100:    366 px  ->  RED   (3.66x over)
 *   the whole-page capture, budget 500: same mutation ->  GREEN
 *   the mobile test:                    same mutation ->  GREEN
 *
 * The second line is the point of #1820: a real, sidebar-confined design
 * regression that the pre-existing gate passes. The third is the desktop-only
 * decision paying off in the same run — the mutated headings are not painted on
 * mobile at all, because the drawer is off-canvas there.
 *
 * Two things this measurement teaches that a single number would have hidden.
 * **Local counts are not the gate's counts:** the same mutation is 282 px
 * rendered on macOS and 366 px on Linux, ~30% apart on glyph antialiasing
 * alone. Mutation-prove locally by all means, but quote the Linux figure, since
 * the baselines are Linux. And **at Playwright's DEFAULT `threshold` of 0.2
 * this mutation counts 0 differing pixels** (YIQ delta 69.7 against a maxDelta
 * of 1,408.6) — no budget of any size would have caught it. The 0.02 threshold
 * #1805 set is doing as much work here as the scoping is.
 *
 * ── What this capture does NOT cover, said plainly ───────────────────────────
 *
 * Focus indicators. PR #1831 added eleven of them to `Sidebar`, and a scoped
 * capture of the resting state sees none of them — nothing is focused in a
 * screenshot. This gate protects the sidebar's RESTING appearance; focus,
 * hover, the open mobile drawer and the collapse transition are all out of its
 * reach, and closing that gap needs a driven scenario rather than a wider
 * region. Recorded here so the next reader does not infer coverage from the
 * fact that a sidebar capture exists.
 */
const SIDEBAR_MAX_DIFF_PIXELS = 100

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

      // ── The sidebar, the other half of the same chrome (#1820) ────────────
      // Desktop only, and BEFORE `unclipScrollShell` for a reason that is much
      // sharper here than it was for the top bar. The top bar is unaffected by
      // un-clipping either way; the sidebar is not. Un-clipping turns the shell
      // row's definite `100vh` into `height: auto`, and `lg:h-full` against an
      // auto-height parent resolves to `auto` — so a capture taken afterwards
      // would be a 240 x 663 fragment ending wherever the nav happens to end,
      // instead of the 240 x 800 column a user actually sees. That is not a
      // stricter capture, it is a capture of a shape that does not exist.
      if (vp.width >= SIDEBAR_MIN_VIEWPORT_WIDTH) {
        const sidebar = page.locator(APP_SIDEBAR)
        await expect(sidebar).toHaveCount(1)
        await expect(sidebar).toHaveScreenshot(`design-system-sidebar-${vp.name}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixels: SIDEBAR_MAX_DIFF_PIXELS,
          threshold: PIXEL_THRESHOLD,
        })
      }

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
