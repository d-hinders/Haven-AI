'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { shouldMarkApprox, type ApiSchema } from '@haven_ai/core'
import { ArrowLeftRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { TransactionActivityRow } from '@/components/haven'
import type { StatusTone } from '@/components/ui/StatusBadge'
import { timeAgo } from '@/lib/format'
import { counterpartyLabel, type CounterpartyFields } from '@/lib/transaction-presentation'

/** One grouped-activity row from `GET /dashboard/overview` (#3824). */
type ActivityGroup = ApiSchema<'DashboardActivityGroup'>

/**
 * The dashboard's merchant-first activity list (#3810, epic #3801).
 *
 * The rows are #3824's server-side groups (agent + counterparty + token +
 * user-local day + outcome + activityType, outbound groups split by sending
 * account too (#4117), capped at 8 over the ROLLING last
 * 7 days — 24h × 7, the owner decision #3975), so the list is: day headings,
 * one row per group, "×N" when a group bundles more than one payment. The
 * old 5-row `transactions` preview left the wire in #3858 — nothing has read
 * it since #3810.
 *
 * Two empty states (#3944). `activity.length === 0` is ambiguous — an empty
 * 7-day window is also a feed with no activity at all — so the overview
 * carries `hasOlderActivity` (any feed transaction outside the window) and
 * `activityWindowDays` (the backend's window, on the wire because this
 * component has no window constant and the copy may not hard-code a 7 that
 * can drift from `ACTIVITY_WINDOW_DAYS`). With the signal absent or false,
 * today's copy stands unchanged — an older backend renders exactly what it
 * always has. The window state implies accounts exist (the flag is derived
 * from account transactions), so its action is always the transactions page.
 *
 * The rolling window starts at an instant, not at a local midnight, so its
 * oldest day heading can cover part of a day (#3975): when the wire's
 * `activityWindowStart` cuts its own local day, the day heading carrying
 * that key reads "(partial)" — the analytics precedent
 * (`docs/product/analytics.md`), computed from the boundary instant the
 * SERVER served rather than a client clock re-derivation. Absent (an older
 * backend), no heading is ever marked.
 *
 * Merchant first means the TITLE is the counterparty — read through
 * `counterpartyLabel`'s no-address mode, so a raw address can never surface
 * here: the merchant's site for x402, the receipt/contact name the backend
 * resolved (`merchantName`), "Deposit" for inbound — or "From <account>"
 * when the money came from another of the user's own accounts (#4099) —
 * "New recipient" when
 * nothing resolves, "Agent payment" for an x402 row without a resource URL,
 * "Returned from <agent>" for sweeps. The SUBTITLE is the agent's name; on an
 * outbound row it adds "From <account>", the account the money left
 * (`fromAccountName`, #4117), when the user has several accounts — dropped
 * with exactly one (everything necessarily comes from it), and when no name
 * came back (an older backend). Inbound rows name no receiving account: a group does not carry
 * which account received, so "To My account" would be a guess — the title
 * ("Deposit", or "From <account>") and the success tone carry the
 * direction already.
 */
export function ActivitySection({
  activity,
  accountCount,
  hasAccounts,
  loading,
  unavailable,
  onRetry,
  hasOlderActivity,
  activityWindowDays,
  activityWindowStart,
}: {
  activity: ActivityGroup[]
  accountCount: number
  hasAccounts: boolean
  loading: boolean
  unavailable: boolean
  onRetry: () => void
  /** #3944 — present only on a current backend; absent keeps the "No activity yet" copy. */
  hasOlderActivity?: boolean
  /** #3944 — the backend's window (`ACTIVITY_WINDOW_DAYS`); the empty-state copy names it. */
  activityWindowDays?: number
  /** #3975 — the rolling window's start instant; marks the oldest day heading partial. */
  activityWindowStart?: string
}) {
  // The window-naming empty state needs BOTH fields: a `hasOlderActivity`
  // without its window cannot state the window it means. Both arrive
  // together from the route, so the pairing is the well-formed signal.
  const hasWindowOnlyActivity =
    hasOlderActivity === true && typeof activityWindowDays === 'number'
  const windowEmptyTitle = `No activity in the last ${activityWindowDays} days`
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
      <Card.Header
        as="h2"
        title="Activity"
        actions={
          <Link href="/transactions" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
            View all
          </Link>
        }
      />

      {loading ? (
        <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-live="polite" aria-label="Loading activity">
          {[0, 1, 2].map((item) => (
            // Same breakpoint-scoped height as the loaded row it stands in
            // for (#1833): the `sm:`-gated two-column grid pinned to 72px,
            // sizing to content below `sm`.
            <div key={item} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5 sm:py-0 sm:h-[72px]">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-[10px] bg-[var(--v2-surface-2)] animate-pulse" />
                <div>
                  <div className="h-3.5 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  <div className="mt-1.5 h-2.5 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                </div>
              </div>
              <div className="h-4 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse sm:justify-self-end" />
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="p-6">
          <EmptyState
            size="compact"
            title="Activity preview unavailable"
            body="Haven could not refresh recent payments right now."
            action={<Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
          />
        </div>
      ) : activity.length === 0 && hasWindowOnlyActivity ? (
        <div className="p-6">
          <EmptyState
            tone="brand"
            icon={<EmptyActivityIcon />}
            title={windowEmptyTitle}
            body="Payments and deposits from before this window are still on your transactions page."
            action={
              <Button href="/transactions" variant="ghost" size="sm">
                Open transactions
              </Button>
            }
          />
        </div>
      ) : activity.length === 0 ? (
        <div className="p-6">
          <EmptyState
            tone="brand"
            icon={<EmptyActivityIcon />}
            title="No activity yet"
            body={
              hasAccounts
                ? 'Receive funds or make your first payment to start building activity here.'
                : 'Create a Haven account to start tracking transactions.'
            }
            action={
              <Button
                href={hasAccounts ? '/transactions' : '/accounts'}
                variant="ghost"
                size="sm"
              >
                {hasAccounts ? 'Open transactions' : 'Go to accounts'}
              </Button>
            }
          />
        </div>
      ) : (
        <ActivityRows
          activity={activity}
          accountCount={accountCount}
          activityWindowStart={activityWindowStart}
        />
      )}
    </div>
  )
}

/**
 * Day buckets + rows. The server grouped by the USER's local day already
 * (#3824) — the client only derives each heading from the group's
 * `latestAt`, so the buckets cannot disagree with the grouping.
 *
 * The oldest heading can cover part of a day (#3975): when
 * `activityWindowStart` is present and cuts its own local day (the
 * analytics rule — a boundary that is not local midnight), the bucket whose
 * key is that day reads "(partial)". The bucket keys and the partial check
 * use the same runtime zone, so they cannot disagree.
 */
function ActivityRows({
  activity,
  accountCount,
  activityWindowStart,
}: {
  activity: ActivityGroup[]
  accountCount: number
  activityWindowStart?: string
}) {
  const partialDayKey = useMemo(() => {
    if (activityWindowStart == null || !cutsItsDay(activityWindowStart)) return null
    return localDayKey(activityWindowStart)
  }, [activityWindowStart])

  const days = useMemo(() => {
    const buckets = new Map<string, ActivityGroup[]>()
    for (const group of activity) {
      const key = localDayKey(group.latestAt)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(group)
      else buckets.set(key, [group])
    }
    return Array.from(buckets.entries(), ([key, groups]) => ({
      key,
      label: activityDayLabel(key),
      partial: key === partialDayKey,
      groups,
    }))
  }, [activity, partialDayKey])

  return (
    <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
      {days.map((day) => (
        <div key={day.key}>
          <p className="px-4 pt-3 pb-1 text-xs font-medium text-[var(--v2-ink-3)] sm:px-5">
            {day.partial ? `${day.label} (partial)` : day.label}
          </p>
          {day.groups.map((group, index) => {
            const groupKey = `${group.latestAt}-${group.to}-${group.tokenSymbol}-${index}`
            return (
              <Link key={groupKey} href="/transactions" className="block">
                <ActivityRow group={group} accountCount={accountCount} insetDivider={index > 0} />
              </Link>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function ActivityRow({
  group,
  accountCount,
  insetDivider,
}: {
  group: ActivityGroup
  accountCount: number
  /** #4165: the same-day inset hairline, on every row after a day's first. */
  insetDivider: boolean
}) {
  // The group carries the counterparty fields of its NEWEST member (#3824)
  // plus the name the backend resolved for that counterparty. No chain-scoped
  // address map exists client-side, so the resolution rides in as
  // `resolvedName`; the no-address mode guarantees the raw `to` never renders.
  // The wire serves `null` for "absent" where `AggregatedTransaction` uses
  // optional fields — mapped, not cast, so the shim stays honest.
  const counterparty: CounterpartyFields = {
    activityType: group.activityType === 'delegate_sweep' ? group.activityType : undefined,
    agentName: group.agentName ?? undefined,
    source: group.source ?? undefined,
    x402ResourceUrl: group.x402ResourceUrl ?? undefined,
    direction: group.direction,
    to: group.to,
    from: group.to,
    chainId: 0,
  }
  const title = counterpartyLabel(counterparty, undefined, undefined, {
    noAddress: true,
    resolvedName: group.merchantName,
  })

  // "×40" — and "×40+" when the count is a floor over a truncated explorer
  // window: a count is never presented as exact when it is not.
  const countLabel =
    group.count > 1 ? `×${group.count}${group.countIsFloor ? '+' : ''}` : undefined

  // Subtitle: the agent's name; "From <account>" — the account the money
  // left — appears only when the user has more than one account (see the
  // section docblock for the one-account and inbound decisions).
  const subtitleParts: string[] = []
  if (group.agentName) subtitleParts.push(group.agentName)
  if (accountCount > 1 && group.direction === 'out' && group.fromAccountName) {
    subtitleParts.push(`From ${group.fromAccountName}`)
  }
  const description = subtitleParts.length > 0 ? subtitleParts.join(' · ') : undefined

  // Amounts are #3805's currency mode: book-time `convertedAmount` or
  // serve-time `approxAmount`, and an unknown valuation renders the em dash,
  // never 0. A group serves one or the other, never both (#3824). The "≈"
  // is the one rule's answer for a list row (#4165, `shouldMarkApprox`):
  // never — the row stays plain on every surface (#3950).
  const valuation =
    group.convertedAmount != null && group.convertedCurrency
      ? { amount: Number(group.convertedAmount), currency: group.convertedCurrency, repriced: false }
      : {
          amount: group.approxAmount != null ? Number(group.approxAmount) : null,
          currency: group.approxCurrency ?? 'USD',
          repriced: true,
        }
  const fiat = {
    amount: valuation.amount,
    currency: valuation.currency,
    approx: shouldMarkApprox({
      repriced: valuation.repriced,
      chainId: null,
      tokenSymbol: group.tokenSymbol,
      displayCurrency: valuation.currency,
      kind: 'row',
    }),
  }

  return (
    <TransactionActivityRow
      title={title}
      description={description}
      value={(Number(group.sumAtomic) / 10 ** group.decimals).toString()}
      countLabel={countLabel}
      fiat={fiat}
      failed={group.status === 'failed'}
      status={statusLabel(group)}
      statusTone={statusTone(group)}
      timestamp={timeAgo(group.latestAt)}
      direction={group.direction}
      density="compact"
      insetDivider={insetDivider}
    />
  )
}

/**
 * Derived outcome → badge, only when something is off (#3897, epic #3801's
 * #3810 rule): a confirmed row carries no badge — its direction is already
 * the sign and tone of the amount — while pending and failed name the state.
 */
function statusLabel(group: ActivityGroup): string | undefined {
  if (group.status === 'failed') return 'Failed'
  if (group.status === 'pending') return 'Pending'
  return undefined
}

function statusTone(group: ActivityGroup): StatusTone | undefined {
  if (group.status === 'failed') return 'danger'
  if (group.status === 'pending') return 'warning'
  return undefined
}

function EmptyActivityIcon() {
  // Arrows-in-out icon — mirrors the sidebar's "transactions" mark so the
  // empty state belongs to the same visual family (as the old preview's did).
  return <Icon icon={ArrowLeftRight} className="w-full h-full" />
}

/** Local calendar day of an ISO instant, `YYYY-MM-DD` (en-CA's ISO format). */
function localDayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/**
 * True when the instant is not local midnight in the runtime zone — a
 * boundary that cuts its day. The analytics page applies the same rule to
 * its range edges (`SpendSection`'s `cutsItsDay`); #3975 applies it to the
 * Activity window's start so the oldest day heading can say "(partial)".
 */
function cutsItsDay(iso: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return !(get('hour') === '00' && get('minute') === '00' && get('second') === '00')
}

/**
 * Heading for a day bucket: "Today", "Yesterday", else the short date
 * ("17 May"). Derived from the group's own local day key, so a group rendered
 * under "Today" IS from today — the label and the bucket cannot drift apart
 * the way a label recomputed from the raw instant could across midnight.
 */
export function activityDayLabel(dayKey: string): string {
  const today = new Date()
  const localDay = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  if (dayKey === localDay(today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (dayKey === localDay(yesterday)) return 'Yesterday'
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric' }).format(date)
}
