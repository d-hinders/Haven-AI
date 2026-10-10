'use client'

/**
 * The top of the dashboard (#3807, epic #3801): the "Dashboard" heading with
 * its templated 7-day summary sentence, the balance panel, and the 30-day
 * spending block. Lives in its own file so `DashboardClient.tsx` stops
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
 *   NULL-booked rows were priced at today's rate (owner decision 1): a
 *   re-priced total is never shown as booked.
 * - **The sparkline is #3805's**, fed from `spend.balance_by_day`: days with
 *   no snapshot are GAPS in a dense 30-day window, never zeros, and fewer
 *   than 3 measured days renders the flat placeholder rather than a line
 *   pretending to be data.
 * - **Fresh data shows no indicator; stale data shows
 *   `BalanceFreshnessIndicator`** — the same #3295 contract the hero had.
 */

import { useCountUp } from '@/hooks/useCountUp'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { AreaChart, type SparklinePoint } from '@/components/ui/AreaChart'
import { Amount } from '@/components/haven'
import { BalanceFreshnessIndicator } from '@/components/haven'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { PageHeader } from '@haven_ai/ui/PageHeader'
import { formatFiat, currencyLocale } from '@/lib/format'
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

/** UTC `YYYY-MM-DD`, `offset` days from today — the snapshot date key. */
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
 * snapshot exists: a GAP, never a zero. Fewer than 3 measured days
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

function sparklineAriaLabel(points: SparklinePoint[], currency: 'USD' | 'EUR' | 'SEK'): string {
  const measured = points.filter((point) => point.value !== null)
  if (measured.length === 0) {
    return 'Balance over the last 30 days. No snapshots yet.'
  }
  const first = measured[0]
  const last = measured[measured.length - 1]
  return `Balance over the last 30 days, from ${formatFiat(first.value as number, currency)} to ${formatFiat(last.value as number, currency)}.`
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
   * False in the focused first-run view (an unfunded account's hero +
   * checklist only, #3807's shape for the old hero-only render): the
   * spending block is a funded user's surface, and a week of zeros under a
   * "get funded" checklist reads as a verdict, not a summary.
   */
  showSpending?: boolean
  /**
   * #3818: no agent has paid yet. The spending block then says what will
   * appear there instead of three zero tiles and a $0.00 — an empty section
   * explains itself rather than reading as a summary of nothing.
   */
  noPaymentsYet?: boolean
  onDepositAddress: () => void
  onAddFunds: () => void
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
  onDepositAddress,
  onAddFunds,
}: MoneyPanelProps) {
  // Animate the balance from 0 → totalFiat on first paint after data loads.
  // Subsequent changes (currency switches, polled refresh) snap instantly.
  // Respects prefers-reduced-motion via the hook.
  const animatedTotal = useCountUp(totalFiat, { enabled: !loading && !unavailable })

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

  const perAgentSpend = (overview?.agents ?? [])
    .map((agent: DashboardAgentPreview) => ({
      id: agent.id,
      name: agent.name,
      value: agent.stats.d30.net[bucket],
      approx: agent.stats.d30.approx,
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
  const showUnattributed = d30 !== null && unattributedValue > 0.005

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle={summary ?? undefined} />

      <section
        className="relative overflow-hidden rounded-[24px] border border-[var(--v2-border-anchor)] bg-[var(--v2-surface-anchor)] shadow-card-raised"
      >
        {/*
          Subtle ambient drift on the gradient backdrop — the v2-mesh-drift
          keyframe in globals.css. The backdrop extends 6% past the parent on
          every side so the drift's translation never exposes the underlying
          anchor surface (the parent's `overflow-hidden` clips it away).
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-[6%] v2-mesh-drift"
          style={{ background: 'var(--v2-surface-hero)' }}
        />
        <div className="relative grid gap-6 px-6 py-7 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <p className="text-sm font-medium text-[var(--v2-ink-2)]">Total balance</p>
            {loading ? (
              <div className="mt-3 h-12 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
            ) : unavailable ? (
              <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink-3)] sm:text-5xl">
                Unavailable
              </p>
            ) : (
              <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular sm:text-5xl">
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
            {spend ? (
              <div className="mt-3 max-w-xs">
                <AreaChart
                  variant="sparkline"
                  points={sparkPoints}
                  ariaLabel={sparklineAriaLabel(sparkPoints, currency)}
                />
              </div>
            ) : null}
            {/*
              Meta-line states under the sparkline:
              1. Watching for a deposit — a soft brand-tinted pill with a pulse
                 so the user knows the dashboard is actively listening.
              2. Funded with change data — the signed change SINCE YESTERDAY.
              3. Funded without change data, OR no change available — a quiet
                 caption.
              #3295: when some token has never been read (unavailable), the
              change line steps aside entirely — no swing may be claimed from
              a total understated by an unknown amount. A merely stale set of
              totals still diffs normally.
            */}
            {watchingForDeposit ? (
              <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[var(--v2-brand)]">
                <span
                  aria-hidden="true"
                  className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--v2-brand)] animate-pending-pulse"
                />
                Watching for incoming deposits…
              </p>
            ) : changeAvailable && !sekChangeUnavailable && !changeUnavailable && changeAmount !== null ? (
              <p className={`mt-3 text-sm font-medium ${changeAmount >= 0 ? 'text-[var(--v2-success)]' : 'text-[var(--v2-danger)]'}`}>
                {formatSignedCurrency(changeAmount, currency)} ({formatPercent(changePercent, currency)}) since yesterday
              </p>
            ) : (
              <p className="mt-3 text-sm text-[var(--v2-ink-3)]">
                Across all linked Haven accounts.
              </p>
            )}
          </div>

          {hasAccounts ? (
            requiresOtherDevice ? (
              <PasskeyOtherDeviceNotice className="max-w-sm" />
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button onClick={onDepositAddress} size="lg">
                  Deposit address
                </Button>
                <Button onClick={onAddFunds} variant="ghost" size="lg">
                  Add funds
                </Button>
              </div>
            )
          ) : (
            <Button href="/accounts" size="lg">
              Create Haven account
            </Button>
          )}
        </div>
      </section>

      {/*
        Spending, last 30 days. The total is #3803's NET figure — the same
        definition /analytics uses — so the two surfaces cannot disagree. The
        three inline StatTiles carry the window's activity counts; the
        agent split names the top three plus the count of the rest (the wire
        carries every delegation-rail agent; revoked agents' spend is inside
        the total and surfaces as the "Agents since removed" row so the
        breakdown reconciles with the headline).
      */}
      {showSpending && noPaymentsYet && !loading && !unavailable ? (
        <section className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card p-5">
          <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Spending, last 30 days</h2>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
            After your agents&rsquo; first payment, this shows what they spent, at how many merchants,
            and how often a budget stopped a payment.
          </p>
        </section>
      ) : showSpending ? (
        <section className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Spending, last 30 days</h2>
          {loading ? (
            <div className="h-6 w-28 rounded bg-[var(--v2-surface-2)] animate-pulse" />
          ) : unavailable ? (
            <p className="text-2xl font-semibold tracking-tight text-[var(--v2-ink-3)] v2-tabular">—</p>
          ) : d30 ? (
            <Amount
              amount={d30.net[bucket]}
              currency={currency}
              approx={d30.approx}
              size="lg"
            />
          ) : null}
        </div>

        {!loading && !unavailable && topAgents.length > 0 ? (
          <dl className="mt-4 space-y-1.5">
            {topAgents.map((row) => (
              <div key={row.id} className="flex items-baseline justify-between gap-4">
                <dt className="min-w-0 truncate text-sm text-[var(--v2-ink-2)]">{row.name}</dt>
                <dd className="v2-tabular shrink-0">
                  <Amount amount={row.value} currency={currency} approx={row.approx} />
                </dd>
              </div>
            ))}
            {otherAgentCount > 0 ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="min-w-0 truncate text-sm text-[var(--v2-ink-3)]">
                  {otherAgentCount} other agent{otherAgentCount === 1 ? '' : 's'}
                </dt>
                <dd className="v2-tabular shrink-0">
                  <Amount amount={otherAgentValue} currency={currency} />
                </dd>
              </div>
            ) : null}
            {showUnattributed ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="min-w-0 truncate text-sm text-[var(--v2-ink-3)]">
                  Agents since removed
                </dt>
                <dd className="v2-tabular shrink-0">
                  <Amount amount={unattributedValue} currency={currency} approx={d30?.approx} />
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
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
        </section>
      ) : null}
    </div>
  )
}
