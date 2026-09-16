/**
 * Visual regression for `/analytics` (#3038, epic #2944 closeout).
 *
 * The route shipped in slice C (#2947, PR #3014) and slice E (#2949, PR #3036)
 * without a Playwright visual spec, so the *Design visual regression* job never
 * rendered it: a regression in `MerchantsTable`/`AgentsTable` row geometry, in
 * the `BalanceSection` floor guard, or in the `StatTile` polarity chips under
 * the empty/error branches would reach `dev` invisible to the pixel gate. Both
 * releases recorded that exact gap as a residual ("`/analytics` ships with zero
 * visual baselines (visual job cannot see the page)"). This spec is the
 * printed-output check the vitest suites (`MerchantsTable.test.tsx`,
 * `AnalyticsClient.test.tsx`) cannot be: they pin structure and behaviour
 * headlessly, this one pins what the page actually paints.
 *
 * ── The capture matrix ───────────────────────────────────────────────────────
 *
 * Three scenarios × two viewports × two colour schemes = twelve baselines, all
 * named `<scenario>-<viewport>[-dark].png` under
 * `e2e/__screenshots__/analytics.visual.spec.ts/`.
 *
 *   - The scenarios ride the harness's OWN declared shapes — the populated and
 *     empty overviews and the 503 behind `analytics-populated` / `analytics-empty`
 *     / `analytics-error` (#2949). They are read off the e2e fixture layer
 *     (`fixtures/analytics-overview.ts`), whose values are generated from
 *     `scripts/screenshot.mjs`'s exported keys and pinned to them by
 *     `fixture-shape-parity.test.ts`; the harness itself is a CLI that
 *     Playwright's loader cannot collect (see that file for the measurement).
 *     So no parallel fixture set is introduced either: one declared shape, read
 *     by three surfaces.
 *   - The viewports are the single committed pair from
 *     `scripts/evidence-viewports.mjs` (1280×800 and 390×844), so the pixel
 *     gate and the #896 evidence captures render the same two widths.
 *   - The schemes are the two projects: `chromium-desktop` renders light,
 *     `chromium-desktop-dark` renders dark (#2929). Which one a capture belongs
 *     to is read from `testInfo.project.name`, never from a duplicated describe
 *     block — the #1863 failure shape is a spec that exists but nothing runs.
 *
 * ── Why whole-page, where the siblings are element-scoped ────────────────────
 *
 * `product-routes.visual.spec.ts` captures whole pages (`/dashboard`,
 * `/transactions`); `settings-accounting.visual.spec.ts` clips one card. This
 * page is the former's shape — the thing at risk is the composition of the
 * whole report (four tiles, two tables, one chart, in that order), not a card
 * isolated from its neighbours — so it is captured with `fullPage: true`,
 * un-clipped (#1738) and proven non-blank before it is allowed to stand as a
 * baseline (#1936/#1943).
 *
 * ── The structural half (#2827) ───────────────────────────────────────────────
 *
 * Every `toHaveCount` below is a locator proof that runs under
 * `VISUAL_STRUCTURE_ONLY=1` on any platform, where the pixels are not
 * compared. They close the two failure classes a screenshot cannot: a locator
 * that matches nothing, and one that matches several. This matters most on
 * this page because BOTH tables render twice — a `hidden lg:block` desktop
 * `<Table>` and a `lg:hidden` mobile row pair, one data set in two layouts —
 * so a page-wide text query resolves to two elements by DOM order and would
 * happily assert against the invisible half. Where that ambiguity exists it is
 * resolved by scoping to the owning `[data-testid]` section and/or filtering on
 * visibility, never by a bare `.first()`. The harness met the same trap on this
 * page and recorded why (#1999); these assertions are the version of that
 * lesson that runs in CI.
 *
 * ── Determinism ────────────────────────────────────────────────────────────────
 *
 *   - The clock is frozen before `goto`, the way `product-routes` does it
 *     (#2318). The Agents table's "Last payment" column is `lastPaymentCaption`
 *     → `timeAgo`, which reads `Date.now()`; the fixture's absolute
 *     `last_payment_at` values would otherwise re-bucket on a calendar
 *     boundary and change the baseline with the wall clock. The frozen instant
 *     is chosen one day and some hours past the fixture window's `to`, which
 *     puts the two agents' rows in two DIFFERENT `timeAgo` buckets ("1d ago",
 *     "22h ago") — a frozen clock that freezes both rows onto the same string
 *     would pin the calendar and prove nothing about the column.
 *   - Everything else the page paints is absolute already, by the fixture's
 *     own contract (`ANALYTICS_RANGE` is a fixed window ending 2026-07-11, and
 *     every date on the response is an absolute ISO string), so no other cell
 *     moves with the date of the run.
 *   - Fonts settled, network idle, no skeleton left on screen: the three
 *     waits the whole-page captures in this suite perform before shooting.
 *
 * ── Budgets ────────────────────────────────────────────────────────────────────
 *
 * `threshold` 0.02 and the whole-page family's 150 differing pixels, both
 * taken from `product-routes.visual.spec.ts`, which is the same capture
 * family at the same two widths. The playbook's rule is that a budget of a new
 * size is re-derived, not copied (#1760/#1805, frontend playbook §4), and the
 * derivation is a mutation measured on Linux against Linux-rendered baselines
 * — which is exactly the reviewer's acceptance step for this issue: inverting
 * the `BalanceSection` floor guard must redden this spec in CI. If that
 * mutation measures over budget, the number belongs beside this line, not
 * beside the two borrowed from `/dashboard` and `/transactions`.
 *
 * ── Baselines ──────────────────────────────────────────────────────────────────
 *
 * Linux-rendered only, and never by hand: they are generated by the *Update
 * visual baselines* dispatch (`mode=changed`) on the Linux runner, per #2218.
 * Regenerating them locally is not a shortcut, it is a defect — macOS font
 * rendering differs, which is why the pixel comparison is skipped unless
 * `VISUAL_REGRESSION=1` and why `VISUAL_STRUCTURE_ONLY=1` exists at all
 * (#2827). See `docs/contributing/ship-playbooks/frontend.md` §4.
 */
import { expect, test, type Page } from '@playwright/test'
import { VISUAL_SKIP_REASON, VISUAL_SPECS_ENABLED } from './support/visual-mode'
import { dismissMobileSidebar, mockHavenApi, seedAuthenticatedSession } from './fixtures/haven-api'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the SINGLE source of evidence viewports, shared
// with the #896 captures, the /design-system gate (#897) and product-routes.
import { VIEWPORTS as SHARED_VIEWPORTS } from '../scripts/evidence-viewports.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs; the #1738 un-clip and the #1936 non-blank proof,
// the same two the whole-page product-route captures use, so both capture
// paths un-clip the shell the same way and are held to the same guard.
import { assertCaptureNotBlank, unclipScrollShell } from '../scripts/full-page-capture.mjs'
// The three scenario bodies come from the e2e fixture layer, not from the
// capture harness's own keys, even though those are the single declared shape.
// `screenshot.mjs` is a CLI that reads `import.meta.url` at module scope, and
// Playwright's own transform cannot load such an `.mjs` — the collected spec
// dies before its first test (`ReferenceError: exports is not defined in ES
// module scope`). `settings-accounting.visual.spec.ts` solves the identical
// problem by taking its bodies from `./fixtures/*` and letting
// `fixture-shape-parity.test.ts` pin them to the harness; this spec keeps the
// same discipline, so the two capture surfaces still read one declared shape.
// See `fixtures/analytics-overview.ts` for the measured diagnosis.
import {
  analyticsOverview,
  analyticsOverviewEmpty,
  analyticsOverviewFailure,
} from './fixtures/analytics-overview'
// The theme seed key is the APP'S OWN constant (#2929), the same contract
// `seedAuthenticatedSession` holds with `auth-storage.ts`: a storage-key
// rename has to fail this gate, not silently compare light renders against
// baselines that claim to be dark.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .ts constant with no default export shape to widen.
import { THEME_STORAGE_KEY } from '../src/lib/theme-bootstrap'

const VIEWPORTS = SHARED_VIEWPORTS as ReadonlyArray<{
  name: string
  width: number
  height: number
}>

const FULL_PAGE_MAX_DIFF_PIXELS = 150

/**
 * Playwright's default `threshold` of 0.2 hides a one-token recolour entirely
 * (measured in #1805: a `--v2-ink-3` → `--v2-ink-2` change counts ZERO
 * differing pixels at 0.2). The suite compares at 0.02 for that reason, and
 * this spec does not get to be the loose one.
 */
const PIXEL_THRESHOLD = 0.02

/**
 * The frozen instant. One day and nine hours past the fixture window's `to`
 * (2026-07-11T00:00:00Z), which puts the two agents' `last_payment_at` rows
 * into different `timeAgo` buckets — see the Determinism note in the header.
 */
const FROZEN_NOW = new Date('2026-07-12T09:00:00.000Z')

/**
 * The generous anchor timeout, for the measured reason recorded in
 * `product-routes.visual.spec.ts`: Playwright's 15 s default is fine against
 * CI's prebuilt standalone server and NOT fine against a locally compiled
 * route, and a too-short wait turns every real pixel finding into the #1943
 * failure class (a render problem masquerading as a selector problem).
 */
const ANCHOR_TIMEOUT_MS = 60_000

/**
 * The floor for the populated page's rendered-text poll, above
 * `full-page-capture.mjs`'s `MIN_RENDERED_CHARS` of 40 and below the lengths
 * measured on this harness in the #3038 structure run. Its ONLY role is the
 * one the poll in `product-routes` has: catch a page that never rendered at
 * all — a cold compile, a failed hydration, an error boundary — where the
 * fixtures and the copy assertions below are the stronger pins. It is
 * deliberately not set for the empty and error scenarios: for those two, a
 * short page IS the subject, and their own copy assertions are unambiguous.
 */
const POPULATED_MIN_TEXT_CHARS = 60

/** The five copy: the strings the page owns, quoted exactly as it renders them. */
const COPY = {
  heading: 'Analytics',
  rangeCaption: 'Last 30 days',
  rangeControl: 'Analytics date range',
  spentBasis: 'based on 5 payments',
  unsettled: '1 awaiting settlement evidence is not counted',
  refusedCount: '2 refused payments',
  refusedAttempts: 'across 3 attempts',
  refusedAmount: '$3.00 attempted',
  /**
   * The #3013 ledger-floor clause (`RefusalsRecordedFromFootnote`) inside the
   * Refused tile's footnote: the fixture's `basis.refusals_recorded_from`
   * ('2026-05-28', the harness's own key at `screenshot.mjs:1433`) rendered by
   * the client's `formatFloorDate` — en-GB day numeric + short month gives
   * '28 May'. The date on screen is the response's, so the locator pins the
   * response's value, not an invented one.
   */
  refusalsRecordedFrom: 'Refusals are recorded from 28 May',
  budgetBands: '1 of 2 agents above 75% of their period budget',
  feesOff: 'Haven is not charging fees.',
  gasSponsored: 'Haven sponsored 7 operations',
  agentResearch: 'Research agent',
  agentRetired: 'Data-feed agent',
  merchantsHeading: 'Top merchants',
  balanceHeading: 'Balance over time',
  nordshield: 'NordShield VPN',
  emptyTitle: 'No agent activity in this range',
  emptyBody: 'This window has no payments, refusals or fees to report.',
  errorTitle: 'We could not load your analytics',
  errorBody: 'Nothing here moved or changed.',
  retry: 'Try again',
  frozenLastPaymentRecent: '1d ago',
  frozenLastPaymentOlder: '2d ago',
  /**
   * The tiles' own delta caption (`TileGrid`'s `windowCaption`): the window
   * COMPARISON, not the window label. It rides the two tiles that carry a
   * delta — Spent and Refused; Budget used shows a band count and Fees shows
   * no delta while the fee flag is off.
   */
  tilesDeltaCaption: 'vs previous 30 days',
  /**
   * The two agents' budget figures, word for word what `formatBudgetTokenValue`
   * prints for the fixture delegations (`formatAllowanceForToken` at USDC's
   * 6 decimals, minimumFractionDigits 2): '214.00 of 250.00 USDC' and
   * '5.00 of 500.00 USDC'. Rendered TWICE per agent — above the desktop
   * cell's bar, and inside the mobile row's `budgetLine` — so 2 at either
   * width, exactly one of them on screen (#3038 structure run: the first
   * draft omitted the '.00' and resolved 0; the house vitest pin is
   * AgentsTable.test.tsx's `214\.00 of 250\.00 USDC`).
   */
  budgetOf250: '214.00 of 250.00 USDC',
  budgetOf500: '5.00 of 500.00 USDC',
} as const

const OVERVIEW_PATH = '/analytics/overview'

/** The 503 the `analytics-error` capture scenario serves — the harness's own answer. */
const OVERVIEW_FAILURE = analyticsOverviewFailure

type OverviewBody = typeof analyticsOverview | typeof analyticsOverviewEmpty

type Scenario = {
  name: 'populated' | 'empty' | 'error'
  /** What `GET /analytics/overview` answers with. `null` = the 503. */
  body: OverviewBody | null
  /**
   * The state the capture is of, pinned before the shutter: one assertion per
   * distinguishing feature, so a locator that drifts is a red test rather than
   * a baseline of the wrong thing.
   */
  assert: (page: Page, vp: { name: string; width: number }) => Promise<void>
}

/**
 * The section a page-level locator belongs to, located by its `data-testid`
 * rather than by a class string — the class string is the thing under test,
 * not something to locate by (the #1820 reasoning, applied to the tables).
 */
function section(page: Page, testId: string) {
  const locator = page.getByTestId(testId)
  return locator
}

/**
 * The visible half of a pair. Both tables render a desktop `<Table>` inside a
 * `hidden lg:block` wrapper and a mobile row pair inside a `lg:hidden` one, so
 * at either width exactly one of the two is on screen. Asserting the visible
 * count to 1 pins the collapse as well as the row; asserting the raw count to 2
 * pins that the pair is still a pair, which is what catches a change that makes
 * the page render NEITHER (count 0) or BOTH (count 4, a lost `lg:hidden`).
 */
async function expectExactlyOneVisible(row: ReturnType<Page['getByTestId']>, text: string) {
  await expect(row.getByText(text, { exact: true }).filter({ visible: true })).toHaveCount(1)
}

const SCENARIOS: Scenario[] = [
  {
    name: 'populated',
    body: analyticsOverview,
    async assert(page, vp) {
      // ── The four tiles, and the basis each one quotes ─────────────────────
      const tiles = section(page, 'analytics-tiles')
      await expect(tiles).toHaveCount(1)
      for (const testId of [
        'stat-tile-spent',
        'stat-tile-refused',
        'stat-tile-budget-used',
        'stat-tile-fees-paid-to-haven',
      ]) {
        await expect(page.getByTestId(testId)).toHaveCount(1)
      }
      // The most load-bearing line on the page is the basis, not the figure:
      // the count the total was computed over, and what was left out of it.
      await expect(section(page, 'stat-tile-spent').getByText(COPY.spentBasis)).toHaveCount(1)
      await expect(
        section(page, 'stat-tile-spent').getByText(COPY.unsettled),
        'the one submitted payment awaiting settlement evidence must be named on the ' +
          'face of the tile: a silently smaller total is indistinguishable from a ' +
          'total that was always that size',
      ).toHaveCount(1)
      await expect(section(page, 'stat-tile-refused').getByText(COPY.refusedCount)).toHaveCount(1)
      await expect(section(page, 'stat-tile-refused').getByText(COPY.refusedAttempts)).toHaveCount(1)
      await expect(section(page, 'stat-tile-refused').getByText(COPY.refusedAmount)).toHaveCount(1)
      // The #3013 ledger-floor clause rides the Refused tile's footnote when
      // the response reports a floor (the fixture's basis carries '2026-05-28'):
      // a floor the endpoint reports but the page drops is a silently larger
      // refusals total, the same defect class the basis lines above pin.
      await expect(
        section(page, 'stat-tile-refused').getByText(COPY.refusalsRecordedFrom),
        'the ledger floor the response reports must be named on the face of the tile',
      ).toHaveCount(1)
      await expect(section(page, 'stat-tile-budget-used').getByText(COPY.budgetBands)).toHaveCount(1)
      await expect(section(page, 'stat-tile-fees-paid-to-haven').getByText(COPY.feesOff)).toHaveCount(1)
      await expect(
        section(page, 'stat-tile-fees-paid-to-haven').getByText(COPY.gasSponsored),
      ).toHaveCount(1)
      // The tiles' delta captions: `vs previous 30 days` on the two tiles that
      // carry a delta (Spent, Refused). The window LABEL itself ('Last 30
      // days', `rangeCaption(30)`) is NOT a tile string — it renders in the
      // page header beside the range control, and is asserted below on
      // `analytics-page`, not here (#3038 structure run: scoping it to the
      // tiles grid resolves 0 and every populated capture times out on it).
      await expect(tiles.getByText(COPY.tilesDeltaCaption)).toHaveCount(2)

      // ── The range control, in its resting state ───────────────────────────
      // The default window is 30d (`DEFAULT_ANALYTICS_RANGE`) and the fixture's
      // range is a 30-day window, so the control and the caption agree without
      // any interaction — and neither is clicked here, because a click would
      // leave the page mid-request and the capture would be of a transition.
      const control = page.getByRole('radiogroup', { name: COPY.rangeControl })
      await expect(control).toHaveCount(1)
      await expect(control.getByRole('radio', { name: '30 days' })).toBeChecked()
      // The window label the header carries (`rangeCaption(days)` in the
      // PageHeader's actions, beside the control it names). Page-level because
      // that is where it renders — the tiles carry the COMPARISON caption
      // instead, asserted above.
      await expect(
        page.getByTestId('analytics-page').getByText(COPY.rangeCaption, { exact: true }),
      ).toHaveCount(1)

      // ── The agents table ───────────────────────────────────────────────────
      const agents = section(page, 'analytics-agents-section')
      await expect(agents).toHaveCount(1)
      await expect(agents.getByText(COPY.agentResearch)).toHaveCount(2)
      await expect(agents.getByText(COPY.agentRetired)).toHaveCount(2)
      await expectExactlyOneVisible(agents, COPY.agentResearch)
      await expectExactlyOneVisible(agents, COPY.agentRetired)
      // Each delegation's budget renders by a different medium per half: the
      // desktop table measures it with a `role=progressbar` per delegation,
      // the mobile rows print the same figures as text (`formatBudgetTokenValue`
      // + the used percent, joined by `budgetLine`). Asserted by medium — and
      // the role is an accessibility-tree role, so at mobile, where the desktop
      // half is `display:none`, the bars resolve 0 BY DESIGN and the text line
      // is the budget's only rendering (#3038 structure run: a viewport-blind
      // bar count reads 2 on desktop and 0 on mobile for the same page).
      await expect(agents.getByText(COPY.budgetOf250)).toHaveCount(2)
      await expect(agents.getByText(COPY.budgetOf500)).toHaveCount(2)
      await expect(agents.getByText(COPY.budgetOf250).filter({ visible: true })).toHaveCount(1)
      await expect(agents.getByText(COPY.budgetOf500).filter({ visible: true })).toHaveCount(1)
      if (vp.width >= 1024) {
        // One bar per delegation, two delegations, both read from the response.
        await expect(agents.getByRole('progressbar')).toHaveCount(2)
      } else {
        await expect(agents.getByRole('progressbar')).toHaveCount(0)
      }

      // ── The merchants table ────────────────────────────────────────────────
      const merchants = section(page, 'analytics-merchants-section')
      await expect(merchants).toHaveCount(1)
      await expect(
        merchants.getByRole('heading', { name: COPY.merchantsHeading, exact: true }),
      ).toHaveCount(1)
      // Scoped to its own section, `NordShield VPN` is unambiguous here. The
      // capture harness needs a visibility filter for the same string because
      // the agents table's `revealAt="xl"` "Top merchant" cell carries it too
      // (#1999); scoping is the cheaper half of that lesson, and the filter is
      // kept anyway as the proof that the visible rendering is the one shown.
      await expect(merchants.getByText(COPY.nordshield, { exact: true })).toHaveCount(2)
      await expectExactlyOneVisible(merchants, COPY.nordshield)

      // ── The balance chart, and the floor under it ─────────────────────────
      // `BalanceSection` returns `null` below `MIN_CHARTABLE_DAYS`, so this
      // assertion is the one the reviewer's mutation flips: with the floor
      // guard inverted, the section is gone and the capture is red rather than
      // quietly a page without a chart.
      const balance = section(page, 'analytics-balance-section')
      await expect(balance).toHaveCount(1)
      await expect(
        balance.getByRole('heading', { name: COPY.balanceHeading, exact: true }),
      ).toHaveCount(1)
      await expect(balance.getByTestId('area-chart')).toHaveCount(2)
      await expect(balance.getByTestId('area-chart').filter({ visible: true })).toHaveCount(1)

      // ── The frozen clock, where it is on screen ───────────────────────────
      // Desktop only: on mobile the "Last payment" value lives in the row's
      // collapsed disclosure, which is closed, so the strings are not in the
      // tree at all. Asserting them there would be an assertion about nothing.
      if (vp.width >= 1024) {
        await expect(agents.getByText(COPY.frozenLastPaymentRecent, { exact: true })).toHaveCount(1)
        await expect(agents.getByText(COPY.frozenLastPaymentOlder, { exact: true })).toHaveCount(1)
      }

      // ── The states this page is NOT in ────────────────────────────────────
      // The sparse branch and the two other states are mutually exclusive with
      // this one by what they report about the request, so their absence is a
      // fact about the render, not a hope.
      await expect(page.getByTestId('analytics-sparse-line')).toHaveCount(0)
      await expect(page.getByText(COPY.emptyTitle)).toHaveCount(0)
      await expect(page.getByTestId('analytics-page').getByRole('alert')).toHaveCount(0)
    },
  },
  {
    name: 'empty',
    body: analyticsOverviewEmpty,
    async assert(page) {
      // The endpoint ANSWERED and found nothing, which is a different page from
      // the one that did not answer: the empty state names what was looked for,
      // and failure copy must be absent, asserted loudly — an outage must never
      // be allowed to photograph itself as an empty state.
      await expect(
        page.getByRole('heading', { name: COPY.emptyTitle, exact: true }),
      ).toHaveCount(1)
      await expect(page.getByText(COPY.emptyBody)).toHaveCount(1)
      // Scoped to the page container, not the document: the app shell and the
      // route announcer carry alert/surface roles of their own (the structure
      // run measured 2 page-external alerts on every scenario), and the thing
      // this assertion governs is the report's own failure region.
      await expect(page.getByTestId('analytics-page').getByRole('alert')).toHaveCount(0)
      await expect(page.getByText(COPY.errorTitle)).toHaveCount(0)
      await expect(page.getByRole('button', { name: COPY.retry, exact: true })).toHaveCount(0)

      // One empty state, not four tiles each asserting "nothing" in the
      // confident layout of a working page — the screen-shape an outage passes
      // for free, which is why the tiles are asserted absent rather than zero.
      await expect(page.getByTestId('analytics-tiles')).toHaveCount(0)
      for (const testId of [
        'stat-tile-spent',
        'stat-tile-refused',
        'stat-tile-budget-used',
        'stat-tile-fees-paid-to-haven',
      ]) {
        await expect(page.getByTestId(testId)).toHaveCount(0)
      }
      await expect(page.getByTestId('analytics-agents-section')).toHaveCount(0)
      await expect(page.getByTestId('analytics-merchants-section')).toHaveCount(0)
      await expect(page.getByTestId('analytics-balance-section')).toHaveCount(0)
      await expect(page.getByTestId('area-chart')).toHaveCount(0)
      await expect(page.getByTestId('analytics-sparse-line')).toHaveCount(0)

      // The empty response's floor is `null` (#3013), so the ledger-floor
      // clause has no date to name — absence asserted, because a floor
      // invented here would report a coverage the ledger does not hold.
      await expect(page.getByText(COPY.refusalsRecordedFrom)).toHaveCount(0)

      // The header is rendered from the response the page did get, so the
      // window the report covers is still named, and the control is still on
      // the page to change it: an empty report is not an unavailable one.
      await expect(page.getByText(COPY.rangeCaption)).toHaveCount(1)
      await expect(page.getByRole('radiogroup', { name: COPY.rangeControl })).toHaveCount(1)
    },
  },
  {
    name: 'error',
    body: null,
    async assert(page) {
      // `role="alert"` is the primitive's own contract; the title is the page's
      // copy; the one remedy the page has evidence for is the button. Scoped
      // to the page container for the same reason the empty scenario's
      // absence assertion is: the shell contributes alerts of its own (the
      // structure run measured 3 document-wide where the page owns 1).
      await expect(page.getByTestId('analytics-page').getByRole('alert')).toHaveCount(1)
      await expect(
        page.getByRole('heading', { name: COPY.errorTitle, exact: true }),
      ).toHaveCount(1)
      await expect(page.getByText(COPY.errorBody)).toHaveCount(1)
      await expect(
        page.getByRole('button', { name: COPY.retry, exact: true }),
      ).toHaveCount(1)

      // A page of honest zeros is exactly what a failure is mistaken for, so
      // the figures must not be on screen while the request has failed.
      await expect(page.getByTestId('analytics-tiles')).toHaveCount(0)
      await expect(page.getByTestId('analytics-agents-section')).toHaveCount(0)
      await expect(page.getByTestId('analytics-merchants-section')).toHaveCount(0)
      await expect(page.getByTestId('analytics-balance-section')).toHaveCount(0)
      await expect(page.getByTestId('area-chart')).toHaveCount(0)
      await expect(page.getByTestId('analytics-sparse-line')).toHaveCount(0)
      await expect(page.getByText(COPY.emptyTitle)).toHaveCount(0)

      // The error scenario serves no overview at all — no basis, no floor — so
      // the ledger-floor clause has nothing to be printed from, and its absence
      // is part of the "a failure is not a report" contract the tile absences
      // above pin.
      await expect(page.getByText(COPY.refusalsRecordedFrom)).toHaveCount(0)

      // The header survives its endpoint: the page still says which window it
      // tried to read and still offers the control, because what failed was the
      // reading, not the page.
      await expect(page.getByText(COPY.rangeCaption)).toHaveCount(1)
      await expect(page.getByRole('radiogroup', { name: COPY.rangeControl })).toHaveCount(1)
    },
  },
]

/**
 * Override the one route the scenario is about, after `mockHavenApi`, so
 * Playwright's LIFO route matching reaches this handler first; every other
 * request defers to the shared fixture with `route.fallback()`, the same
 * idiom `settings-accounting.visual.spec.ts` and `focus-visible.visual.spec.ts`
 * use. The shared fixture's own `/agents` and `/auth/*` handlers stay in
 * force, which is what keeps the shell (TopBar, sidebar, user menu) rendering
 * its committed content instead of erroring into a half-painted capture.
 *
 * The route glob is the fixture's api-prefix pattern (`**` + the api path +
 * `**`), and the match is on the path WITH THE /api PREFIX REMOVED, byte for
 * byte the shape every overlay in `fixtures/haven-api.ts` keeps
 * (`serveAccountingFeedStatus`, `serveAgentDetailResponses`). Two
 * independently fatal traps decide it, and each half of the idiom answers one:
 *   - `useAnalyticsOverview` builds the overview path with a range/currency
 *     query and `api.ts` prepends its api base, so the request that actually
 *     leaves the browser carries the api prefix. A glob anchored on the bare
 *     overview path matches NOTHING, all three scenarios fall through to the
 *     shared fixture, and the populated and empty captures silently photograph
 *     the error page (#3038 structure run, caught before a baseline existed).
 *   - Matching on the raw pathname instead of the stripped one is the second
 *     half of the same bug: the prefix is what distinguishes an app-API read
 *     from a same-named Next route or a static asset, so the house strips it
 *     before comparing and keeps the `GET` test.
 */
async function serveOverview(page: Page, body: OverviewBody | null) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    if (request.method() !== 'GET' || path !== OVERVIEW_PATH) {
      await route.fallback()
      return
    }
    if (body === null) {
      await route.fulfill({
        status: OVERVIEW_FAILURE.status,
        contentType: 'application/json',
        body: JSON.stringify(OVERVIEW_FAILURE.body),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

/**
 * The capture would bake a mid-load frame into the baseline and then match it
 * forever. Read from the page's own container, the way `product-routes` reads
 * it, so a skeleton outside the region cannot be mistaken for one inside it.
 */
async function expectNoSkeletons(page: Page, label: string) {
  await expect(
    page.locator('.animate-pulse'),
    `${label}: still rendering skeleton placeholders — the capture would bake in ` +
      `a mid-load frame and then match it forever`,
  ).toHaveCount(0)
  await expect(page.getByTestId('analytics-skeleton')).toHaveCount(0)
}

test.describe('analytics visual regression', () => {
  test.skip(!VISUAL_SPECS_ENABLED, VISUAL_SKIP_REASON)

  /**
   * Which palette this capture set renders in (#2929). Keyed on the PROJECT,
   * the same contract `design-system.visual.spec.ts` keeps: the project is
   * where `colorScheme` and the storage seed are decided, and a second copy of
   * the capture body per scheme is the #1863 failure shape.
   */
  const schemeOf = (testInfo: { project: { name: string } }): 'light' | 'dark' =>
    testInfo.project.name === 'chromium-desktop-dark' ? 'dark' : 'light'

  test.beforeEach(async ({ page }, testInfo) => {
    await mockHavenApi(page)
    await seedAuthenticatedSession(page)
    // The DETERMINISTIC half of the dark seed: the app's no-flash bootstrap
    // reads this key before the first paint and stamps `data-theme`, pinning
    // the token block regardless of the OS. The project's `colorScheme: 'dark'`
    // is the second half, so the media-query path and every OS-sensitive native
    // paint agree with the seed instead of fighting it. One payload object, no
    // destructuring of the outer scope — the function is serialised into the page.
    const scheme = schemeOf(testInfo)
    if (scheme === 'dark') {
      await page.addInitScript(
        (themeKey: string) => {
          window.localStorage.setItem(themeKey, 'dark')
        },
        THEME_STORAGE_KEY,
      )
    }
  })

  for (const scenario of SCENARIOS) {
    for (const vp of VIEWPORTS) {
      test(`${scenario.name} renders pixel-stable (${vp.name})`, async ({ page }, testInfo) => {
        const scheme = schemeOf(testInfo)
        // The suffix rides the BASELINE NAME, not the project path: the
        // snapshot template has no `{projectName}` segment, so the two schemes
        // must not be able to resolve to the same PNG (#2929).
        const schemeSuffix = scheme === 'dark' ? '-dark' : ''
        const label = `${scenario.name} · ${vp.name} · ${scheme}`

        // BEFORE `goto`: the page reads `Date.now()` during its first render.
        await page.clock.setFixedTime(FROZEN_NOW)
        await serveOverview(page, scenario.body)

        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto('/analytics')

        // The route, not a redirect. `ProtectedRoute` renders `null` while auth
        // resolves and can send an unseeded session to /onboarding; a capture of
        // that page would be a baseline of the app shell with nothing in it.
        await expect(page.getByTestId('analytics-page')).toHaveCount(1)
        await expect(
          page.getByRole('heading', { name: COPY.heading, exact: true }),
        ).toBeVisible({ timeout: ANCHOR_TIMEOUT_MS })
        await dismissMobileSidebar(page)

        if (scenario.name === 'populated') {
          // The rendered-text floor: a page that produced almost no text has not
          // rendered (cold compile, failed hydration, an error boundary), and
          // the copy assertions below would only catch that by accident.
          const main = page.locator('#main-content')
          await expect(main).toHaveCount(1)
          await expect
            .poll(async () => (await main.innerText()).length, {
              message:
                '/analytics populated: rendered less text than the measured floor — ' +
                'the page never finished rendering (cold compile, failed hydration, ' +
                'or an error boundary), NOT a fixture problem',
            })
            .toBeGreaterThanOrEqual(POPULATED_MIN_TEXT_CHARS)
        }

        await scenario.assert(page, vp)

        // Determinism: fonts loaded, nothing in flight, no animation mid-frame.
        await page.evaluate(() => document.fonts.ready)
        await page.waitForLoadState('networkidle')
        await expectNoSkeletons(page, label)

        // The app shell clips at h-screen/overflow-hidden, so a `fullPage`
        // capture paints one viewport and a very long white tail (#1738).
        // Un-clip, then PROVE the capture is not blank before letting it stand
        // as a baseline: a pixel gate whose baseline is empty compares white to
        // white forever.
        await unclipScrollShell(page)
        const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
        await assertCaptureNotBlank(await page.screenshot({ fullPage: true }), {
          label,
          viewportDevicePx: vp.height * devicePixelRatio,
        })

        await expect(page).toHaveScreenshot(`analytics-${scenario.name}-${vp.name}${schemeSuffix}.png`, {
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
