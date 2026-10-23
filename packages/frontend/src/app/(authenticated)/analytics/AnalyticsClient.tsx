'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePreferences } from '@/hooks/usePreferences'
import { useAgents } from '@/hooks/useAgents'
import { useAnalyticsOverview } from '@/hooks/useAnalyticsOverview'
import {
  formatAnalyticsAmount,
  paymentsAgentsCaption,
  spentComparisonCaption,
} from '@/lib/analytics-format'
import type { AnalyticsOverviewResponse, AnalyticsRangeValue } from '@/types/analytics'
import {
  isAnalyticsRangeValue,
  readStoredAnalyticsRange,
  readUrlAnalyticsAgentId,
  readUrlAnalyticsRange,
  writeStoredAnalyticsRange,
  writeUrlAnalyticsAgentId,
  writeUrlAnalyticsRange,
} from '@/lib/analytics-range'
import { PageHeader } from '@/components/ui/PageHeader'
import { PeriodPicker } from '@/components/ui/PeriodPicker'
import type { PeriodValue } from '@/components/ui/list-url-codec'
import { FacetMenu } from '@/components/ui/FacetMenu'
import type { ListFacet } from '@/components/ui/FacetMenu'
import { Tooltip } from '@/components/ui/Tooltip'
import { Icon } from '@/components/ui/Icon'
import { Info } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { AgentsTable } from '@/components/analytics/AgentsTable'
import { BalanceSection } from '@/components/analytics/BalanceSection'
import { SpendSection } from '@/components/analytics/SpendSection'
import { orderAgentsForDisplay, seriesColorByAgent } from '@/lib/analytics-series'
import { MerchantsTable } from '@/components/analytics/MerchantsTable'
// The floor slice D fixed for "too little data to chart" — ONE home: the
// chart primitives' "render nothing" rule and this page's balance guard read
// this constant. The page-level sparse BAND is gone (#4333): sections render
// whenever the window has any activity and each keeps its own guard, so this
// is only the charts' own floor, not a page state.
import { MIN_CHARTABLE_DAYS } from '@/components/charts/chart-scale'
import {
  AnalyticsErrorState,
  NewUserEmptyState,
  NoActivityEmptyState,
} from '@/components/analytics/EmptyStates'

/**
 * The Analytics page (#2947, epic #2944 slice C; the #4333 rebuild).
 *
 * One request, the tiles, and the sections. The request is the whole page's
 * only source: `GET /analytics/overview` (#2946, agent-scopable since
 * #4332) returns the aggregate, so the page has one loading state rather
 * than a per-widget fetch each answering its own question. Nothing here
 * computes a figure the endpoint did not report — `lib/analytics-format.ts`
 * owns the rule and this file obeys it.
 *
 * ── The tiles and what each one says (#4333) ────────────────────────────────
 *
 *   Spent        The booked total, CONFIRMED only, with the previous window's
 *                spent under it as an AMOUNT ("vs $280.10 the 30 days
 *                before") — an absolute comparison, not a percentage pill.
 *   Payments     The payment count, captioned "by N of M agents" — or the
 *                agent's name when the Agent facet narrows the page.
 *   Refused      The refusal count, the attempts behind it, and — when
 *                filtered to one agent — a Review link to that agent's
 *                refused attempts (#4323; with all agents shown there is no
 *                page-level refused list to review). The two recording
 *                caveats (the ledger's floor date, the unrecorded price-cap
 *                class) ride an ⓘ hint on the label instead of a footnote
 *                line: elaboration on the count, not a second figure.
 *   Agents near  "N of M" — of the agents WITH budgets, how many are above
 *   their budget 75% of a period budget.
 *   Fees         Only when the fee flag is ON: a fourth or fifth tile. While
 *                Haven charges nothing the tile is absent — a $0.00 there
 *                would report "nothing charged this period", which is not
 *                the same fact, and the old flag-off tile existed only
 *                because there was nowhere else to say it; the absence IS
 *                the saying now (the gas-sponsored note rides the tile when
 *                it exists).
 *
 * The numbers themselves never carry colour; there are no delta chips — the
 * comparison is absolute (`percentChange` is gone with them).
 *
 * ── The states (#4333) ──────────────────────────────────────────────────────
 *
 * loading → one skeleton in the final layout's shape; failed (or never
 * answered) → one error state with one retry; the user has NO agents at all
 * (revoked included) → one new-user empty state replacing the zero tiles and
 * empty sections; answered with no activity in the window → one empty state,
 * not tiles asserting zeros; a stale or foreign `?agentId=` → the filter is
 * cleared with a one-line notice, not a page error; else the populated page —
 * tiles plus the sections, each of which keeps its own guard.
 */

/**
 * The limit of the Refused count, stated in the ⓘ hint rather than left to be
 * inferred: one class of refusal never reaches the ledger — a price cap the
 * agent's own runtime applies. The cap lives in the agent's code and its SDK;
 * a runtime that declines before ever asking Haven leaves no row anywhere,
 * because there is no request to read. Who refuses is stated (the agent
 * itself), because the count on the face of the tile is only ever what Haven
 * refused and recorded.
 *
 * Until #3109 this sentence also named a second class — a budget the hosted
 * tools decline at PREPARE. That refusal now has a server-side writer
 * (`source: 'hosted_prepare'`), so the tile COUNTS it, and a hint that still
 * called it unrecorded would contradict the count above it. #3055 (reopened)
 * narrowed the sentence back to the price cap alone; do not widen it again
 * without a refusal class the ledger genuinely cannot see.
 */
const UNRECORDED_REFUSALS_NOTE = "Price-cap refusals in your agent's runtime are not recorded."

/** The window's length for the caption, keyed off the control's own values. */
const RANGE_DAYS: Record<AnalyticsRangeValue, 7 | 30 | 90> = { '7d': 7, '30d': 30, '90d': 90 }

/** The refused-attempts route (#4323): an agent's activity tab, pre-filtered. */
function refusedAttemptsHref(agentId: string): string {
  return `/agents/${agentId}?tab=activity&status=refused`
}

/**
 * The tile grid. `agents` is the response's own list in display order (the
 * Payments caption counts it); `agentId`/`agentName` are the facet's
 * selection and the name it resolves to.
 */
function TileGrid({
  data,
  currency,
  agents,
  agentId,
  agentName,
}: {
  data: AnalyticsOverviewResponse
  currency: 'USD' | 'EUR' | 'SEK'
  agents: AnalyticsOverviewResponse['agents']
  agentId: string | null
  agentName: string | null
}) {
  if (data === null) return null
  const { totals, basis, range } = data

  const gasSponsored =
    totals.gas_sponsored_ops === 1
      ? "Haven sponsored 1 operation's gas."
      : totals.gas_sponsored_ops > 1
        ? `Haven sponsored ${totals.gas_sponsored_ops} operations' gas.`
        : null

  const fees = totals.fees

  // The Spent comparison is absolute (#4333): the previous window's figure,
  // as an amount, beside this one — never a ratio of the two.
  const spentFootnote = spentComparisonCaption(totals.spent_previous, range.days, currency)

  // The Payments caption: who the window's payments came from. When the page
  // is filtered to one agent, the agent's own name — the facet already
  // answers "which agents", so counting agents under a single-agent filter
  // would restate the trigger as a sentence.
  const agentsWithPayments = agents.filter((a) => a.payments > 0).length
  const paymentsFootnote = agentId !== null
    ? agentName ?? 'this agent'
    : paymentsAgentsCaption(agentsWithPayments, agents.length)

  // The refusal count's own basis is the attempts behind it (#4333) — plus,
  // when the page names one agent, a Review link to that agent's refused
  // attempts (#4323). With all agents shown there is no page-level refused
  // list, so there is nothing to review and the link is absent. The
  // attempted amount is no longer on the tile: the count is the tile's
  // figure and the attempts its basis, and the transaction history carries
  // the amounts.
  const attempts = `${totals.refused_attempts} attempt${totals.refused_attempts === 1 ? '' : 's'}`
  const refusedFootnote =
    agentId !== null ? (
      <>
        {`${attempts} · `}
        <Link
          href={refusedAttemptsHref(agentId)}
          className="font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
        >
          Review
        </Link>
      </>
    ) : (
      attempts
    )

  // The two recording caveats move onto the label as an ⓘ hint (#4333): the
  // ledger's floor date — from the response, never inferred — and the one
  // class the ledger never sees. A tooltip is for elaboration; both sentences
  // elaborate the count the reader is already looking at.
  const refusalHint = (
    <Tooltip
      label={
        basis.refusals_recorded_from != null
          ? `Refusals are recorded from ${formatFloorDate(basis.refusals_recorded_from)}. Earlier attempts have no refusal rows to report. ${UNRECORDED_REFUSALS_NOTE}`
          : UNRECORDED_REFUSALS_NOTE
      }
      side="bottom"
    >
      <span
        tabIndex={0}
        role="button"
        aria-label={`What the refused count records: ${basis.refusals_recorded_from != null ? `Refusals are recorded from ${formatFloorDate(basis.refusals_recorded_from)}. Earlier attempts have no refusal rows to report. ${UNRECORDED_REFUSALS_NOTE}` : UNRECORDED_REFUSALS_NOTE}`}
        data-testid="analytics-refused-hint"
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
      >
        <Icon icon={Info} className="h-3.5 w-3.5" />
      </span>
    </Tooltip>
  )

  const bands = totals.budget_bands
  const hasBudgets = bands.agents_with_budget > 0

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="analytics-tiles">
      <StatTile
        label="Spent"
        value={formatAnalyticsAmount(totals.spent, currency)}
        footnote={spentFootnote}
      />
      <StatTile
        label="Payments"
        value={String(basis.payments_counted)}
        footnote={paymentsFootnote}
      />
      <StatTile
        label="Refused"
        value={String(totals.refused_count)}
        footnote={refusedFootnote}
        hint={refusalHint}
      />
      <StatTile
        label="Agents near their budget"
        value={hasBudgets ? `${bands.above_75}/${bands.agents_with_budget}` : '—'}
        footnote={
          hasBudgets
            ? 'above 75% of a period budget'
            : 'No agent has a budget set in this window.'
        }
      />
      {/* The fees tile EXISTS only while the fee flag is on (#4333): it is a
          fourth or fifth tile when Haven charges, absent when it does not.
          The flag-off "No fees yet" tile is retired — its one job (saying the
          product charges nothing) is done by the tile's absence, and a $0.00
          would report "nothing charged this period", a different fact. The
          gas note rides the tile when there is one to carry it. */}
      {fees.flag_on && (
        <StatTile
          label="Fees paid to Haven"
          value={formatAnalyticsAmount(fees.amount, currency)}
          footnote={gasSponsored}
        />
      )}
    </div>
  )
}

/** "2026-07-11" to the same "11 Jul" the budget cells use; an unparseable
 *  date is passed through rather than rendered as an invented one. */
function formatFloorDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date)
}

/** The one loading layout, in the shape the settled page takes: four tiles
 *  then the table. A skeleton that matched nothing would make the page jump
 *  as it filled, which is the flash the loading states exist to avoid. */
function AnalyticsSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading analytics"
      data-testid="analytics-skeleton"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div
            key={item}
            className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card p-5"
          >
            <Skeleton variant="text" className="h-3 w-24" />
            <Skeleton variant="text" className="mt-2 h-6 w-20" />
            <Skeleton variant="text" className="mt-3 h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card">
        <Skeleton variant="rect" className="h-12 w-full rounded-none" />
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} variant="rect" className="mx-5 my-3 h-10" />
        ))}
      </div>
    </div>
  )
}

type AnalyticsData = NonNullable<ReturnType<typeof useAnalyticsOverview>>['data']

/** The agents the facet offers, in the list's own order: active, paused, the
 *  rest, then name — the same rank `/transactions` uses for its Initiator
 *  facet, so the two menus order one user's agents identically. Options come
 *  from the agents LIST (`useAgents`), not the overview's filtered response:
 *  `FacetMenu` hides itself at one option or fewer, so a list drawn from the
 *  FILTERED response would make the facet vanish the moment an agent is
 *  picked. */
const agentRank = (status: string) => (status === 'active' ? 0 : status === 'paused' ? 1 : 2)

export default function AnalyticsClient() {
  const { currency } = usePreferences()
  const { agents: allAgents, loading: agentsLoading } = useAgents()

  // The window comes from the URL when it carries one — `?period=7d` opens on
  // Last 7 days, the sharable answer — and otherwise from the device's stored
  // choice. Both are read in the initialiser, not in an effect, so the FIRST
  // request carries the resolved window — see the note in
  // `lib/analytics-range.ts` (the `haven.theme` reasoning again).
  const [range, setRange] = useState<AnalyticsRangeValue>(
    () => readUrlAnalyticsRange() ?? readStoredAnalyticsRange(),
  )

  // The Agent facet (#4333): a URL state, NOT a stored preference — an agent
  // page links `/analytics?agentId=<id>` and the filter lands set. Cleared
  // with a notice when it names nothing (below).
  const [agentId, setAgentId] = useState<string | null>(() => readUrlAnalyticsAgentId())
  const [agentNotice, setAgentNotice] = useState(false)

  // The Settings currency is the one source for both halves of the page: the
  // value on the wire and the symbol in the tiles. The endpoint echoes it on
  // the response, and the response is not consulted for it — were the two to
  // disagree, the page would have two answers to "which currency am I
  // reading" and the reader would believe the louder one.
  const { data, loading, failed, agentNotFound, refetch } = useAnalyticsOverview(
    range,
    currency === 'EUR' ? 'eur' : currency === 'SEK' ? 'sek' : 'usd',
    agentId,
  )

  const changeRange = (next: PeriodValue) => {
    // The picker here offers presets only (no All time, no custom range), so
    // the menu can only hand back a preset — but the guard is the same one
    // `changeRange` has always applied: a value the endpoint would answer 400
    // to is not a range, and must not leave this page either way (see
    // `isAnalyticsRangeValue`).
    if (!next.preset || !isAnalyticsRangeValue(next.preset)) return
    setRange(next.preset)
    writeStoredAnalyticsRange(next.preset)
    writeUrlAnalyticsRange(next.preset)
  }

  const changeAgent = (next: string[]) => {
    const id = next[0] ?? null
    setAgentId(id)
    writeUrlAnalyticsAgentId(id)
    // Picking a different agent is not an error recovery; the notice is
    // about the filter that WAS there, and a deliberate new choice clears it.
    setAgentNotice(false)
  }

  // A stale or foreign agentId (#4333): the endpoint answers 404 (#4332) and
  // the agents list cannot name it either. Either way the filter is cleared —
  // with a one-line notice, never the page error — because a page that showed
  // the unfiltered report without saying so would look like the link worked.
  // The list-side check only runs when the list actually arrived: a failed
  // agents fetch must not clear a filter it never read.
  useEffect(() => {
    if (agentId === null) return
    const cleared = agentNotFound || (!agentsLoading && allAgents.length > 0 && !allAgents.some((a) => a.id === agentId))
    if (cleared) {
      setAgentId(null)
      writeUrlAnalyticsAgentId(null)
      setAgentNotice(true)
    }
  }, [agentId, agentNotFound, agentsLoading, allAgents])

  const agentName = agentId !== null ? allAgents.find((a) => a.id === agentId)?.name ?? null : null

  // The new-user state (#4333): the user has NO agents at all — revoked ones
  // included — so there is nothing the page could ever report. It waits for
  // the list itself: a still-loading list is the skeleton's job, not an
  // empty state's.
  const hasNoAgents = !agentsLoading && allAgents.length === 0

  const days = data?.range.days ?? RANGE_DAYS[range]

  let body: ReactNode
  if (loading) {
    body = <AnalyticsSkeleton />
  } else if (failed || data === null) {
    // `data === null` with the request settled and no error is a state the
    // hook does not produce; the branch is here so that a change to the hook
    // fails as an error state with a retry, never as a blank page.
    body = <AnalyticsErrorState onRetry={refetch} />
  } else if (hasNoAgents) {
    body = <NewUserEmptyState />
  } else if (isEmptyWindow(data)) {
    body = <NoActivityEmptyState />
  } else {
    // One order for every section that names an agent: the wire's `agents[]`
    // is unordered (no ORDER BY in the repository), so the page sorts once.
    // One colour map too (#4331): each agent's fill is its own avatar tint,
    // hashed from its name, so it holds across requests, ranges and ranks.
    const agents = orderAgentsForDisplay(data.agents)
    const agentColors = seriesColorByAgent(agents, data.by_day)
    const rangeDays = days === 7 || days === 90 ? days : 30
    body = (
      <>
        <TileGrid
          data={data}
          currency={currency}
          agents={agents}
          agentId={agentId}
          agentName={agentName}
        />
        {agents.length > 0 && (
          <div className="mt-4" data-testid="analytics-agents-section">
            <AgentsTable agents={agents} currency={currency} />
          </div>
        )}
        {/* Below the table, per screen-recipes.md § Analytics item 5
            (table first, then the spend chart, merchants, balance): the
            table is the page's primary reading surface and stays on the
            first screen; the chart is the same figures over time. Each
            section keeps its own guard (#4333 removed the page-level sparse
            band that hid all of them together), so a one-day window still
            shows the figures and the table — a total over one day is still
            the total over that day — and only the charts decline to draw
            through fewer than MIN_CHARTABLE_DAYS points. */}
        <div className="mt-4">
          <SpendSection
            byDay={data.by_day}
            agents={agents}
            agentColors={agentColors}
            range={data.range}
            tz={data.basis.tz}
            currency={currency}
            rangeDays={rangeDays}
          />
        </div>
        {/* ── Merchants and balance (slice E, #2949) ────────────────────────
            Mounted off THIS same response — one request still owns the whole
            page. Each guards on its own array rather than on the other's: a
            range can have agents without a reported merchant row, or a
            balance series with no merchants, and rendering a section the
            endpoint did not populate would be the page asserting figures
            it was not given. The balance section is told when the Agent
            facet is set: the series is per-user and is NOT narrowed, and it
            says so (#4333). */}
        {data.merchants.length > 0 && (
          <div className="mt-4" data-testid="analytics-merchants-section">
            <MerchantsTable
              merchants={data.merchants}
              agents={agents}
              currency={currency}
              period={range}
              agentId={agentId}
            />
          </div>
        )}
        {data.balance_by_day.length >= MIN_CHARTABLE_DAYS && (
          <div className="mt-4">
            <BalanceSection
              balanceByDay={data.balance_by_day}
              currency={currency}
              rangeDays={rangeDays}
              agentFiltered={agentId !== null}
            />
          </div>
        )}
      </>
    )
  }

  // The facet's options: every agent the list names, names only —
  // `ListFacetOption` has no monogram slot, and a name is the whole answer.
  const sortedAgents = [...allAgents].sort(
    (a, b) => agentRank(a.status) - agentRank(b.status) || a.name.localeCompare(b.name),
  )
  const agentFacet: ListFacet = {
    id: 'agentId',
    label: 'Agent',
    selection: 'single',
    allLabel: 'All agents',
    options: sortedAgents.map((agent) => ({ value: agent.id, label: agent.name })),
  }

  return (
    <div className="max-w-6xl" data-testid="analytics-page">
      <PageHeader
        title="Analytics"
        subtitle="What your agents did with your money."
        actions={
          <div className="flex items-center gap-3">
            {/* The Agent facet (#4333) before the PeriodPicker, per the
                mockup: a list-controls facet (single-select, "All agents"
                first) that writes `?agentId=` — the key `/transactions`
                reads — and tints while a filter is set (FacetMenu's own
                `active` rule). A stale or foreign id clears itself with a
                notice, never the page error. */}
            <FacetMenu facet={agentFacet} value={agentId !== null ? [agentId] : []} onChange={changeAgent} />
            {/* The list-controls period control (#4110, #4116): presets only,
                no All time and no custom range — the endpoint takes a rolling
                `range`, not dates. With All time absent the picker treats the
                current value as its own default, so the trigger never tints:
                a returning reader's stored window is not a filter, it is the
                page's resting state. */}
            <PeriodPicker value={{ preset: range }} onChange={changeRange} allowAllTime={false} />
          </div>
        }
      />
      {agentNotice && (
        <p className="mt-3 text-sm text-[var(--v2-ink-2)]" role="status" data-testid="analytics-agent-notice">
          That agent isn&apos;t available.
        </p>
      )}
      {body}
    </div>
  )
}

/**
 * The whole-page empty state's trigger: the request answered, and there is
 * nothing in the window to report — no counted payments, no submissions
 * waiting for their evidence, no refusals, no fees. Anything else is rendered
 * as figures, because a payment that has been submitted but not yet settled is
 * activity the tiles name with, and hiding it behind "no activity" would be
 * the page's least honest lie.
 */
function isEmptyWindow(data: NonNullable<AnalyticsData>): boolean {
  return (
    data.basis.payments_counted === 0 &&
    data.basis.unsettled_submitted === 0 &&
    data.totals.refused_count === 0 &&
    data.basis.fee_rows === 0
  )
}
