'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import type { ApiSchema } from '@haven_ai/core'
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
 * Replaces the old 5-row `transactions` preview (still on the wire until the
 * follow-up removes it — the dashboard no longer reads it). The rows are
 * #3824's server-side groups (agent + counterparty + token + user-local day
 * + outcome + activityType, capped at 8 over the last 7 local days), so the
 * list is: day headings, one row per group, "×N" when a group bundles more
 * than one payment.
 *
 * Merchant first means the TITLE is the counterparty — read through
 * `counterpartyLabel`'s no-address mode, so a raw address can never surface
 * here: the merchant's site for x402, the receipt/contact name the backend
 * resolved (`merchantName`), "Deposit" for inbound, "New recipient" when
 * nothing resolves, "Agent payment" for an x402 row without a resource URL,
 * "Returned from <agent>" for sweeps. The SUBTITLE is the agent's name; the
 * movement's "From My account" half is dropped when the user has exactly one
 * account (everything necessarily comes from it) and shown when there are
 * several. Inbound rows name no origin: a group does not carry which account
 * received, so "To My account" would be a guess — the "Deposit" title and
 * the success tone carry the direction already.
 */
export function ActivitySection({
  activity,
  accountCount,
  hasAccounts,
  loading,
  unavailable,
  onRetry,
}: {
  activity: ActivityGroup[]
  accountCount: number
  hasAccounts: boolean
  loading: boolean
  unavailable: boolean
  onRetry: () => void
}) {
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
        <ActivityRows activity={activity} accountCount={accountCount} />
      )}
    </div>
  )
}

/**
 * Day buckets + rows. The server grouped by the USER's local day already
 * (#3824) — the client only derives each heading from the group's
 * `latestAt`, so the buckets cannot disagree with the grouping.
 */
function ActivityRows({
  activity,
  accountCount,
}: {
  activity: ActivityGroup[]
  accountCount: number
}) {
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
      groups,
    }))
  }, [activity])

  return (
    <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
      {days.map((day) => (
        <div key={day.key}>
          <p className="px-4 pt-3 pb-1 text-xs font-medium text-[var(--v2-ink-3)] sm:px-5">
            {day.label}
          </p>
          {day.groups.map((group, index) => {
            const groupKey = `${group.latestAt}-${group.to}-${group.tokenSymbol}-${index}`
            return (
              <Link key={groupKey} href="/transactions" className="block">
                <ActivityRow group={group} accountCount={accountCount} />
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
}: {
  group: ActivityGroup
  accountCount: number
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

  // Subtitle: the agent's name; "From My account" appears only when the user
  // has more than one account (see the section docblock for the one-account
  // and inbound decisions).
  const subtitleParts: string[] = []
  if (group.agentName) subtitleParts.push(group.agentName)
  if (accountCount > 1 && group.direction === 'out') subtitleParts.push('From My account')
  const description = subtitleParts.length > 0 ? subtitleParts.join(' · ') : undefined

  // Amounts are #3805's currency mode: book-time `convertedAmount` plain,
  // serve-time `approxAmount` with "≈" — and an unknown valuation renders
  // the em dash, never 0. A group serves one or the other, never both
  // (#3824).
  const fiat =
    group.convertedAmount != null && group.convertedCurrency
      ? {
          amount: Number(group.convertedAmount),
          currency: group.convertedCurrency,
          approx: false,
        }
      : {
          amount: group.approxAmount != null ? Number(group.approxAmount) : null,
          currency: group.approxCurrency ?? 'USD',
          approx: true,
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
    />
  )
}

/**
 * Derived outcome → badge. Confirmed rows read like the old preview did
 * ("Sent"/"Received" by direction); pending and failed name the state —
 * the amounts stay unsigned facts, the tone carries the verdict.
 */
function statusLabel(group: ActivityGroup): string {
  if (group.status === 'failed') return 'Failed'
  if (group.status === 'pending') return 'Pending'
  return group.direction === 'in' ? 'Received' : 'Sent'
}

function statusTone(group: ActivityGroup): StatusTone {
  if (group.status === 'failed') return 'danger'
  if (group.status === 'pending') return 'warning'
  return group.direction === 'in' ? 'success' : 'neutral'
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
