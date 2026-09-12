/**
 * Product-route visual regression (#2318) — the blocking pixel gate's first
 * whole-screen coverage of a route a USER actually visits.
 *
 * ── What this file exists to fix ─────────────────────────────────────────────
 *
 * The blocking *Design visual regression* job is read as "the UI is unchanged".
 * Before this file it licensed that reading for `/design-system` and for four
 * element-scoped clips on `/agents` — 22 baselines, two routes, and not one
 * whole product screen. `/design-system` renders every primitive in isolation,
 * so a primitive that regresses is caught; a *composition* that regresses — a
 * section that stopped rendering, a card that moved below the fold, a header
 * that lost its actions — is not, on any route.
 *
 * ── Why exactly these two routes, and not more (#2318) ───────────────────────
 *
 * The candidate set was measured rather than picked, by rendering all six
 * fixture-backed authenticated routes through this same harness and reading
 * back `#main-content` text, the console error stream, and failed requests:
 *
 *   route           chars  console errors  wall-clock text  verdict
 *   /settings       1,407  0               none            deferred (see below)
 *                   ^ measured before #2926; the Settings language row was
 *                     removed there, so /settings now reads ~90 characters
 *                     lower. The verdict below is unchanged.
 *   /dashboard        810  0               "3mo ago"       ADDED, clock frozen
 *   /agents           549  1 (chain RPC)   none            rejected
 *   /transactions     320  0               "3mo ago"       ADDED, clock frozen
 *   /contacts         179  0               none            deferred
 *   /accounts         104  0               "Added 4mo ago" rejected
 *
 * `/dashboard` is the post-login landing screen and the densest composition of
 * shared primitives in the product; `/transactions` is the money-history screen
 * and the `Table` primitive's only product consumer at scale. Neither had a
 * pixel of coverage.
 *
 * **`/agents` and `/agents/agent-research` are covered from #2733.** The 2026-09-07
 * `still-loading` failure that kept the detail route out of this gate probed a
 * phantom fixture id — one that existed only inside two scenario payloads and
 * one unit test, never served by any fixture; the seeded fixture agents were
 * `agent-research` and `agent-retired` all along, and `AgentDetailClient`
 * renders its not-found branch for any other id, which the harness correctly
 * refused as still-loading. With the phantom id gone (#2733) the route captures
 * populated. The original `/agents` objection — a whole-page baseline
 * photographing a live `readContract` against a chain that does not exist in
 * the harness — named `useOnChainAllowances.ts`, deleted by #2331; the
 * objection's subject no longer exists, and the harness's own refusal of
 * half-rendered captures (the `minChars` floor below, plus
 * `assertCaptureNotBlank`) is the remaining defence against a mid-load frame
 * ever standing as a baseline. `/agents` carries four element-scoped baselines
 * and is the most actively edited screen in the repo, so these two routes ship
 * MOBILE-only by decision: the mobile composition is what #2733 tunes and what
 * nothing else measured, desktop adds a second re-bless tax on the repo's
 * hottest screen without a defect pointing at it, and the overflow class a
 * desktop baseline would catch is guarded by boolean measurement in
 * `agent-detail.mobile.spec.ts` (#1858's standing argument).
 *
 * **`/accounts` was rejected on fixture fidelity (#2225) — superseded 2026-09-10
 * by #2817, which adds this route MOBILE-only.** The rejection was written
 * while #2225 was open: both balance fixtures (`scripts/screenshot.mjs`'s
 * `fixtureFor` and this spec's `haven-api.ts`) key `/portfolio/` and
 * `/balances/` on the path PREFIX and ignore the address, so a harness serving
 * two accounts photographs byte-identical balances for both. #2225 then closed
 * 2026-09-01 as false-instrument WITHOUT a fixture change — verified against
 * `docs/quality/issue-classification-2026-09.csv` (row 2225) and against both
 * handlers on `dev`, which remain prefix-keyed. The instrument defect is real
 * and the warning STANDS for any harness serving more than one account; it is
 * unobservable in THIS gate because `mockHavenApi` seeds exactly ONE Safe
 * (`testSafe`), so no two accounts here can render identical-looking balances.
 * Re-derive this paragraph before a second fixture account is seeded or an
 * address-keyed fixture fix lands in either file. #2817's capture also keeps
 * clear of the `/agents` flake class: `/accounts` makes no on-chain call —
 * its portfolio and balances come from the shared fixture.
 *
 * `/settings` and `/contacts` are deferred rather than rejected — nothing is
 * wrong with them, they are simply lower-traffic, and every added baseline is
 * re-blessed forever. `/settings` is the cheapest next candidate: it measured
 * as the most render-complete and most deterministic authenticated route in the
 * repo (1,407 chars at the time of that measurement — see the note in the
 * table — zero console errors, no chain call, no wall-clock text).
 *
 * ── Everything NOT listed above still has NO baseline ────────────────────────
 *
 * Said here, and said again in CI's own step summary
 * (`scripts/ci/visual-baseline-inventory.mjs`), because the whole defect in
 * #2318 was a green tick being read wider than the thing it measured. The
 * connect-agent flow, the agent detail page, onboarding, login/signup, the
 * marketing routes and every modal are uncovered by this gate.
 *
 * **`/login` deliberately earns no committed baseline now that it is
 * capturable ([#2825](https://github.com/d-hinders/Haven-AI/issues/2825)) —
 * "No" is the recorded decision.** The screen is reachable on demand (declare
 * nothing; the route's `signedOut: true` definition in
 * `scripts/screenshot.mjs` makes `npm run screenshot -- /login` produce real
 * evidence), so the thing a baseline would add is a *standing* gate, and the
 * same trade #1944 declined for a 320px baseline applies: every added baseline
 * is re-blessed forever, and this screen churns by design — the #2819/#2824
 * chrome work is exactly the kind of design-only change that would have paid
 * the tax with no defect on either side. What #2816 actually exposed was not
 * "no baseline" but "mislabeled evidence": a capture named for `/login` whose
 * pixels were the dashboard. That failure class is gated where it belongs — by
 * the byte-identity guard in the capture harness — not by a pixel baseline
 * this file would have to re-bless on every branding pass.
 *
 * ── The frozen clock is load-bearing, not hygiene ────────────────────────────
 *
 * `lib/format.ts`'s `timeAgo` buckets against `Date.now()`, and the fixtures
 * carry FIXED timestamps. So a `/transactions` baseline captured today renders
 * `3mo ago` and re-renders `4mo ago` on a date this repo does not control —
 * a blocking gate that goes red on a calendar boundary, weeks after the commit
 * that "caused" it, which is the worst possible flake to diagnose.
 *
 * `page.clock.setFixedTime` (not `install`) pins `Date.now()` without pausing
 * timers, so React's scheduler is untouched. And the freeze is ASSERTED rather
 * than assumed: `expectFrozenRelativeTime` pins the literal string the frozen
 * clock must produce, so a clock that stops working fails by name — "the
 * frozen clock is not in effect" — instead of as an unattributable pixel diff
 * three months from now.
 *
 * ── Budgets and threshold ────────────────────────────────────────────────────
 *
 * Deliberately the SAME numbers `design-system.visual.spec.ts` measured and
 * argues for at length (500 px full-page, threshold 0.02): its measurement is
 * of the runner and the palette, not of the page, so re-deriving them here
 * would be ceremony. Read that file's header for why 0.02 rather than
 * Playwright's default 0.2 — at the default, a component repainted one surface
 * token sideways counts ZERO differing pixels and no budget of any size catches
 * it.
 *
 * BASELINES ARE LINUX-RENDERED, exactly as every other file in this family:
 * CI is the judge, macOS font rendering differs, so this spec is skipped
 * locally unless `VISUAL_REGRESSION=1` (`VISUAL_STRUCTURE_ONLY=1` runs the
 * structural assertions anywhere — #2827). Intended visual changes: regenerate via
 * the *Update visual baselines* workflow_dispatch on the PR branch — and name
 * the baselines in its `expected` input, never `--update-snapshots=all`, which
 * re-blesses passing baselines nobody compared (#2218). See
 * `docs/contributing/ship-playbooks/frontend.md` §4.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import {
  mockHavenApi,
  seedAuthenticatedSession,
  serveAgentDetailResponses,
} from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, shared with
// the screenshot evidence (#896) and the /design-system gate (#897).
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
 * Desktop only for the two #2318 routes, and stated as a decision rather than
 * an omission.
 *
 * The mobile renderings of those two routes were NOT covered here. Doubling
 * the baselines doubles what every unrelated change to either screen has to
 * re-bless, and #1944's standing reasoning is that a new blocking baseline is
 * paid for forever. Mobile layout on those routes is meanwhile guarded by the
 * non-pixel specs that measure overflow directly
 * (`transaction-row.mobile.spec.ts`, `table-container-collapse.spec.ts`) —
 * a boolean assertion, which #1858 is the standing evidence is the STRONGER
 * instrument for overflow, since an overflow photographs perfectly happily.
 *
 * #2733 inverts that choice for the two routes it adds: the mobile
 * composition is the thing that issue tunes and the thing nothing else
 * measured, so those two ship MOBILE-only (see the header note above).
 *
 * #2817 (2026-09-10) extends it once more: `/dashboard`, `/transactions` and
 * `/accounts` also carry MOBILE now — the bottom tab bar (#2805) makes the
 * 390px shell a first-class screen the demo lives on, and the three hub
 * routes the bar routes to were compared against nothing at that width. The
 * desktop baselines of the first two are untouched (same axis, same snapshot
 * name, byte-identical PNG), so this adds coverage without regenerating
 * anything that already existed. The either/or `mobileOnly` flag became a
 * per-route `viewports` list for the same reason a flag cannot ADD a width.
 */
const DESKTOP = VIEWPORTS.find((vp) => vp.name === 'desktop')
/** The committed mobile evidence width — 390, per `evidence-viewports.mjs`. */
const MOBILE = VIEWPORTS.find((vp) => vp.name === 'mobile')

/**
 * ── The budget, measured on these captures rather than inherited (#2318) ─────
 *
 * `design-system.visual.spec.ts` uses 500 and argues for it at length. That
 * argument is about the RUNNER (measured run-to-run jitter of 0 px, because
 * pixelmatch runs with `includeAA: false`) plus deliberate slack for a
 * runner-image or Chromium bump. The slack half does not transfer unexamined,
 * because 500 was chosen against a 22.7M-pixel page and these captures are an
 * order of magnitude shorter.
 *
 * Measured here, on this harness, rather than assumed:
 *
 *   run-to-run jitter, both captures, at threshold 0.02:   0 px
 *     — two consecutive green runs at budget 500, and `/transactions` green at
 *       a budget of literally 0 in a third run.
 *
 *   a one-token recolour of `/dashboard`'s "Total balance" label
 *   (`--v2-ink-2` #525f7f -> `--v2-ink`, DashboardClient.tsx:281):
 *                                             366 px  (macOS)
 *
 *   a one-sentence copy change to `/transactions`'s subtitle
 *   (`transaction-scope.ts:63`'s `defaultSubtitle`, "All activity across
 *    your accounts." -> "…across every one of your accounts."):
 *                                             479 px  (macOS)
 *
 *     — two real, reviewable regressions that a budget of 500 SWALLOWS, one
 *       on each route. Both were proven RED at 150 and GREEN at 500, both left
 *       the OTHER route green (so the failure names the route that changed),
 *       and both were restored from a `cp` backup and `diff -q`-verified
 *       byte-identical rather than by inverting the edit.
 *
 * That is #1820's finding arriving on a new surface: a whole-page
 * budget loose enough to survive page-wide churn is loose enough to swallow a
 * small local regression, and a gate that does that is exactly the
 * over-readable green tick #2318 is about. So the number is set from the
 * measurement: 150 sits well clear of a measured zero and catches the 366 px
 * class by 2.4x.
 *
 * It is deliberately not 0. A runner-image or Chromium bump may legitimately
 * nudge a few pixels, and a gate that goes flat red every week is a gate
 * someone turns off. If Linux CI shows jitter above this, move the number WITH
 * A MEASUREMENT — the baselines here are generated in one CI run and first
 * compared in another, so that measurement is taken for free on this PR.
 *
 * Both figures above are macOS, and that matters because **local counts are not
 * the gate's counts**: `design-system.visual.spec.ts` measured ITS OWN
 * (unrelated) sidebar mutation at 282 px on macOS and 366 px on Linux — ~30%
 * apart on glyph antialiasing alone. Note the collision: that file's LINUX
 * figure and this file's `/dashboard` MACOS figure are both 366, and they are
 * different mutations on different pages. Say which platform whenever you quote
 * either, and expect the Linux numbers here to land somewhat higher. 150 has
 * headroom for that in the direction that matters — a Linux count above the
 * macOS one makes these mutations MORE visible to the gate, not less.
 */
const FULL_PAGE_MAX_DIFF_PIXELS = 150

/**
 * Playwright's default `threshold` is 0.2, at which a component repainted one
 * surface token sideways counts ZERO differing pixels and no budget of any size
 * catches it. 0.02 is `design-system.visual.spec.ts`'s measured value and its
 * reasoning is about the palette, not the page, so it transfers unchanged.
 */
const PIXEL_THRESHOLD = 0.02

/**
 * The instant every capture in this file renders at.
 *
 * Any fixed instant works; what must not vary is that it is fixed. Chosen just
 * after the fixture timestamps so the relative-time strings render in their
 * ordinary (months-ago) form rather than in a degenerate one.
 */
const FROZEN_NOW = new Date('2026-09-01T12:00:00.000Z')

/**
 * How long to wait for a route's content anchor. See the call site: this is
 * sized for a cold `next dev` compile, not for CI's prebuilt server.
 */
const ANCHOR_TIMEOUT_MS = 60_000

/**
 * A page carrying less rendered text than this is still mounting.
 *
 * `ProtectedRoute` renders `null` while auth resolves, so there is a real
 * window after navigation in which `#main-content` does not exist — and a cold
 * `next dev` compile widens it enormously. Measured on this harness: the same
 * `/dashboard` navigation returned 810 characters on a warm run and `0` with
 * `#main-content` absent on a cold one, on identical code. That is the same
 * signature the design review of PR #2311 hit on `connect-agent-approved`
 * ("the page rendered almost nothing (33 characters)"), so treat a failure here
 * as a render/compile problem before suspecting the fixture.
 *
 * Per route rather than one global floor, because the floor has to sit under
 * the route's real content and `/transactions` legitimately renders 320
 * characters while `/settings` renders an order of magnitude more (1,407 when
 * measured; see the table note).
 *
 * Per AXIS as well, not just per route (#2817): a responsive layout carries
 * less text at 390 than at 1280 — `/transactions` measures 246 characters at
 * the mobile width against 320 at desktop, on this harness — so a floor set
 * from the desktop measurement fails every mobile run of the same route.
 * `minCharsMobile` overrides `minChars` on the mobile axis only, and is set
 * FROM MEASUREMENT like the desktop numbers: `/transactions` mobile gets 200
 * (measured 246), `/accounts` mobile gets 100 (measured 104 — matching the
 * header's historic 104-character measurement of this route). A floor above
 * the measured content is not strictness; it is a permanent red.
 */
type ProductRoute = {
  path: string
  slug: string
  minChars: number
  /**
   * Mobile-axis override of `minChars` (#2817) — set from measurement, only
   * where the 390px layout renders meaningfully less text than desktop.
   */
  minCharsMobile?: number
  /**
   * The committed widths this route is compared at, named as in
   * `evidence-viewports.mjs`. Defaults to `['desktop']`.
   *
   * Replaces the either/or `mobileOnly` flag (#2817): a boolean cannot ADD a
   * mobile baseline to a route that already ships desktop — flipping it would
   * silently DROP the desktop PNG. The loop below emits one test per listed
   * axis and the snapshot stays `${slug}-${axis}.png`, so no existing PNG
   * moves. `/dashboard` and `/transactions` carry both axes; `/accounts`
   * ships mobile-only (see the header for both decisions).
   */
  viewports?: ReadonlyArray<'desktop' | 'mobile'>
  /** The route's own H1 — present only once the client component has data. */
  anchor: (page: Page) => Locator
  /**
   * The literal the frozen clock must produce somewhere in the content, when
   * the fixture carries a relative timestamp. Routes whose visible stamps are
   * static strings omit it.
   */
  frozenRelativeTime?: string
  /**
   * Set when the mobile layout hides every element that renders the fixture's
   * relative timestamp (#2817, measured): the pin is then asserted on the
   * desktop axis only. `page.clock.setFixedTime` stays global either way — a
   * hidden timestamp cannot drift a pixel, and a freeze failure would have
   * nothing visible to fail on at that width.
   */
  frozenRelativeTimeHiddenOnMobile?: boolean
  /**
   * Register `serveAgentDetailResponses` for this route — the detail-page
   * reads (`passport`, `delegate-balance`, per-agent activity/stats) that the
   * shared fixture falls through on. The agent id is `agent-research`.
   */
  serveDetailResponses?: boolean
}

const ROUTES: ProductRoute[] = [
  {
    path: '/dashboard',
    slug: 'dashboard',
    viewports: ['desktop', 'mobile'],
    minChars: 600,
    /** The route's own H1 — present only once the client component has data. */
    anchor: (page: Page) => page.getByRole('heading', { name: 'Dashboard', exact: true }),
    /**
     * The Recent transactions list renders `dashboardTransaction` — the SAME
     * fixture row `/transactions` shows (`haven-api.ts:182`,
     * `dashboardOverview.transactions`), through `timeAgo(tx.timestamp * 1000)`
     * in `DashboardClient.tsx`. So this route needs the literal exactly as much
     * as `/transactions` does.
     *
     * Recorded because the first draft of this file asserted the opposite —
     * "the recent-transactions list is empty, so there is no literal to pin" —
     * off a truncated read of the rendered text, and `haven-reviewer` caught it
     * against the fixture. The freeze was applied either way, so the baseline
     * was already deterministic; what was missing was the DETECTION, which is
     * the whole point of pinning a literal rather than trusting the freeze.
     * Re-measured before fixing: `/dashboard` renders exactly one match for
     * `/\d+(m|h|d|mo|y) ago/`, and it is `3mo ago`.
     */
    frozenRelativeTime: '3mo ago',
  },
  {
    path: '/transactions',
    slug: 'transactions',
    viewports: ['desktop', 'mobile'],
    minChars: 250,
    /** Measured at 390: the responsive layout renders 246 characters. */
    minCharsMobile: 200,
    anchor: (page: Page) => page.getByRole('heading', { name: 'Transaction history' }),
    /**
     * `dashboardTransaction.timestamp` is 1779000000 (2026-05-17T06:40Z), which
     * is 3 months and change before `FROZEN_NOW` — `timeAgo`'s `${months}mo ago`
     * bucket. Pinned as a literal so a clock that stops being frozen fails HERE,
     * by name, rather than as a pixel diff on a date nobody can attribute.
     */
    frozenRelativeTime: '3mo ago',
    /**
     * #2817, measured: below the table's 718px container stage the date
     * column is collapsed and NO riding element carries the timestamp (the
     * mobile page renders no `ago` string at all — read off this spec's own
     * failure snapshot), so the pin is asserted on the desktop axis only.
     */
    frozenRelativeTimeHiddenOnMobile: true,
  },

  /**
   * #2733: whole-page MOBILE baselines for the agents list and the agent
   * detail page — the screen the demo lingers on and the composition this
   * issue tunes. See the header for why these two ship mobile-only.
   *
   * `/agents` needs no `frozenRelativeTime` by measurement: the e2e fixture
   * agent carries no `mcp_last_seen_at`, so `formatAgentLastActivity` renders
   * the STATIC string "No activity yet" — there is no relative timestamp to
   * pin, and the freeze stays on as cheap insurance for anything else on the
   * shell that might read the clock.
   *
   * `/agents/agent-research` renders its pins inside the fixture-seeded
   * content: `Created` is `timeAgo` off the agent's fixed `created_at`
   * (4mo at `FROZEN_NOW`, from the 2026-05-02 fixture timestamp) and
   * `Last activity` is the passport/activity rows' own static content —
   * `4mo ago` is the frozen-clock literal this route's determinism hangs on.
   */
  {
    path: '/agents',
    slug: 'agents-list',
    minChars: 200,
    viewports: ['mobile'],
    anchor: (page: Page) => page.getByRole('heading', { name: 'Agents', exact: true }),
  },
  {
    path: '/agents/agent-research',
    slug: 'agent-detail-research',
    minChars: 700,
    viewports: ['mobile'],
    anchor: (page: Page) => page.getByRole('heading', { name: 'Research agent', exact: true }),
    frozenRelativeTime: '4mo ago',
    /** Serves the four detail-page reads the shared fixture falls through on. */
    serveDetailResponses: true,
  },

  /**
   * #2817: whole-page MOBILE baseline for the accounts hub — the fourth tab
   * destination and, until now, a route the gate compared nothing on at any
   * width. MOBILE-only by decision: the demo lives at 390 (#2736), and
   * desktop adds a second re-bless tax without a defect pointing at that
   * composition (the #2733 reasoning above). The #2225 objection is inert in
   * this one-account harness and the route makes no chain call — see the
   * header paragraph this row superseded.
   *
   * `frozenRelativeTime` is pinned for the same reason as `/transactions`:
   * the card caption renders `Added {timeAgo(safe.created_at)}` off the
   * fixture's fixed `2026-05-01` timestamp, which buckets to `4mo ago` at
   * `FROZEN_NOW` — assert the literal the frozen clock must produce, not a
   * pixel that drifts on a calendar boundary.
   */
  {
    path: '/accounts',
    slug: 'accounts',
    viewports: ['mobile'],
    /** Measured at 390 on this harness: 104 characters. */
    minChars: 100,
    anchor: (page: Page) => page.getByRole('heading', { name: 'Accounts', exact: true }),
    frozenRelativeTime: 'Added 4mo ago',
  },
]

/**
 * The capture would bake a mid-load frame into the baseline and then match it
 * forever. Borrowed verbatim in intent from
 * `wallet-button-collapsed-states.visual.spec.ts`.
 */
async function expectNoSkeletons(region: Locator, label: string) {
  await expect(
    region.locator('.animate-pulse'),
    `${label}: still rendering skeleton placeholders — the capture would bake in ` +
      `a mid-load frame and then match it forever`,
  ).toHaveCount(0)
}

test.describe('product-route visual regression', () => {
  test.skip(
    !VISUAL_SPECS_ENABLED,
    VISUAL_SKIP_REASON,
  )

  for (const route of ROUTES) {
    for (const axis of route.viewports ?? ['desktop']) {
      test(`${route.path} renders pixel-stable (${axis})`, async ({ page }) => {
        const vp = axis === 'mobile' ? MOBILE : DESKTOP
        if (!vp) {
          throw new Error(
            `visual gate: evidence-viewports.mjs carries no viewport named ` +
              `"${axis}", so ${route.path} cannot be captured at a committed width`,
          )
        }

        // BEFORE `goto`: the page reads `Date.now()` during its first render.
        await page.clock.setFixedTime(FROZEN_NOW)
        await mockHavenApi(page)
        if (route.serveDetailResponses) {
          await serveAgentDetailResponses(page, 'agent-research')
        }
        await seedAuthenticatedSession(page)

        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto(route.path)

        const main = page.locator('#main-content')
        await expect(main).toHaveCount(1)
        // A generous timeout, for a measured reason. Playwright's 15 s default is
        // fine against CI's prebuilt standalone server, and NOT fine against a
        // local `next dev` that must compile the route first — reproduced while
        // mutation-proving this file, where recolouring one label made the very
        // next run fail with `element(s) not found` on this heading rather than
        // on the pixel comparison it was testing. That is the #1943 failure class
        // (a render problem masquerading as a selector problem), and a too-short
        // wait here converts every real pixel finding into it.
        await expect(route.anchor(page)).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })
        // The shell can be mounted while the route's data is still arriving, and
        // a capture taken then is a baseline of a half-empty screen. Poll the
        // rendered text past the route's own measured floor before believing it.
        await expect
          .poll(async () => (await main.innerText()).length, {
            message:
              `${route.path}: rendered less text than the route's measured floor — ` +
              `the page never finished rendering (cold compile, failed hydration, ` +
              `or an error boundary), NOT a fixture problem`,
          })
          .toBeGreaterThanOrEqual(
            axis === 'mobile' && route.minCharsMobile !== undefined
              ? route.minCharsMobile
              : route.minChars,
          )
        await expectNoSkeletons(main, route.path)

        if (
          route.frozenRelativeTime &&
          !(axis === 'mobile' && route.frozenRelativeTimeHiddenOnMobile)
        ) {
          await expect(
            main.getByText(route.frozenRelativeTime, { exact: true }).first(),
            `${route.path}: the frozen clock is not in effect — expected the ` +
              `fixture's relative timestamp to render as "${route.frozenRelativeTime}" ` +
              `at ${FROZEN_NOW.toISOString()}. Without it this baseline drifts on a ` +
              `calendar boundary rather than on a code change (#2318).`,
          ).toBeVisible()
        }

        // Determinism: fonts loaded, no animation mid-flight.
        //
        // `animations: 'disabled'` below settles CSS animations and transitions.
        // It does NOT touch a JS `requestAnimationFrame` loop driving React
        // state, and `/dashboard` has one: `useCountUp` animates the Total
        // balance figure over 600 ms on mount. What actually settles that is
        // `toHaveScreenshot`'s own stabilisation — it re-captures until two
        // consecutive raw frames match — so this is a real dependency on an
        // implicit mechanism rather than on anything asserted here. Named
        // because every other determinism knob in this file is explicit, and an
        // unstated one is the one that surprises someone (`haven-reviewer`, this
        // PR). If a count-up ever outlives `expect`'s timeout, this is the line
        // to reach for: drive it to its end state, do not widen the budget.
        await page.evaluate(() => document.fonts.ready)
        await page.waitForLoadState('networkidle')

        // The app shell clips at h-screen/overflow-hidden, so a `fullPage`
        // capture paints only the first viewport and leaves a very long white
        // tail (#1738). Un-clip, then PROVE the capture is not blank before
        // letting it stand as a baseline — a pixel gate whose baseline is empty
        // compares white to white forever.
        await unclipScrollShell(page)
        const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
        await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
          label: `${route.path} · ${axis}`,
          viewportDevicePx: vp.height * devicePixelRatio,
        })

        await expect(page).toHaveScreenshot(`${route.slug}-${axis}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixels: FULL_PAGE_MAX_DIFF_PIXELS,
          threshold: PIXEL_THRESHOLD,
        })
      })
    }
  }
})
