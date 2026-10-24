/**
 * /design-system visual regression (#897, epic #904) — the one UNIVERSAL
 * (CI-blocking, not ship-next-dependent) visual guard. The page renders
 * deterministic demo data for every shared primitive, so any unreviewed pixel
 * drift in the app chrome (shell, sidebar) fails the PR here with a visible
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
 * it bought little beyond what the scoped clips already cover: #1820 measured the whole-page
 * budget PASSING a sidebar-confined regression the scoped sidebar capture
 * failed at 3.66x its own budget, because one number cannot be both loose
 * enough for page-wide churn and tight enough for a shell-sized change. Losing
 * it did cost real coverage — no baseline diffed primitives BELOW the shell on
 * `/design-system` until #3064 scoped one clip to the StackedBarChart showcase
 * section (the section test below, whose assertions name tick voice, partial
 * day and swatch order), joined later by one clip per showcase sample from
 * #3805 (four), #3845 (NoticeRow) and #3810 (activity row);
 * everything else below the shell on that page is still compared against
 * nothing. Whole-page pixel coverage lives in `product-routes.visual.spec.ts`
 * and seven other specs that capture `fullPage: true` (analytics, demo,
 * dev-agent-pages, home, how-it-works, marketplace, releases). The scoped
 * sidebar and showcase-sample clips below are what is left of this spec;
 * the top-bar clip that shared the file was removed with the bar itself
 * (#4029), and the authenticated whole-page baselines carry the rest of the
 * shell.
 *
 * BASELINES ARE LINUX-RENDERED (committed under e2e/__screenshots__/<spec>/,
 * one directory per spec file — there is no platform segment in the path, which
 * is why they must never be regenerated locally): CI is
 * the judge; macOS font rendering differs, so this spec's PIXEL comparison is
 * skipped locally unless VISUAL_REGRESSION=1 (VISUAL_STRUCTURE_ONLY=1 runs its
 * structural assertions anywhere — #2827). Intended visual changes: regenerate baselines in
 * the same PR — see docs/contributing/ship-playbooks/frontend.md §4
 * ("Updating visual baselines") for the CI-artifact flow.
 */
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
import { isolateShowcaseSample } from './support/isolate-sample'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, so the
// screenshot evidence (#896) and this pixel gate always render the same widths.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
// The theme seed key is the APP'S OWN constant (#2929) — the same contract
// `seedAuthenticatedSession` holds with `auth-storage.ts`: a storage-key
// rename in ThemeContext has to fail this gate, not silently compare
// light-mode renders against baselines that claim to be dark.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .ts constant with no default export shape to widen.
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{
  name: string
  width: number
  height: number
}>

// #4288: the ledger capture's clock. The day buckets are LOCAL days, so the
// spec pins its own zone — a declared override of the config's UTC (#4293),
// kept so these baselines do not move; the freeze sits
// 06:00 local (≥ 3 h past midnight) so `DS_LEDGER_ROWS`' two recent rows
// bucket under the same "Today" band and the inset divider renders.
const LEDGER_TZ = 'Europe/Stockholm'
const FROZEN_LEDGER_NOW = new Date('2026-10-20T06:00:00+02:00')

/**
 * The app shell's sidebar — the other half of the chrome (#1820), located
 * structurally and for the same reason the (since #4029 deleted) top bar
 * locator was.
 *
 * `<aside>` alone is no safer than `<header>` alone would have been, and a
 * class string is again the thing under test rather than something to locate
 * by. The sidebar is the `<aside>` immediately preceding the COLUMN that holds
 * the scroll root: the shell is `<div class="flex h-screen"><aside/><div>
 * <main id="main-content"/></div></div>`, so the sidebar is a sibling of
 * `#main-content`'s PARENT, not of `#main-content` itself. That one level is
 * the whole difference between this locator and a bare-tag read, and getting
 * it wrong yields a locator that matches nothing — which `toHaveCount(1)`
 * catches.
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
 * Below this width the sidebar rail is `hidden` (#4053; until then an
 * off-canvas `fixed` drawer), not shell chrome — `Sidebar.tsx`'s own
 * `DESKTOP_BREAKPOINT_PX`, and the `lg:` breakpoint its classes are gated on.
 *
 * Keyed on the viewport WIDTH rather than on `vp.name === 'desktop'`, so a
 * viewport added to `evidence-viewports.mjs` later is covered or excluded by
 * what it actually renders instead of by what it is called.
 *
 * Measured on the ELEMENT, not on pixels: at 390px the aside is
 * `display: none` with an empty bounding rect, so it contributes nothing to
 * the capture and there is nothing there to scope (under the pre-#4053 drawer
 * it was `fixed` at `x: -240, right: 0` — absent for a different reason). At
 * 1280px it is `position: static`, `x: 0, width: 240` — in flow, part of the
 * shell. The phone More sheet has its own baseline (`more-sheet.visual.spec.ts`).
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
 *   sidebar     100 px   0.05% of the 240 x 800 capture. Catches a nav-row
 *                        recolour (~200 px of glyph and label) by orders of
 *                        magnitude, and a 1px hairline across the 240px width
 *                        (800px tall) by 3.2x.
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
 * The top-bar clip this budget used to belong to is gone with the bar
 * (#4029); the absolute-count reasoning below carries over to the sidebar and
 * showcase budgets unchanged. The #1805 arithmetic that justified the shape is
 * kept as the historical record (see the table above).
 */

/**
 * ── The sidebar's budget (#1820) ─────────────────────────────────────────────
 *
 * The same absolute-count reasoning, with the arithmetic recomputed rather
 * than copied — and the arithmetic is the point, because the sidebar's position
 * in the whole-page capture is worse than a chrome band's in a way its raw
 * area hides.
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
 * 100 is then the same absolute slack every clip in this file carries, and on
 * this region it is proportionally the tightest — 0.05% of the 240 x 800
 * capture. It is not zero for the reason any of them is not: a runner-image or
 * Chromium bump may legitimately nudge a few pixels, and a gate that goes flat
 * red every week is a gate someone turns off.
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
 * not painted on mobile at all, because the rail is not rendered there.
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
 * hover and the collapse transition are out of its reach (the phone More
 * sheet has its own driven baseline, `more-sheet.visual.spec.ts`, #4053). Recorded here so the next reader does not infer coverage from the
 * fact that a sidebar capture exists.
 */
const SIDEBAR_MAX_DIFF_PIXELS = 100

const PIXEL_THRESHOLD = 0.02

test.describe('design-system visual regression', () => {
  test.skip(
    !VISUAL_SPECS_ENABLED,
    VISUAL_SKIP_REASON,
  )

  /**
   * Which palette this capture set renders in (#2929).
   *
   * Keyed on the PROJECT name rather than on a `test.describe` duplicated per
   * scheme, because the project is where `colorScheme` and the storage seed
   * are decided (`playwright.config.ts`), and a second copy of the whole
   * capture body is the #1863 failure shape — a spec that exists but nothing
   * runs, or two that drift. Under `chromium-desktop` this is the historical
   * light path byte-for-byte, baselines included: the `-dark` suffix appears
   * in no baseline name and no `haven.theme` seed is written, so the light
   * baselines and the light runs are untouched by this change.
   */
  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    // The DETERMINISTIC half of the dark seed (#2929). The app's no-flash
    // bootstrap reads this key before the first paint and stamps
    // `data-theme`, which pins the token block regardless of the OS — so the
    // render does not depend on `prefers-color-scheme` being honoured. The
    // project's `colorScheme: 'dark'` is the second half: it makes the
    // media-query path and every OS-sensitive native paint agree with the
    // seed instead of fighting it. addInitScript runs BEFORE any app code,
    // which is the "seeds storage before navigation" the gate requires.
    //
    // Same argument shape `seedAuthenticatedSession` uses: a single payload
    // object, no destructuring of the outer scope, because the function is
    // serialised into the page.
    const scheme = schemeOf(testInfo)
    if (scheme === 'dark') {
      await page.addInitScript(
        (themeKey) => {
          window.localStorage.setItem(themeKey, 'dark')
        },
        THEME_STORAGE_KEY,
      )
    }
  })

  for (const vp of VIEWPORTS) {
    test(`/design-system renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      // `-dark` rides the BASELINE NAME, not the project path: the snapshot
      // template has no {projectName} segment, so the two schemes must not be
      // able to resolve to the same PNG (one silently overwriting the other
      // on a --update-snapshots run is how a dark gate would end up comparing
      // light pixels).
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      // Determinism: fonts loaded, no animation mid-flight.
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      // ── The app shell ───────────────────────────────────────────────────────
      // There is NO top bar to clip since #4029: the shell's chrome above the
      // page is the safe-area band (zero-height here). The gate fails on
      // pixels, never on a missing element, so there is deliberately no
      // chrome locator here to go stale; the whole authenticated render is
      // covered by the visual baselines regenerated in the same PR.
      //
      // ── The sidebar, the other half of the chrome (#1820) ─────────────────
      // Desktop only — below `lg` the rail is hidden and absent from the
      // capture (see SIDEBAR_MIN_VIEWPORT_WIDTH above for the measurement).
      if (vp.width >= SIDEBAR_MIN_VIEWPORT_WIDTH) {
        const sidebar = page.locator(APP_SIDEBAR)
        await expect(sidebar).toHaveCount(1)
        await expect(sidebar).toHaveScreenshot(`design-system-sidebar-${vp.name}${schemeSuffix}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixels: SIDEBAR_MAX_DIFF_PIXELS,
          threshold: PIXEL_THRESHOLD,
        })
      }
    })
  }

  /**
   * ── The StackedBarChart showcase clips, the first below-shell baselines (#3064) ──
   *
   * The header above records what #2635 left uncovered: no baseline diffed any
   * primitive BELOW the shell on `/design-system`, so the StackedBarChart
   * section's rendering could drift from the primitive it documents and only a
   * reviewer's hand-rendered probe would notice — exactly how #3057's three
   * showcase changes (the striped partial day, the narrow sample's
   * `PAD_NARROW` gutter, the `formatTick` voice) were verified. The coupling
   * gate proves the primitive APPEARS on the page; these clips are the part
   * that can see whether the appearance is right.
   *
   * ── Why ONE CLIP PER SHOWCASE SAMPLE, not one section clip ──────────────────
   *
   * The issue preferred a single section-scoped clip and sanctioned one clip
   * per sample only "if the section is tall". Measured (first cut of this very
   * spec, structure mode, before the split): the section is 839.5px tall at
   * the 800px desktop viewport and 946.25px at the 844px mobile one — taller
   * than BOTH viewports, because the page scrolls inside the shell's inner
   * scroll root and the section never fits the fold anywhere this spec
   * renders. `toHaveScreenshot` on an element past the fold captures nothing
   * where the page has no painted pixels, so a one-clip cut would have been
   * unverifiable until a CI dispatch said so. The split is therefore not a
   * convenience: it is the issue's sanctioned alternative, taken on a measured
   * height, and each clip below still asserts its own box fits the viewport so
   * a future showcase edit that pushes a sample past the fold fails HERE,
   * naming the sample, instead of as an unexplained red in CI.
   *
   * The three clips, and the drift each is sized to catch:
   *   - the WIDE sample   → `design-system-stacked-bar-chart-<vp>[-dark].png`
   *     (the issue's canonical name), plus its tick voice and partial day;
   *   - the NARROW sample → `...-stacked-bar-chart-narrow-<vp>[-dark].png`,
   *     the `PAD_NARROW` gutter treatment whose tick voice #3057 changed;
   *   - the SWATCH LIST   → `...-stacked-bar-swatch-list-<vp>[-dark].png`,
   *     one `series-swatch` per agent in order, each wearing the agent's own
   *     avatar tint with its Monogram beside it (#4331).
   *
   * ── The assertions are the named causes for any pixel diff ──────────────────
   *
   * The things the #3057 reviewers measured BY HAND, now written where the
   * comparison runs: the y-ticks read `$200` / `$400` (no cents,
   * thousands-grouped — the showcase's data max is 405, `chartScale` snaps the
   * step to 200, and `formatAnalyticsTick` renders integers); exactly one day
   * carries `data-partial`, it is the LAST day, and the chart defines a hatch
   * pattern per series for it; the swatch list holds one `series-swatch` per
   * agent, IN ORDER, each wearing the agent's OWN avatar tint
   * (`seriesColorForAgent`) with its Monogram beside it (#4331). A diff with
   * none of these having moved is a paint/token
   * drift; a diff WITH one of them moved names its own cause.
   *
   * The budget is the same 100-px absolute slack every clip in this file
   * carries (SIDEBAR_MAX_DIFF_PIXELS is the named one): the measured jitter
   * floor is the same zero (includeAA off, threshold 0.02), so the budget is
   * sized to catch one hatched bar recoloured (~300 px here) and to ignore a
   * runner-image nudge. Threshold rides the shared PIXEL_THRESHOLD — at the
   * Playwright default 0.2 a token swap inside this palette counts ZERO
   * differing pixels (#1805's finding, true here too).
   */
  const SECTION_TEST_ID = 'ds-stacked-bar-chart'
  const STACKED_BAR_MAX_DIFF_PIXELS = 100

  for (const vp of VIEWPORTS) {
    test(`/design-system StackedBarChart wide sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const section = page.getByTestId(SECTION_TEST_ID)
      await expect(section).toHaveCount(1)
      // The showcase mounts exactly two charts — wide first, narrow second.
      // Scoped to the section, not the page: AreaChart uses the same chart
      // testids further down, and a page-scoped locator would be ambiguous.
      const charts = section.getByTestId('stacked-bar-chart')
      await expect(charts).toHaveCount(2)
      const wide = charts.nth(0)

      // Named cause 1 — the tick voice: `$200` / `$400`, no cents.
      await expect(wide.getByTestId('chart-tick-label')).toHaveText(['$200', '$400'])

      // Named cause 2 — the partial day: the last day, striped via the
      // hatch patterns the chart defines for it.
      const partialDay = wide.locator('[data-testid="chart-day"][data-partial="true"]')
      await expect(partialDay).toHaveCount(1)
      await expect(partialDay).toHaveAttribute('data-day-index', '6')
      await expect(wide.getByTestId('chart-hatch-pattern')).toHaveCount(2)

      await expectShowcaseClip(wide, vp.height, 'the wide sample', `design-system-stacked-bar-chart-${vp.name}${schemeSuffix}.png`, STACKED_BAR_MAX_DIFF_PIXELS)
    })

    test(`/design-system StackedBarChart narrow sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const section = page.getByTestId(SECTION_TEST_ID)
      await expect(section).toHaveCount(1)
      const charts = section.getByTestId('stacked-bar-chart')
      await expect(charts).toHaveCount(2)
      const narrow = charts.nth(1)

      // The narrow sample is its own render of the same contract — the
      // `PAD_NARROW` gutter and dot legend #3057 tuned — so its tick voice
      // and partial day are asserted on IT, not inherited from the wide one.
      await expect(narrow.getByTestId('chart-tick-label')).toHaveText(['$200', '$400'])
      const partialDay = narrow.locator('[data-testid="chart-day"][data-partial="true"]')
      await expect(partialDay).toHaveCount(1)
      await expect(partialDay).toHaveAttribute('data-day-index', '6')
      await expect(narrow.getByTestId('chart-hatch-pattern')).toHaveCount(2)

      await expectShowcaseClip(narrow, vp.height, 'the narrow sample', `design-system-stacked-bar-chart-narrow-${vp.name}${schemeSuffix}.png`, STACKED_BAR_MAX_DIFF_PIXELS)
    })

    test(`/design-system StackedBarChart swatch list renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      // Named cause 3 — the swatches: one per agent, in order, each wearing
      // the agent's OWN avatar tint (`seriesColorForAgent`, #4331 —
      // 'Research agent' hashes to --v2-avatar-6, 'Ops agent' to
      // --v2-avatar-5, pinned in `src/lib/__tests__/avatar-tint.test.ts`),
      // with the agent's Monogram beside it — the pairing the list exists to
      // show, not a rank-assigned series index the bars paint with.
      const swatchList = page.getByTestId('ds-stacked-bar-swatch-list')
      await expect(swatchList).toHaveCount(1)
      const rows = swatchList.locator('li')
      await expect(rows).toHaveCount(2)
      await expect(swatchList.getByTestId('series-swatch')).toHaveCount(2)
      const researchRow = rows.filter({ hasText: 'Research agent' })
      const opsRow = rows.filter({ hasText: 'Ops agent' })
      await expect(researchRow).toHaveCount(1)
      await expect(opsRow).toHaveCount(1)
      await expect(researchRow.getByTestId('series-swatch')).toHaveAttribute(
        'style',
        /var\(--v2-avatar-6\)/,
      )
      await expect(opsRow.getByTestId('series-swatch')).toHaveAttribute(
        'style',
        /var\(--v2-avatar-5\)/,
      )
      // The agent's own Monogram sits beside its swatch: the same aria-hidden
      // 32px mark the Monogram agent-row sample below asserts on — the #4331
      // pairing, one colour per agent.
      await expect(researchRow.locator('[aria-hidden="true"].h-8.w-8')).toHaveCount(1)
      await expect(opsRow.locator('[aria-hidden="true"].h-8.w-8')).toHaveCount(1)

      await expectShowcaseClip(swatchList, vp.height, 'the swatch list', `design-system-stacked-bar-swatch-list-${vp.name}${schemeSuffix}.png`, STACKED_BAR_MAX_DIFF_PIXELS)
    })
  }

  /**
   * ── The later showcase clips — #3805's Amount currency, AttentionList, sparkline, inline StatTile; #3845's NoticeRow; #3810's activity row ──
   *
   * The design-system pieces the redesigned dashboard (#3801) is built from,
   * each photographed against its own sample the way the StackedBarChart
   * clips above are: one clip per `data-testid` sample, per viewport, per
   * scheme — six samples, 24 baselines in all. Each clip asserts its own box
   * fits the viewport (the fold guarantee above), so an edit that pushes a
   * sample past the fold fails HERE, naming the sample.
   *
   * Placement no longer matters (#3441). Every showcase clip is captured
   * through `expectShowcaseClip`, which first takes the page above the
   * sample out of layout, so an edit above a sample cannot move its clip —
   * the guard at the end of this file proves the helper does that. A
   * showcase clip that flips in a PR that touches none of its sample is a
   * defect in that isolation, not paint drift.
   */
  const SAMPLE_MAX_DIFF_PIXELS = 100

  for (const vp of VIEWPORTS) {
    test(`/design-system Amount currency sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-amount-currency')
      await expect(sample).toHaveCount(1)
      await expectShowcaseClip(sample, vp.height, 'the Amount currency sample', `design-system-amount-currency-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })

    test(`/design-system AttentionList sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-attention-list')
      await expect(sample).toHaveCount(1)
      // All five tone items rendered — a dismiss here is interaction state,
      // and this gate photographs the resting page only. Still exactly three
      // dismiss controls: the badge-less summary stays dismissible, the
      // failure row keeps only the reserved slot, and the haven-paused row
      // (#4033) has no dismiss at all — nothing visible to align.
      await expect(sample.locator('li')).toHaveCount(5)
      await expect(sample.getByTestId(/^attention-dismiss-/)).toHaveCount(3)
      await expectShowcaseClip(sample, vp.height, 'the AttentionList sample', `design-system-attention-list-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })

    // #3845: NoticeRow is a shared haven/ primitive whose one layout decision
    // — the action on its own line under the text below sm, on the line from
    // sm up — is invisible to unit tests. Two rows: a retry and a connect.
    test(`/design-system NoticeRow sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-notice-row')
      await expect(sample).toHaveCount(1)
      await expect(sample.getByRole('button')).toHaveCount(2)
      await expectShowcaseClip(sample, vp.height, 'the NoticeRow sample', `design-system-notice-row-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })

    // #3810: the transaction-activity card — the dashboard's merchant-first
    // grouped row (countLabel ×N beside the title, the fiat amount in
    // Amount's currency mode) renders ONLY here; no unit test sees the two
    // optional props in one layout, and no other baseline covers this card.
    test(`/design-system activity row sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-activity-row')
      await expect(sample).toHaveCount(1)
      await expectShowcaseClip(sample, vp.height, 'the activity row sample', `design-system-activity-row-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })

    // #4288: the day-grouped ledger — the same-day inset divider is the one
    // layout the ds-activity-row clip cannot show. Captured in the
    // clock-frozen describe BELOW (the ledger needs a pinned timezone, which
    // cannot vary per test inside this viewport loop).
    test(`/design-system AreaChart sparkline sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-area-chart-sparkline')
      await expect(sample).toHaveCount(1)
      await expectShowcaseClip(sample, vp.height, 'the AreaChart sparkline sample', `design-system-area-chart-sparkline-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })

    test(`/design-system StatTile inline sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-stat-tile-inline')
      await expect(sample).toHaveCount(1)
      await expectShowcaseClip(sample, vp.height, 'the StatTile inline sample', `design-system-stat-tile-inline-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })

    // #4208: these are the two standing examples for the agent identity mark.
    // The first protects the compact row-sized Monogram, including the emoji
    // grapheme case; the second protects its title alignment in PageHeader.
    test(`/design-system Monogram agent-row sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-monogram')
      await expect(sample).toHaveCount(1)
      await expect(sample.locator('[aria-hidden="true"].h-8.w-8')).toHaveCount(2)
      await expect(sample.getByText('Research agent', { exact: true })).toBeVisible()
      await expectShowcaseClip(sample, vp.height, 'the Monogram sample', `design-system-monogram-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })

    test(`/design-system PageHeader leading sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
      const scheme = schemeOf(testInfo)
      const schemeSuffix = scheme === 'dark' ? '-dark' : ''
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/design-system')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')

      const sample = page.getByTestId('ds-pageheader-leading')
      await expect(sample).toHaveCount(1)
      await expect(sample.getByRole('heading', { name: 'Research agent', exact: true })).toHaveCount(1)
      await expect(sample.locator('[aria-hidden="true"].h-12.w-12')).toHaveCount(1)
      await expectShowcaseClip(sample, vp.height, 'the PageHeader leading sample', `design-system-pageheader-leading-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
    })
  }

  // #4288: the day-grouped ledger — the same-day inset divider is the one
  // layout the ds-activity-row clip cannot show. `DS_LEDGER_ROWS` stamps its
  // timestamps from `Date.now()` at module load, so the capture needs a
  // FROZEN clock, set BEFORE `goto`, at least 3 hours past local midnight
  // (else l1 and l2 fall on different days and no inset divider renders) —
  // with the timezone pinned to LEDGER_TZ — overriding the config's UTC
  // (#4293) — because the day buckets are LOCAL days. A separate describe, because the
  // timezone is a context option and this viewport loop declares its own.
  test.describe('clock-frozen ledger (#4288)', () => {
    test.use({ timezoneId: LEDGER_TZ })

    for (const vp of VIEWPORTS) {
      test(`/design-system activity ledger sample renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
        const scheme = schemeOf(testInfo)
        const schemeSuffix = scheme === 'dark' ? '-dark' : ''
        await page.clock.setFixedTime(FROZEN_LEDGER_NOW)
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto('/design-system')
        await page.evaluate(() => document.fonts.ready)
        await page.waitForLoadState('networkidle')

        const ledger = page.getByTestId('ds-activity-ledger')
        await expect(ledger).toHaveCount(1)
        // The point of the freeze: l1 and l2 share one day, so the second
        // renders WITH its same-day inset divider. If the clock were free
        // (or frozen too near midnight) the two would split across day bands
        // and the divider would vanish.
        await expect(ledger.getByText('Today')).toHaveCount(1)
        await expect(ledger.getByRole('button', { name: 'storage.provider.io' })).toHaveCount(1)
        await expectShowcaseClip(ledger, vp.height, 'the activity ledger sample', `design-system-activity-ledger-${vp.name}${schemeSuffix}.png`, SAMPLE_MAX_DIFF_PIXELS)
      })
    }
  })

  /**
   * ── The #3441 guard: content above a showcase sample cannot move its clip ──
   *
   * Every clip above is captured through `expectShowcaseClip`, which always
   * runs `isolateShowcaseSample` first — a clip test cannot skip it, and a new
   * showcase clip must use the same wrapper. This proves the helper works:
   * for each sample, captures with a 0.25, 0.5 and 0.75px spacer at the top
   * of the page must be byte-identical to one without. Measured on Linux
   * Chromium before the fix (2026-10-10), the 0.5px spacer alone moved EVERY
   * sample at both viewports (all 18 captures changed), so this fails when
   * the helper stops hiding the content above, and it needs no baseline: it
   * compares the render with itself.
   *
   * It stands in for the issue's per-run CI sweep, light scheme only: the
   * mechanism is layout, not paint, so the dark project re-running it would
   * double the cost for nothing. It cannot see content the helper
   * deliberately leaves in place — a sibling in a grid row, see
   * `isolate-sample.ts`.
   */
  const ISOLATED_SAMPLES: ReadonlyArray<[string, (p: Page) => Locator]> = [
    ['StackedBarChart wide sample', (p) => p.getByTestId(SECTION_TEST_ID).getByTestId('stacked-bar-chart').nth(0)],
    ['StackedBarChart narrow sample', (p) => p.getByTestId(SECTION_TEST_ID).getByTestId('stacked-bar-chart').nth(1)],
    ['StackedBarChart swatch list', (p) => p.getByTestId('ds-stacked-bar-swatch-list')],
    ['Amount currency sample', (p) => p.getByTestId('ds-amount-currency')],
    ['AttentionList sample', (p) => p.getByTestId('ds-attention-list')],
    ['NoticeRow sample', (p) => p.getByTestId('ds-notice-row')],
    ['activity row sample', (p) => p.getByTestId('ds-activity-row')],
    ['AreaChart sparkline sample', (p) => p.getByTestId('ds-area-chart-sparkline')],
    ['StatTile inline sample', (p) => p.getByTestId('ds-stat-tile-inline')],
    ['Monogram sample', (p) => p.getByTestId('ds-monogram')],
    ['PageHeader leading sample', (p) => p.getByTestId('ds-pageheader-leading')],
  ]

  const FRACTIONAL_SPACERS_PX = [0.25, 0.5, 0.75]

  /** Loads the page once for a sample, isolates it, and returns a capture-at-spacer function. */
  async function isolatedCapturer(page: Page, get: (p: Page) => Locator): Promise<(spacerPx: number) => Promise<Buffer>> {
    await page.goto('/design-system')
    await page.evaluate(() => document.fonts.ready)
    await page.waitForLoadState('networkidle')
    // The spacer stands in for any edit above the sample: first child of the
    // page container, before the page header. `networkidle` does not promise
    // the header has mounted, so wait for it rather than race it.
    await expect(page.locator('#main-content header').first()).toBeVisible()
    await page.evaluate(() => {
      const container = document.querySelector('#main-content header')?.parentElement
      if (!container) throw new Error('no page container under #main-content')
      const spacer = document.createElement('div')
      spacer.id = 'ds-3441-spacer'
      spacer.style.height = '0px'
      container.insertBefore(spacer, container.firstChild)
    })
    const sample = get(page)
    await expect(sample).toHaveCount(1)
    await isolateShowcaseSample(sample)
    return async (spacerPx: number) => {
      // Resized in place after isolation: if isolation stopped hiding the
      // region above, the new height would move the sample.
      await page.evaluate((px) => {
        const spacer = document.getElementById('ds-3441-spacer')
        if (!spacer) throw new Error('spacer vanished')
        spacer.style.height = `${px}px`
      }, spacerPx)
      return sample.screenshot({ animations: 'disabled', caret: 'hide' })
    }
  }

  for (const vp of VIEWPORTS) {
    test(`/design-system showcase clips ignore content above them (${vp.name}) (#3441)`, async ({ page }, testInfo) => {
      test.skip(schemeOf(testInfo) === 'dark', 'layout, not paint: the light run covers it')
      test.setTimeout(150_000)
      await page.setViewportSize({ width: vp.width, height: vp.height })
      for (const [what, get] of ISOLATED_SAMPLES) {
        const capture = await isolatedCapturer(page, get)
        const flush = await capture(0)
        for (const spacerPx of FRACTIONAL_SPACERS_PX) {
          const shifted = await capture(spacerPx)
          expect(shifted.equals(flush), `${what} moved when ${spacerPx}px of content was added above it`).toBe(true)
        }
      }
    })
  }

  /**
   * The ONE way a `/design-system` showcase clip is captured (#3441):
   * isolate the sample, assert it fits the fold, then compare. Routing every
   * clip through here is what makes the isolation unskippable — a clip test
   * that called `toHaveScreenshot` directly would be back on the old 1px
   * exposure, and the guard (which exercises the helper, not each test)
   * would not notice.
   */
  async function expectShowcaseClip(
    sample: Locator,
    viewportHeight: number,
    what: string,
    baseline: string,
    maxDiffPixels: number,
  ) {
    await isolateShowcaseSample(sample)
    await assertFitsViewport(sample, viewportHeight, what)
    await assertClearOfTabBar(sample, viewportHeight, what)
    await expect(sample).toHaveScreenshot(baseline, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels,
      threshold: PIXEL_THRESHOLD,
    })
  }

  /**
   * Below `lg` the fixed mobile tab bar covers the bottom of the viewport, so
   * "fits the viewport" is not enough: a sample whose bottom edge reaches
   * under the bar is photographed with the bar painted over it (#3441 design
   * review — the mobile activity-row clips lost their card's bottom edge
   * that way). The sample, as isolated and scrolled to the top, must end
   * above the bar.
   */
  async function assertClearOfTabBar(locator: Locator, viewportHeight: number, what: string) {
    const page = locator.page()
    const tabBarTop = await page.evaluate((vh) => {
      // The live bar is the FIXED one: /design-system also renders a
      // presentational copy carrying the same attribute (#3441 code review).
      const bar = Array.from(document.querySelectorAll('[data-mobile-tab-bar]')).find((el) => {
        const cs = getComputedStyle(el)
        return cs.position === 'fixed' && cs.display !== 'none'
      })
      return bar ? bar.getBoundingClientRect().top : vh
    }, viewportHeight)
    const box = await locator.boundingBox()
    if (!box) throw new Error(`${what} rendered no box`)
    expect(
      box.y + box.height,
      `${what} ends at ${box.y + box.height}px, under the fixed tab bar at ${tabBarTop}px — the capture would show the bar over it`,
    ).toBeLessThanOrEqual(tabBarTop)
  }

  /**
   * The fold guarantee for the clips above: the element being captured must
   * fit the viewport, because the page scrolls INSIDE the shell and pixels
   * past the fold are never painted — a clip that outgrows the viewport would
   * screenshot unpainted blankness, and only a CI dispatch would say so.
   * Assert the measured box here, where the failure names the sample.
   */
  async function assertFitsViewport(locator: Locator, viewportHeight: number, what: string) {
    const box = await locator.boundingBox()
    if (!box) {
      throw new Error(`${what} rendered no box — it never finished laying out`)
    }
    expect(
      box.height,
      `${what} grew past the ${viewportHeight}px viewport (${box.height}px) — the showcase no longer fits the fold; shrink the sample or split this clip`,
    ).toBeLessThanOrEqual(viewportHeight)
  }
})
