/**
 * /design-system visual regression (#897, epic #904) — the one UNIVERSAL
 * (CI-blocking, not ship-next-dependent) visual guard. The page renders
 * deterministic demo data for every shared primitive, so any unreviewed pixel
 * drift in the app shell (top bar, sidebar) fails the PR here with a visible
 * diff.
 *
 * ── The whole-page capture is GONE (#2635) ───────────────────────────────────
 *
 * This spec used to also capture the full `/design-system` page — a
 * 22.7M-pixel render against a 500-pixel budget — alongside the scoped shell
 * clips below. It dominated this job's failure history: 5 of a 12-failure
 * sample as first counted, and 7 of 12 when an independent review re-derived
 * it over every `ci.yml` run in the same window. Both counts are recorded
 * because they disagree, and the disagreement is a sampling difference (per-PR
 * dedup vs. per-run) rather than a correction — the review's number is the
 * larger one, so it strengthens the case rather than weakening it.
 *
 * WHAT THE FAILURES ACTUALLY WERE, corrected on review. The first reading here
 * was "a 15s `toHaveScreenshot` timeout — the page is too tall to compare in
 * the budget". The CI logs say otherwise: Playwright DID compute stable diffs
 * before failing, and their magnitudes ranged from ~12k px (1%) to ~2.7M px
 * (23% of the image) across branches with no relation to this page —
 * cli-channel-naming, copy-dead-code-sweep, transaction-row-titles. A capture
 * that renders 23% differently on unrelated branches is NON-DETERMINISTIC, not
 * slow, and that is why raising the timeout was the wrong fix and deleting was
 * the right one: no timeout closes a render that differs by a quarter of the
 * image. The cause of the non-determinism — most likely below-the-fold content
 * settling — is NOT established here, and is left named rather than guessed. It bought little
 * beyond what the scoped clips already cover: #1820 measured the whole-page
 * budget PASSING a sidebar-confined regression the scoped sidebar capture
 * failed at 3.66x its own budget, because one number cannot be both loose
 * enough for page-wide churn and tight enough for a shell-sized change. Losing
 * it does cost real coverage — no baseline anywhere now diffs primitives
 * BELOW the shell on `/design-system` itself — and that gap is not closed
 * here; `product-routes.visual.spec.ts`'s whole-page `/dashboard` and
 * `/transactions` baselines remain the only whole-page pixel coverage in the
 * suite. The scoped top-bar and sidebar clips below are what is left of this
 * spec, and they are unaffected by the removal — they were never the flaky
 * half.
 *
 * BASELINES ARE LINUX-RENDERED (committed under e2e/__screenshots__/<spec>/,
 * one directory per spec file — there is no platform segment in the path, which
 * is why they must never be regenerated locally): CI is
 * the judge; macOS font rendering differs, so this spec is skipped locally
 * unless VISUAL_REGRESSION=1. Intended visual changes: regenerate baselines in
 * the same PR — see docs/contributing/ship-playbooks/frontend.md §4
 * ("Updating visual baselines") for the CI-artifact flow.
 */
import { expect, test } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, so the
// screenshot evidence (#896) and this pixel gate always render the same widths.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'

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
 * once this spec ALSO whole-page-captured `/design-system`, because a RATIO
 * budget scales with page length while the shell it protects does not:
 *
 *   capture   dimensions       total px     0.5% budget   the 56px TopBar band
 *   mobile    390 x 29,012     11,314,680   56,573 px     21,840 px  (0.19%)
 *   desktop   1,280 x 17,746   22,714,880   113,574 px    58,240 px  (0.26%)
 *
 * (The desktop band is 1,040 wide, not 1,280 — the sidebar column sits beside
 * the header, not above it. #1805's table assumed the viewport width.) The
 * whole-page capture these dimensions describe is gone (#2635, see the file
 * header); the table is kept as the historical record of why a RATIO stays
 * wrong even for the scoped clips below, whose own captures are small enough
 * that the arithmetic is not otherwise obvious.
 *
 * Every pixel of the top bar could change on either viewport and a
 * ratio-only gate would still pass. Not hypothetical: #1804 moved the mobile
 * sidebar toggle 4px and slid `NetworkSwitcher` from x=36 to x=68, went green
 * under the old ratio-only gate, and left the mobile baseline 2,084 pixels
 * stale — every one of them in rows 0..55, the TopBar band. That is #1760.
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
 *   top bar     100 px   0.46% of the mobile band, 0.17% of the desktop one.
 *                        Catches #1804's change by 20x, and a 1px hairline
 *                        across the mobile bar (390px) by 3.9x.
 *
 * Not zero on purpose: a runner-image or Chromium bump can legitimately
 * nudge a few pixels, and a gate that goes flat red for every PR is a gate
 * someone disables.
 *
 * ── Why the ratio is gone rather than kept alongside ─────────────────────────
 *
 * Playwright applies `Math.min(maxDiffPixels, ratio x width x height)` when both
 * are given, so a 0.005 ratio next to a small absolute floor is inert at any
 * capture above 100,000 pixels — which every capture in this spec, scoped or
 * not, either is or was. An inert knob is worse than none: it reads as a
 * second line of defence and is not one.
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
 * budget of 100, "tolerated but nonzero" is a 1..100 pixel window that nothing
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
 * it is also a small pixel window that nothing real fits in, so it should cost
 * a deliberate choice rather than be open on every dispatch.
 */
const TOP_BAR_MAX_DIFF_PIXELS = 100

/**
 * ── The sidebar's budget (#1820) ─────────────────────────────────────────────
 *
 * Same reasoning as the top bar's, with the arithmetic recomputed rather than
 * copied — and the arithmetic is the point, because the sidebar's position in
 * the whole-page capture is worse than the top bar's in a way its raw area
 * hides.
 *
 * Measured off the (since-deleted, #2635) `design-system-desktop.png`
 * (1,280 x 17,746) by scanning the x=0..239 band row by row:
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
 * The whole-page capture this comparison was originally measured against is
 * gone (#2635) — it is kept here as the historical record of why the whole-page
 * budget was never a second line of defence for the sidebar: it caught a
 * change that repainted the sidebar wholesale — 159,329 pixels was 318x that
 * budget — but the drifts that actually happen are small and local: an
 * active-state highlight recoloured (one nav row, ~200px of glyph and label),
 * a group heading's weight or tracking, a nav label truncating one character
 * earlier, an icon swapped for a neighbour in the same lucide set. Each of
 * those is a few hundred pixels, which is exactly the range this scoped
 * capture's own 100px budget is sized to catch.
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
 * made #1811's first mutation inert (#1818). On CI (measured while the
 * whole-page capture this spec has since dropped, #2635, was still present),
 * both halves RAN rather than being argued from one number (the scoped
 * assertion preceded the whole-page one and short-circuited it, so the
 * counterfactual needed its own run with the scoped block disabled):
 *
 *   this scoped capture, budget 100:    366 px  ->  RED   (3.66x over)
 *   the whole-page capture, budget 500: same mutation ->  GREEN
 *   the mobile test:                    same mutation ->  GREEN
 *
 * The second line is the point of #1820: a real, sidebar-confined design
 * regression that the whole-page gate passed at the time — now moot, since
 * that capture no longer exists to pass anything. The third is the
 * desktop-only decision paying off in the same run — the mutated headings are
 * not painted on mobile at all, because the drawer is off-canvas there.
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
    !VISUAL_SPECS_ENABLED,
    VISUAL_SKIP_REASON,
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

      // ── The app shell ───────────────────────────────────────────────────────
      // Scoping the region is what makes "the shell is protected" a property
      // rather than a coincidence of how quiet the rest of the page happens to
      // be — and it makes an INTENDED shell change reviewable as a 390x56 image
      // diff instead of a full-page one (#2635 dropped the whole-page capture
      // this comment used to contrast against; see the file header).
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
      // Desktop only — below `lg` it is an off-canvas drawer absent from the
      // capture (see SIDEBAR_MIN_VIEWPORT_WIDTH above for the measurement).
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
    })
  }
})
