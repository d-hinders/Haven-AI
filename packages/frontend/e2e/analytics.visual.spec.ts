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
 * whole report (four tiles, the agents table, the spend chart, the merchants table, the balance chart, in that order), not a card
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
 *     puts the two agents' rows in two DIFFERENT `timeAgo` buckets ("2d ago",
 *     "1d ago" — the `COPY.frozenLastPayment*` strings below) — a frozen clock that freezes both rows onto the same string
 *     would pin the calendar and prove nothing about the column.
 *   - Everything else the page paints is absolute already, by the fixture's
 *     own contract (`ANALYTICS_RANGE` is a fixed window ending 2026-07-10T14:30Z, and
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
 * The frozen instant. One day and eighteen-and-a-half hours past the fixture
 * window's `to` (2026-07-10T14:30:00Z; `timeAgo` reads `last_payment_at`, not
 * `range.to`, so the distance only has to keep the two agents' rows in
 * different `timeAgo` buckets — see the Determinism note in the header).
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
  /**
   * #4333 retarget: the header carries the Agent facet before the Period
   * trigger, and the bare window caption beside the picker is gone — the
   * trigger's own value span is the ONE element carrying the window words.
   */
  agentFacetTrigger: 'Agent: All agents',
  periodTrigger: 'Period: Last 30 days',
  rangeControlLegacyName: 'Analytics date range',
  /**
   * #4333: the Spent comparison is the previous window's booked total, as an
   * AMOUNT — the fixture's `totals.spent_previous` ('280.10') under
   * `$324.75`, formatted through the same money voice as the figure. No
   * delta pill and no "based on N payments" basis line any more: the
   * comparison is absolute and the Payments tile owns the count.
   */
  spentComparison: 'vs $280.10 the 30 days before',
  paymentsCaption: 'by 2 of 2 agents',
  /**
   * #4333: the Refused tile's caption is the attempts behind the count
   * ("3 attempts"); the attempted AMOUNT is no longer on the tile, and the
   * Review link exists only under a single-agent filter — this page is
   * unfiltered, so it is asserted absent.
   */
  refusedAttempts: '3 attempts',
  /**
   * #4333: the two recording caveats moved onto the label as an ⓘ hint (a
   * `StatTile` hint + `Tooltip`). The ledger floor is the fixture's
   * `refusals_recorded_from` ('2026-05-28') rendered by the client's
   * `formatFloorDate` — en-GB day + short month gives '28 May' — and the
   * price-cap clause is the same sentence the old footnote line printed.
   * Both are read off the hint trigger's aria-label, which names the content
   * for assistive tech whether or not the tooltip is open.
   */
  refusalsRecordedFrom: 'Refusals are recorded from 28 May',
  refusedUnrecorded: "Price-cap refusals in your agent's runtime are not recorded.",
  nearBudgetCount: '1/2',
  nearBudgetCaption: 'above 75% of a period budget',
  agentResearch: 'Research agent',
  agentRetired: 'Data-feed agent',
  merchantsHeading: 'Top merchants',
  balanceHeading: 'Balance over time',
  spendHeading: 'Spend over time',
  /** The fixture window ends at 14:30Z with `tz: UTC`, so the last bucket (10 Jul) is a partial day: one striped bar and this note (#3051). */
  spendPartialNote: 'The last bar is striped',
  nordshield: 'NordShield VPN',
  emptyTitle: 'No agent activity in this range',
  emptyBody: 'This window has no payments, refusals or fees to report.',
  errorTitle: 'We could not load your analytics',
  errorBody: 'Nothing here moved or changed.',
  retry: 'Try again',
  frozenLastPaymentRecent: '1d ago',
  frozenLastPaymentOlder: '2d ago',
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
  /**
   * The #3806 `refilled-updating` caption, word for word what
   * `UNREAD_CAPTION` (lib/budget-caption.ts) prints: the fixture's read is
   * STALE — its `period_end` (2026-07-11) precedes `FROZEN_NOW`
   * (2026-07-12) — so the used amount belongs to a finished period and the
   * row says so in words instead of measuring it. Rendered once per
   * delegation row.
   */
  unreadBudget: 'Usage this period couldn’t be read',
} as const

/** The four tile test ids of the #4333 grid. The fees tile is absent while
 *  the fixture's fee flag is off (the empty fixture too), asserted per
 *  scenario below. */
const TILE_IDS = [
  'stat-tile-spent',
  'stat-tile-payments',
  'stat-tile-refused',
  'stat-tile-agents-near-their-budget',
] as const

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
      // ── The four tiles, and the basis each one quotes (#4333) ─────────────
      const tiles = section(page, 'analytics-tiles')
      await expect(tiles).toHaveCount(1)
      for (const testId of TILE_IDS) {
        await expect(page.getByTestId(testId)).toHaveCount(1)
      }
      // The fees tile is ABSENT while the fixture's fee flag is off (#4333):
      // a $0.00 there would report "nothing charged this period", which is
      // not the same fact as "the product is not charging fees" — and the
      // absence IS the saying now.
      await expect(page.getByTestId('stat-tile-fees-paid-to-haven')).toHaveCount(0)
      // The Spent comparison is absolute: the previous window's booked total
      // as an amount, never a percentage pill.
      await expect(section(page, 'stat-tile-spent').getByText(COPY.spentComparison)).toHaveCount(1)
      await expect(section(page, 'stat-tile-payments').getByText(COPY.paymentsCaption)).toHaveCount(1)
      await expect(section(page, 'stat-tile-refused').getByText(COPY.refusedAttempts)).toHaveCount(1)
      // Unfiltered page: no Review link — there is no page-level refused
      // list to review (#4333), and no attempted amount on the tile.
      await expect(section(page, 'stat-tile-refused').getByText('Review')).toHaveCount(0)
      await expect(section(page, 'stat-tile-refused').getByText(/\$3\.00 attempted/)).toHaveCount(0)
      // The two recording caveats ride the ⓘ hint on the label (#4333): the
      // ledger floor the response reports and the one class the ledger never
      // sees, named rather than silently absent from the count. Neither
      // renders as visible tile text — they are the hint's aria-label and
      // its tooltip — and no page-level caveat line exists any more.
      const refusedHint = section(page, 'stat-tile-refused').getByTestId('analytics-refused-hint')
      await expect(refusedHint).toHaveCount(1)
      await expect(refusedHint).toHaveAttribute('aria-label', new RegExp(COPY.refusalsRecordedFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      await expect(refusedHint).toHaveAttribute('aria-label', new RegExp(COPY.refusedUnrecorded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      await expect(refusedHint).not.toHaveAttribute('aria-label', /hosted tools|quote/i)
      await expect(page.getByTestId('analytics-refusal-caveats')).toHaveCount(0)
      await expect(
        section(page, 'stat-tile-agents-near-their-budget').getByText(COPY.nearBudgetCount),
      ).toHaveCount(1)
      await expect(
        section(page, 'stat-tile-agents-near-their-budget').getByText(COPY.nearBudgetCaption),
      ).toHaveCount(1)
      // No delta chips render anywhere on the grid (#4333): the comparison is
      // the footnote, and no StatusBadge percent chip rides the figures.
      await expect(tiles.getByText(/vs previous 30 days/)).toHaveCount(0)

      // ── Spend over time (#3051): the chart slice D built, on the page ────
      // One heading, the desktop/narrow chart pair with exactly one visible
      // at this viewport, and a grey refusal dash under the slot for each of
      // the fixture's two refusal days (two per rendering) — the marker is
      // drawn under the slot, not as a cap, and barless days included.
      const spend = section(page, 'analytics-spend-section')
      await expect(spend).toHaveCount(1)
      await expect(spend.getByRole('heading', { name: COPY.spendHeading })).toHaveCount(1)
      await expect(spend.getByTestId('stacked-bar-chart').filter({ visible: true })).toHaveCount(1)
      await expect(spend.getByTestId('chart-refusal-marker')).toHaveCount(4)
      // The partial-day treatment on the capture itself: under the
      // continuous axis (#4334) the section hands the chart every local
      // date the window touches, so BOTH cut edge days render per view —
      // the window's first day (June 10) is an empty partial slot (no
      // by_day row), the last (July 10) has a bar — 2 chart-days × 2
      // renderings = 4. The partial note still names the last end only:
      // it claims stripes for partial days that have a bar, while empty
      // partial slots are named in the tooltip and the table.
      await expect(spend.locator('[data-testid="chart-day"][data-partial="true"]')).toHaveCount(4)
      await expect(spend.getByText(COPY.spendPartialNote, { exact: false })).toHaveCount(1)

      // ── The period control, in its resting state ─────────────────────────
      // #4116: the header's control is the list-controls Period trigger — a
      // CLOSED menu button named "Period: Last 30 days"; the default window is
      // 30d (`DEFAULT_ANALYTICS_RANGE`) and the fixture's range is a 30-day
      // window, so the trigger and the caption agree without any interaction.
      // It is deliberately NOT opened here: an open panel is a mid-interaction
      // frame, and a click would leave the capture of a transition. The
      // SegmentedControl wrapper's radiogroup is asserted gone by name.
      const trigger = page.getByRole('button', { name: COPY.periodTrigger })
      await expect(trigger).toHaveCount(1)
      await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByRole('radiogroup', { name: COPY.rangeControlLegacyName })).toHaveCount(0)
      // #4333: the header carries the Agent facet BEFORE the Period trigger,
      // and the bare window caption is gone — 'Last 30 days' now appears in
      // exactly ONE element, the trigger's own value span. A second copy
      // would be the retired caption back on the page.
      const facet = page.getByRole('button', { name: COPY.agentFacetTrigger })
      await expect(facet).toHaveCount(1)
      await expect(facet).toHaveAttribute('aria-haspopup', 'menu')
      await expect(facet).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByText('Last 30 days', { exact: true })).toHaveCount(1)

      // ── The agents table ───────────────────────────────────────────────────
      const agents = section(page, 'analytics-agents-section')
      await expect(agents).toHaveCount(1)
      await expect(agents.getByText(COPY.agentResearch)).toHaveCount(2)
      await expect(agents.getByText(COPY.agentRetired)).toHaveCount(2)
      await expectExactlyOneVisible(agents, COPY.agentResearch)
      await expectExactlyOneVisible(agents, COPY.agentRetired)
      // Each delegation's budget renders its FIGURES by a different medium per
      // half: the desktop table prints them above the cell, the mobile rows
      // join them with `budgetLine`. Neither half measures the budget any
      // more (#3806): the fixture's read is stale — its `period_end` precedes
      // `FROZEN_NOW`, the `refilled-updating` state — so the used amount
      // belongs to a finished period, no `role=progressbar` renders, and the
      // row says the period couldn't be read. (The role is an
      // accessibility-tree role, so at mobile, where the desktop half is
      // `display:none`, a bar count reads 0 on both halves for the same
      // page.)
      await expect(agents.getByText(COPY.budgetOf250)).toHaveCount(2)
      await expect(agents.getByText(COPY.budgetOf500)).toHaveCount(2)
      await expect(agents.getByText(COPY.budgetOf250).filter({ visible: true })).toHaveCount(1)
      await expect(agents.getByText(COPY.budgetOf500).filter({ visible: true })).toHaveCount(1)
      await expect(agents.getByRole('progressbar')).toHaveCount(0)
      await expect(agents.getByText(COPY.unreadBudget)).toHaveCount(2)
      // The caption lives in the DESKTOP cell only (`BudgetCell`); the mobile
      // row's `budgetLine` keeps the figures, so at desktop both rows show it
      // and at mobile the desktop half is `display:none`.
      if (vp.width >= 1024) {
        await expect(agents.getByText(COPY.unreadBudget).filter({ visible: true })).toHaveCount(2)
      } else {
        await expect(agents.getByText(COPY.unreadBudget).filter({ visible: true })).toHaveCount(0)
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
      // The new-user state and the two other states are mutually exclusive
      // with this one by what they report about the request, so their absence
      // is a fact about the render, not a hope. The sparse band is gone with
      // #4333 — its test id must not come back with it.
      await expect(page.getByTestId('analytics-sparse-line')).toHaveCount(0)
      await expect(page.getByTestId('analytics-agent-notice')).toHaveCount(0)
      await expect(page.getByText('No agent activity yet')).toHaveCount(0)
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
      // be allowed to photograph itself as an empty state. NOTE: this is the
      // QUIET-WINDOW state, not the new-user one — the shared fixture's
      // `/agents` handler names agents, so the page can report something and
      // simply has nothing in this range (#4333).
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
      for (const testId of TILE_IDS) {
        await expect(page.getByTestId(testId)).toHaveCount(0)
      }
      await expect(page.getByTestId('stat-tile-fees-paid-to-haven')).toHaveCount(0)
      await expect(page.getByTestId('analytics-agents-section')).toHaveCount(0)
      await expect(page.getByTestId('analytics-merchants-section')).toHaveCount(0)
      await expect(page.getByTestId('analytics-balance-section')).toHaveCount(0)
      await expect(page.getByTestId('area-chart')).toHaveCount(0)
      await expect(page.getByTestId('analytics-sparse-line')).toHaveCount(0)
      await expect(page.getByText('No agent activity yet')).toHaveCount(0)

      // The empty response's floor is `null` (#3013), so the ledger-floor
      // clause has no date to name — absence asserted, because a floor
      // invented here would report a coverage the ledger does not hold.
      await expect(page.getByText(COPY.refusalsRecordedFrom)).toHaveCount(0)

      // The header survives an empty report: the facet and the control are
      // still on the page to change it — an empty report is not an
      // unavailable one. ONE exact-text element carries the window words —
      // the trigger's value span (#4333; the bare caption is retired).
      await expect(page.getByText('Last 30 days', { exact: true })).toHaveCount(1)
      await expect(page.getByRole('button', { name: COPY.agentFacetTrigger })).toHaveCount(1)
      await expect(page.getByRole('button', { name: COPY.periodTrigger })).toHaveCount(1)
      await expect(page.getByRole('radiogroup', { name: COPY.rangeControlLegacyName })).toHaveCount(0)
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
      await expect(page.getByText('No agent activity yet')).toHaveCount(0)

      // The error scenario serves no overview at all — no basis, no floor — so
      // the ledger-floor clause has nothing to be printed from, and its absence
      // is part of the "a failure is not a report" contract the tile absences
      // above pin.
      await expect(page.getByText(COPY.refusalsRecordedFrom)).toHaveCount(0)

      // The header survives its endpoint: the facet and the control are still
      // offered, because what failed was the reading, not the page. ONE
      // exact-text element carries the window words — the trigger's value
      // span (#4333).
      await expect(page.getByText('Last 30 days', { exact: true })).toHaveCount(1)
      await expect(page.getByRole('button', { name: COPY.agentFacetTrigger })).toHaveCount(1)
      await expect(page.getByRole('button', { name: COPY.periodTrigger })).toHaveCount(1)
      await expect(page.getByRole('radiogroup', { name: COPY.rangeControlLegacyName })).toHaveCount(0)
    },
  },
]

/**
 * Override the one route the scenario is about, after `mockHavenApi`, so
 * Playwright's LIFO route matching reaches this handler first; every other
 * request defers to the shared fixture with `route.fallback()`, the same
 * idiom `settings-accounting.visual.spec.ts` and `focus-visible.visual.spec.ts`
 * use. The shared fixture's own `/agents` and `/auth/*` handlers stay in
 * force, which is what keeps the shell (sidebar, user card) rendering
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
    // #4333: the Agent facet reads the agents LIST (`useAgents`), and the
    // shared fixture names ONE agent — one option and `FacetMenu` hides
    // itself. Name the overview's own two here (names only are read: id,
    // name, status) so the header renders the facet the page ships with.
    if (request.method() === 'GET' && path === '/agents') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { id: 'agent-research', name: 'Research agent', status: 'active' },
            { id: 'agent-retired', name: 'Data-feed agent', status: 'paused' },
          ],
        }),
      })
      return
    }
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
