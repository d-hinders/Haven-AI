'use client'

/**
 * The top of the dashboard (#3807, epic #3801): the "Dashboard" heading with
 * its templated 7-day summary sentence, then ONE money card (#3897) — the
 * balance on the left, the 30-day spending on the right, stacked below `lg`. Lives in its own file so `DashboardClient.tsx` stops
 * growing — the hero it replaces (`DashboardHero`), the four KPI tiles
 * (`metricsGrid`/`MetricCard`) and their deprecated `metrics.*` wire fields
 * were removed with this panel.
 *
 * Data rules this panel inherits:
 *
 * - **One balance figure** in the user's currency, summed across accounts by
 *   the overview route. When every linked account is a test account
 *   (`spend.scope === 'testnet'`, #3803 owner decision 3) the figure is test
 *   data and says so — a quiet "Test network" label, never a silently
 *   mislabelled total.
 * - **The spending figures are #3803's NET definition** (`spend.d30.net`) —
 *   the same booked-or-repriced, sweep-netted numbers the analytics page
 *   shows, so the two surfaces cannot disagree. `≈` marks a window whose
 *   NULL-booked rows were priced at today's rate (owner decision 1) where the
 *   conversion changes the number — the server's per-currency
 *   `approxByCurrency` (#4165), so re-priced USDC in USD carries none — and a
 *   bucket it could not price says so in words (`unpricedByCurrency`).
 * - **The sparkline is #3805's**, fed from `spend.balance_by_day`: a day with
 *   no snapshot is skipped, never zero, and the line connects across it
 *   (#3897) in a dense 30-day window; fewer than 3 measured days renders the
 *   flat placeholder rather than a line pretending to be data.
 * - **Fresh data shows no indicator; stale data shows
 *   `BalanceFreshnessIndicator`** — the same #3295 contract the hero had.
 */

import { useCountUp } from '@/hooks/useCountUp'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { AreaChart, type SparklinePoint } from '@/components/ui/AreaChart'
import { Amount } from '@/components/haven'
import { BalanceFreshnessIndicator } from '@/components/haven'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { PageHeader } from '@haven_ai/ui/PageHeader'
import { formatFiat, currencyLocale, SUB_CENT_THRESHOLD } from '@/lib/format'
import { UNPRICED_TOTALS_NOTE } from '@/lib/money-flow-tally'
import {
  buildDashboardSummary,
  type DashboardSummaryAgent,
} from '@/lib/dashboard-summary'
import type { DashboardAgentPreview, DashboardOverviewResponse } from '@/types/dashboard'

const SPARKLINE_DAYS = 30

/** `DashboardOverviewResponse`'s fiat triples are keyed lowercase. */
type FiatBucket = 'usd' | 'eur' | 'sek'

function fiatBucket(currency: 'USD' | 'EUR' | 'SEK'): FiatBucket {
  return currency.toLowerCase() as FiatBucket
}

// #3195 (round-2 finding b): the percent half of the change line renders in
// the currency's locale through `Intl` — `signDisplay: 'exceptZero'` keeps
// the explicit sign the old `toFixed` branch built by hand.
function formatPercent(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  return new Intl.NumberFormat(currencyLocale(currency), {
    style: 'percent',
    signDisplay: 'exceptZero',
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)
}

function formatSignedCurrency(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${formatFiat(Math.abs(value), currency)}`
}

/**
 * UTC `YYYY-MM-DD`, `offset` days from today — the snapshot date key.
 * Deliberately UTC (#3977, builder's choice (b)): the snapshot rows are
 * UTC-dated — `GET /dashboard/overview` writes one per UTC day, and
 * `/analytics/overview`'s contract declares the table "a UTC-dated daily
 * snapshot … regardless of the caller's `tz`" — so re-keying the client side
 * would mislabel the rows. The copy below says what is measured instead.
 */
function snapshotDate(offset: number): string {
  const day = new Date()
  day.setUTCDate(day.getUTCDate() + offset)
  return day.toISOString().slice(0, 10)
}

/**
 * The dense 30-day series the sparkline draws: one slot per day ending at
 * the NEWEST snapshot in the data (today when none exists — a window
 * anchored on the clock alone would draw nothing whenever the newest
 * snapshot lags the clock, e.g. a frozen-clock capture). `null` where no
 * snapshot exists: a missing day is skipped, never zero, and the sparkline
 * connects across it, so the dense window keeps each measured day at its
 * true x position (#3897). Fewer than 3 measured days
 * collapses to just the measured points so the sparkline renders its flat
 * placeholder — a line drawn from 2 points would claim a trend nobody
 * measured.
 */
function balanceSparkPoints(
  balanceByDay: NonNullable<DashboardOverviewResponse['spend']>['balance_by_day'],
  currency: 'USD' | 'EUR' | 'SEK',
): SparklinePoint[] {
  const bucket = fiatBucket(currency)
  const key = bucket === 'usd' ? 'totalUsd' : bucket === 'eur' ? 'totalEur' : 'totalSek'
  const byDate = new Map(balanceByDay.map((row) => [row.snapshotDate, row]))
  const last =
    balanceByDay.length > 0
      ? balanceByDay.reduce(
          (max: string, row: { snapshotDate: string }) => (row.snapshotDate > max ? row.snapshotDate : max),
          balanceByDay[0].snapshotDate,
        )
      : snapshotDate(0)
  const lastMs = Date.parse(`${last}T00:00:00Z`)
  const dense: SparklinePoint[] = []
  for (let i = SPARKLINE_DAYS - 1; i >= 0; i--) {
    const day = new Date(lastMs - i * 86_400_000).toISOString().slice(0, 10)
    const row = byDate.get(day)
    const value = row == null ? null : (row[key] as number | null)
    dense.push({ label: day, value: value != null && Number.isFinite(value) ? value : null })
  }
  const measured = dense.filter((point) => point.value !== null)
  return measured.length >= 3 ? dense : measured
}

/** The `--v2-series-*` colour for a ranked agent — the analytics palette's order. */
function seriesColor(index: number): string {
  return `var(--v2-series-${(index % 6) + 1})`
}

function sparklineAriaLabel(points: SparklinePoint[], currency: 'USD' | 'EUR' | 'SEK'): string {
  // #3977: the series is UTC-dated — the aria-label names what it measures
  // rather than implying the viewer's local days (the Activity card beside
  // it buckets the USER's local days, so the two must not read alike).
  const measured = points.filter((point) => point.value !== null)
  if (measured.length === 0) {
    return 'Balance over the last 30 UTC days. No snapshots yet.'
  }
  const first = measured[0]
  const last = measured[measured.length - 1]
  return `Balance over the last 30 UTC days, from ${formatFiat(first.value as number, currency)} to ${formatFiat(last.value as number, currency)}.`
}

export interface MoneyPanelProps {
  loading: boolean
  unavailable: boolean
  currency: 'USD' | 'EUR' | 'SEK'
  totalFiat: number
  changeAvailable: boolean
  /** True when the SEK baseline for yesterday predates migration 090 — no swing may be claimed. */
  sekChangeUnavailable: boolean
  /** True when some token has no known value — the change line must step aside. */
  changeUnavailable: boolean
  changeAmount: number | null
  changePercent: number
  /**
   * The aggregated degraded-balance marker (#3295). `stale` renders a subtle
   * "as of …" indicator beside the headline figure; `unavailable` means some
   * token has never been read, so the day's change is reported unavailable
   * rather than as a swing computed from an understated total.
   */
  balancesFreshness?: { status: 'stale'; asOf: string } | { status: 'unavailable' }
  /** The overview response — null while loading or unavailable. */
  overview: DashboardOverviewResponse | null
  hasAccounts: boolean
  hasFunds: boolean
  fundingStateKnown: boolean
  watchingForDeposit: boolean
  requiresOtherDevice: boolean
  /**
   * False hides the spending half. The dashboard always shows it since
   * #3897 — before the first payment it explains itself (`noPaymentsYet`),
   * as the mockup's new-user card does — so only the component's own tests
   * pass false.
   */
  showSpending?: boolean
  /**
   * #3818: no agent has paid yet. The spending block then says what will
   * appear there instead of three zero tiles and a $0.00 — an empty section
   * explains itself rather than reading as a summary of nothing.
   */
  noPaymentsYet?: boolean
  /**
   * #4167 — the ONE primary-button rule (owner decision 2026-10-20): the
   * dashboard follows the account page. `true` once the account (or, with
   * several accounts, any account) holds USDC — Send primary; `false` (KNOWN
   * empty) — Receive primary and Send disabled; `null` (the balance is
   * loading or failed to read) — Send stays primary and enabled rather than
   * flipping mid-load, the account page's rule (`AccountDetailClient.tsx`).
   * Undefined reads as null. The default account's aggregate `hasFunds` is a
   * different signal — agents spend USDC, so the rule keys on USDC.
   */
  usdcFunded?: boolean | null
  /**
   * #3902: no other money action is primary while the first-run guide's
   * step 1 ("Add funds") is the active step (#4094 rename: the card's button
   * is "Receive"). The guide then carries the one primary funding action and
   * this card's button steps down to the ghost variant, so exactly one
   * primary money action shows. Default false — the card's own rule decides.
   */
  receiveSecondary?: boolean
  onReceive: () => void
  onSend: () => void
}

export default function MoneyPanel({
  loading,
  unavailable,
  currency,
  totalFiat,
  changeAvailable,
  sekChangeUnavailable,
  changeUnavailable,
  changeAmount,
  changePercent,
  balancesFreshness,
  overview,
  hasAccounts,
  hasFunds,
  fundingStateKnown,
  watchingForDeposit,
  requiresOtherDevice,
  showSpending = true,
  noPaymentsYet = false,
  receiveSecondary = false,
  usdcFunded = null,
  onReceive,
  onSend,
}: MoneyPanelProps) {
  // Animate the balance from 0 → totalFiat on first paint after data loads.
  // Subsequent changes (currency switches, polled refresh) snap instantly.
  // Respects prefers-reduced-motion via the hook.
  const animatedTotal = useCountUp(totalFiat, { enabled: !loading && !unavailable })

  // #4167's primary-button rule: Send primary once funded (and while the
  // state is unknown — null never reads as empty); Receive primary and Send
  // disabled only when the emptiness is KNOWN.
  const sendPrimary = usdcFunded !== false
  const sendDisabled = usdcFunded === false

  const spend = overview?.spend ?? null
  const isTestNetwork = spend?.scope === 'testnet'
  const d30 = spend?.d30 ?? null
  const bucket = fiatBucket(currency)

  // The templated 7-day summary under the heading. Null while the overview
  // is absent — the sentence never renders a half-loaded guess.
  const summary = overview
    ? buildDashboardSummary({
        currency,
        // Optional-chained one level past the wire type: a degraded fixture
        // (#3808's backup-item tests) may carry a partial spend block, and a
        // crash there would take the whole dashboard down with it.
        netSpend: spend?.d7?.net[bucket] ?? 0,
        payments: spend?.d7?.payments ?? 0,
        budgetStops: spend?.d7?.budgetStops ?? 0,
        distinctMerchants: spend?.d7?.distinctMerchants ?? 0,
        agents: (overview.agents ?? []).map(
          (agent): DashboardSummaryAgent => ({
            id: agent.id,
            name: agent.name,
            netSpend: agent.stats.d7.net[bucket],
          }),
        ),
        topMerchant: spend?.topMerchant7d ?? null,
      })
    : null

  const sparkPoints = spend?.balance_by_day
    ? balanceSparkPoints(spend.balance_by_day, currency)
    : []

  // #4165: the server's per-currency "≈" decision and unpriced flag. A
  // backend older than #4165 sends neither; the provenance `approx` is the
  // fallback, which only ever shows MORE marks, never a missing one.
  const spendApprox = d30 ? (d30.approxByCurrency?.[bucket] ?? d30.approx) : false
  const spendUnpriced = d30?.unpricedByCurrency?.[bucket] ?? false

  const perAgentSpend = (overview?.agents ?? [])
    .map((agent: DashboardAgentPreview) => ({
      id: agent.id,
      name: agent.name,
      value: agent.stats.d30.net[bucket],
      approx: agent.stats.d30.approxByCurrency?.[bucket] ?? agent.stats.d30.approx,
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
  const topAgents = perAgentSpend.slice(0, 3)
  const otherAgentCount = Math.max(0, perAgentSpend.length - topAgents.length)
  const otherAgentValue = perAgentSpend
    .slice(topAgents.length)
    .reduce((sum, row) => sum + row.value, 0)

  // Revoked agents' 30-day spend is inside the wire total but has no agent
  // row to name it (#3807 review): surface the unattributed remainder as its
  // own row so the breakdown always reconciles with the headline figure.
  // A cent-level remainder is rounding, not a hidden agent — hold it back.
  const attributedValue = perAgentSpend.reduce((sum, row) => sum + row.value, 0)
  const unattributedValue =
    d30 && perAgentSpend.length > 0 ? d30.net[bucket] - attributedValue : 0
  const showUnattributed = d30 !== null && unattributedValue >= SUB_CENT_THRESHOLD

  // The split bar's segments (#3897): the named agents in series colours,
  // then everything else (other agents, agents since removed) in one
  // neutral segment, as shares of what the list itself adds up to.
  const restValue = otherAgentValue + (showUnattributed ? unattributedValue : 0)
  const splitTotal = topAgents.reduce((sum, row) => sum + row.value, 0) + restValue
  const splitSegments =
    splitTotal > 0
      ? [
          ...topAgents.map((row, index) => ({
            key: row.id,
            share: (row.value / splitTotal) * 100,
            color: seriesColor(index),
          })),
          ...(restValue > 0
            ? [{ key: 'rest', share: (restValue / splitTotal) * 100, color: 'var(--v2-ink-3)' }]
            : []),
        ]
      : []

  // #3807's spending block, now the right half of the money card (#3897).
  // The total is #3803's NET figure — the same definition /analytics uses —
  // so the two surfaces cannot disagree. The three inline StatTiles carry the
  // window's activity counts; the agent split names the top three plus the
  // count of the rest (the wire carries every delegation-rail agent; revoked
  // agents' spend is inside the total and surfaces as the "Agents since
  // removed" row so the breakdown reconciles with the headline).
  const spending = noPaymentsYet && !loading && !unavailable ? (
    <>
      <h2 className="text-sm font-medium text-[var(--v2-ink-2)]">Agent spending</h2>
      <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
        After your agents&rsquo; first payment, this shows what they spent, at how many merchants,
        and how often a budget stopped a payment.
      </p>
    </>
  ) : (
    <div className="flex h-full flex-col">
      <h2 className="text-sm font-medium text-[var(--v2-ink-2)]">Agent spending, last 30 days</h2>
      <div className="mt-2">
        {loading ? (
          <div className="h-8 w-32 rounded bg-[var(--v2-surface-2)] animate-pulse" />
        ) : unavailable ? (
          <p className="text-2xl font-semibold tracking-tight text-[var(--v2-ink-3)] v2-tabular">—</p>
        ) : d30 ? (
          <>
            {/* #4165: the server applies the one "≈" rule per currency
                (`approxByCurrency`, so USDC in USD never marks), and a
                bucket it could not price says so in words. With every
                re-priced row unpriced and nothing booked, the total is
                unknown — "—", never "$0.00". The "—" test reads the GROSS
                figure (#4288): gross is the booked or re-priced fiat before
                the #3755 sweep netting, so gross > 0 means something was
                priced — priced rows that genuinely net to 0 render
                "$0.00" plus the note, not an em dash. */}
            <Amount
              amount={spendUnpriced && d30.gross[bucket] === 0 ? null : d30.net[bucket]}
              currency={currency}
              approx={spendApprox}
              size="lg"
            />
            {spendUnpriced ? (
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{UNPRICED_TOTALS_NOTE}</p>
            ) : null}
          </>
        ) : null}
      </div>

      {!loading && !unavailable && topAgents.length > 0 ? (
        <>
        {/* #3897: the mockup's split bar — one segment per named agent in
            its `--v2-series-*` colour (colour identifies the series, never
            the meaning), the rest in neutral ink. Decorative: the list
            below carries every figure, so the bar is aria-hidden. */}
        <div aria-hidden="true" data-testid="spending-split-bar" className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-[var(--v2-surface-2)]">
          {splitSegments.map((segment) => (
            <span
              key={segment.key}
              className="block h-full"
              style={{ width: `${segment.share}%`, background: segment.color }}
            />
          ))}
        </div>
        <dl className="mt-3 space-y-1.5">
          {topAgents.map((row, index) => (
            <div key={row.id} className="flex items-baseline justify-between gap-4">
              <dt className="flex min-w-0 items-center gap-2 text-sm text-[var(--v2-ink-2)]">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 flex-shrink-0 rounded-sm"
                  style={{ background: seriesColor(index) }}
                />
                <span className="min-w-0 truncate">{row.name}</span>
              </dt>
              <dd className="v2-tabular shrink-0">
                <Amount amount={row.value} currency={currency} approx={row.approx} />
              </dd>
            </div>
          ))}
          {otherAgentCount > 0 ? (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="flex min-w-0 items-center gap-2 text-sm text-[var(--v2-ink-3)]">
                <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-sm bg-[var(--v2-ink-3)]" />
                <span className="min-w-0 truncate">
                  {otherAgentCount} other agent{otherAgentCount === 1 ? '' : 's'}
                </span>
              </dt>
              <dd className="v2-tabular shrink-0">
                <Amount amount={otherAgentValue} currency={currency} />
              </dd>
            </div>
          ) : null}
          {showUnattributed ? (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="flex min-w-0 items-center gap-2 text-sm text-[var(--v2-ink-3)]">
                <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-sm bg-[var(--v2-ink-3)]" />
                <span className="min-w-0 truncate">Agents since removed</span>
              </dt>
              <dd className="v2-tabular shrink-0">
                <Amount amount={unattributedValue} currency={currency} approx={spendApprox} />
              </dd>
            </div>
          ) : null}
        </dl>
        </>
      ) : null}

      {/* The activity counts sit below a hairline, pinned to the bottom of
          the half at `lg` so they line up with the balance half's actions.
          The wrapper's padding is the floor: when this half is the taller
          one, `lg:mt-auto` resolves to 0, and a margin alone would let the
          rule touch the legend (#3902 design review). `items-end` keeps the
          three values on one line when a label wraps at 390px. */}
      <div className="pt-5 lg:mt-auto">
        <div
          data-testid="spending-counts"
          className="grid grid-cols-3 items-end gap-4 border-t border-[var(--v2-border)] pt-5"
        >
          <StatTile
            variant="inline"
            label="Payments"
            value={loading || unavailable || !d30 ? '—' : String(d30.payments)}
          />
          <StatTile
            variant="inline"
            label="Merchants"
            value={loading || unavailable || !d30 ? '—' : String(d30.distinctMerchants)}
          />
          <StatTile
            variant="inline"
            label="Stopped by budget"
            value={loading || unavailable || !d30 ? '—' : String(d30.budgetStops)}
          />
        </div>
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle={summary ?? undefined} />

      {/*
        #3897: ONE money card, as the mockup draws it — `raised`, the page's
        single most prominent surface (Card.tsx: "the dashboard money card"); the
        "Needs attention" card below is a normal flat card like Agents and
        Activity (#3910). Balance left, spending right as a
        `Card.Section divided` (a hairline, never a nested filled card),
        stacked below `lg`. The focused first-run view keeps the spending half,
        which explains itself before the first payment (`noPaymentsYet`).
      */}
      <Card elevation="raised" hover={false} className="overflow-hidden">
        <div className={showSpending ? 'grid lg:grid-cols-2' : undefined}>
          <section aria-label="Balance" className="flex min-w-0 flex-col gap-4 p-5 sm:p-6">
            <div>
              <p className="text-sm font-medium text-[var(--v2-ink-2)]">Balance</p>
              {loading ? (
                <div className="mt-3 h-11 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              ) : unavailable ? (
                <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink-3)]">
                  Unavailable
                </p>
              ) : (
                <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                  {formatFiat(animatedTotal, currency)}
                </p>
              )}
              {isTestNetwork && !loading && !unavailable ? (
                <p className="mt-2 text-sm font-medium text-[var(--v2-ink-2)]">Test network</p>
              ) : null}
              {/* #3295: the headline figure is the last-known balance when the
                  live read failed — a subtle indicator says how old it is, rather
                  than the number silently claiming to be current. Fresh data
                  shows no indicator at all. */}
              {balancesFreshness && (
                <div className="mt-2">
                  <BalanceFreshnessIndicator freshness={balancesFreshness} />
                </div>
              )}
              {/*
                Meta-line states under the figure:
                1. Watching for a deposit — a soft brand-tinted pill with a pulse
                   so the user knows the dashboard is actively listening.
                2. Funded with change data — the signed change SINCE YESTERDAY.
                3. Otherwise nothing: the old filler caption is gone with
                   the redesign (#3897).
                #3295: when some token has never been read (unavailable), the
                change line steps aside entirely — no swing may be claimed from
                a total understated by an unknown amount. A merely stale set of
                totals still diffs normally.
              */}
              {watchingForDeposit ? (
                <p className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-[var(--v2-brand)]">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--v2-brand)] animate-pending-pulse"
                  />
                  Watching for incoming deposits…
                </p>
              ) : changeAvailable && !sekChangeUnavailable && !changeUnavailable && changeAmount !== null ? (
                <p className={`mt-2 text-sm font-medium ${changeAmount >= 0 ? 'text-[var(--v2-success)]' : 'text-[var(--v2-danger)]'}`}>
                  {formatSignedCurrency(changeAmount, currency)} ({formatPercent(changePercent, currency)}) since yesterday (UTC)
                </p>
              ) : null}
              {/* #3977: "(UTC)" is the honest label — the snapshot the change
                  diffs against is keyed by the first clean dashboard load of
                  each UTC day (there is no end-of-day job), so a Stockholm
                  user's "yesterday" is the UTC yesterday. The Activity card
                  beside it buckets the USER's local days; without the
                  qualifier the two windows would read as the same thing. */}
            </div>

            {/* #3908: side by side (lg), the balance half shares a grid row
                with the taller spending half; the sparkline grows into the
                spare height so the actions sit level with the spending
                half's bottom row instead of leaving a gap under them. */}
            {spend ? (
              <div data-testid="money-card-sparkline" className={showSpending ? 'min-h-0 lg:flex lg:flex-1 lg:flex-col' : undefined}>
                <AreaChart
                  variant="sparkline"
                  points={sparkPoints}
                  fill={showSpending}
                  className={showSpending ? 'lg:flex-1' : undefined}
                  ariaLabel={sparklineAriaLabel(sparkPoints, currency)}
                />
              </div>
            ) : null}

            {/* #4094: the money verbs everywhere, per the owner decision —
                and #4167's one primary-button rule: Send primary once funded
                (and while the funding state is unknown), Receive primary with
                Send disabled when known empty. #3902 carries over: while the
                first-run guide's step 1 is the active step, the guide's
                "Add funds" is the one primary funding action and this card's
                "Receive" steps down to ghost. */}
            {hasAccounts ? (
              requiresOtherDevice ? (
                <PasskeyOtherDeviceNotice className="max-w-sm lg:mt-auto" />
              ) : (
                // `lg:mt-auto`: with no sparkline (spend still loading or
                // unavailable) the spare height sits above the actions,
                // never below them (#3908).
                <div className="flex flex-wrap gap-3 lg:mt-auto">
                  <Button
                    onClick={onReceive}
                    variant={sendPrimary || receiveSecondary ? 'ghost' : 'primary'}
                  >
                    Receive
                  </Button>
                  <Button onClick={onSend} variant={sendPrimary ? 'primary' : 'ghost'} disabled={sendDisabled}>
                    Send
                  </Button>
                </div>
              )
            ) : (
              <div className="lg:mt-auto">
                <Button href="/accounts">Create Haven account</Button>
              </div>
            )}
          </section>

          {showSpending ? (
            <Card.Section divided className="min-w-0 lg:border-l lg:border-t-0">
              <section aria-label="Spending" className="h-full p-5 sm:p-6">
                {spending}
              </section>
            </Card.Section>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
