'use client'

import type { ReactNode } from 'react'
import type { ApiSchema } from '@haven_ai/core'
import { timeAgo } from '@/lib/format'

/**
 * The additive balance-freshness marker from the wire (#3295). Present on a
 * balance/portfolio entry only when that entry's on-chain read FAILED:
 * `stale` = the served figure is the last successfully read balance, `asOf`
 * says when it was read; `unavailable` = no balance has ever been read for
 * this token, so the accompanying balance string is a filler, not a figure.
 * Absent on a clean read — which is how this stays additive for every
 * existing consumer.
 */
export type BalanceFreshness = ApiSchema<'BalanceFreshness'>

/**
 * The subtle stale indicator (#3295). A failed on-chain read no longer reads
 * as a real zero: the backend serves the last successfully read balance
 * marked `stale` (with its as-of time), or `unavailable` when nothing was
 * ever read. This renders that marker: a small amber "as of 5m ago" beside
 * the served figure — a quiet timestamp, not an alarm — and "Unavailable"
 * when no value is known. Renders nothing on a fresh entry, so a clean
 * screen is byte-identical to the pre-#3295 one.
 *
 * `compact` fits the per-token rows on /accounts and the account detail
 * table; the default size reads at the dashboard hero's headline scale.
 */
export function BalanceFreshnessIndicator({
  freshness,
  size = 'compact',
}: {
  freshness: BalanceFreshness
  size?: 'default' | 'compact'
}) {
  if (freshness.status === 'unavailable') {
    return (
      <span
        role="status"
        className={`inline-flex items-center whitespace-nowrap font-medium text-[var(--v2-warning)] ${size === 'compact' ? 'text-xs' : 'text-sm'}`}
      >
        Unavailable
      </span>
    )
  }
  return (
    <span
      role="status"
      title={new Date(freshness.asOf).toLocaleString()}
      className={`inline-flex items-center whitespace-nowrap font-medium text-[var(--v2-warning)] ${size === 'compact' ? 'text-xs' : 'text-sm'}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block rounded-full bg-[var(--v2-warning)] ${size === 'compact' ? 'h-1.5 w-1.5' : 'h-2 w-2'}`}
      />
      <span className="ml-1.5">as of {timeAgo(freshness.asOf)}</span>
    </span>
  )
}

/**
 * Renders its children when the marker is present, so a screen can attach
 * the indicator to a figure without each call site branching on the marker.
 */
export function WhenBalanceDegraded({
  freshness,
  children,
}: {
  freshness: BalanceFreshness | undefined
  children: ReactNode
}) {
  return freshness ? <>{children}</> : null
}
