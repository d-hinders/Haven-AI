'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiPaths } from '@haven_ai/core'
import { api } from '@/lib/api'

// Wire shapes are the generated ones (#2869) — this hook only adds loading
// state. `GET /accounting/feed/status` is the ONE answer the feed page, the
// sidebar badge and the Settings card's off state all read.
export type AccountingFeedStatus =
  ApiPaths['/accounting/feed/status']['get']['responses']['200']['content']['application/json']
export type AccountingSync = AccountingFeedStatus['syncs'][number]
export type AccountingSyncStatus = AccountingSync['status']
export type AccountingFeedDestination = NonNullable<AccountingFeedStatus['destination']>
export type AccountingVerification =
  ApiPaths['/accounting/feed/verify/{paymentId}']['get']['responses']['200']['content']['application/json']

/**
 * The two OFF states, which render two different copies and must never be
 * confused (owner decision 2026-09-11, #2869):
 *
 *   - `coming_soon`  — `hosted && !enabled`: the hosted Haven with the flag
 *     off. Visible in production as "Coming soon"; exposure is a new manual
 *     decision.
 *   - `self_hosted`  — `!hosted`: a self-hosted box. The feed is a hosted
 *     add-on, so it is "not available on self-hosted" — never coming soon.
 *
 * `null` is "the flag is on" (the page then branches on `available`).
 * `hosted` wins over `enabled`: a self-hosted box with the flag set is still
 * self-hosted, which is also what the backend's availability check does.
 */
export type AccountingFeedOffState = 'coming_soon' | 'self_hosted'

export function accountingFeedOffState(
  status: Pick<AccountingFeedStatus, 'hosted' | 'enabled'> | null | undefined,
): AccountingFeedOffState | null {
  if (!status) return null
  if (!status.hosted) return 'self_hosted'
  if (!status.enabled) return 'coming_soon'
  return null
}

/** The destination statuses that need the user's hand — a Reconnect in Settings. */
export const ATTENTION_STATUSES: ReadonlyArray<AccountingFeedDestination['status']> = [
  'needs_reauthorisation',
  'scope_missing',
  'revoked_at_provider',
]

/**
 * Whether the sidebar shows its attention badge (#2869): the destination
 * needs a reconnect, or the retry sweep has given up on at least one row
 * (`counts.exhausted`, #2866). Nothing else — a retryable failure is the
 * sweep's job, not the user's.
 */
export function accountingNeedsAttention(
  status: Pick<AccountingFeedStatus, 'available' | 'destination' | 'counts'> | null | undefined,
): boolean {
  if (!status || !status.available) return false
  if (status.destination && ATTENTION_STATUSES.includes(status.destination.status)) return true
  return status.counts.exhausted > 0
}

export function useAccountingFeed() {
  const [status, setStatus] = useState<AccountingFeedStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<AccountingFeedStatus>('/accounting/feed/status')
      if (!isCancelled()) setStatus(res)
    } catch {
      if (!isCancelled()) setError('We could not load accounting status. Try again in a moment.')
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  const sync = useCallback(async () => {
    await api.post('/accounting/feed/sync')
    await load()
  }, [load])

  // #1362: read-back verification against Fortnox's own records — does the
  // pushed invoice exist, and has a human booked it (voucher assigned)?
  const verify = useCallback(async (paymentId: string) => {
    return api.get<AccountingVerification>(`/accounting/feed/verify/${encodeURIComponent(paymentId)}`)
  }, [])

  // #1365: verification-gated reopen — the server re-checks Fortnox and only
  // flips a pushed row back to retryable when the invoice is confirmed gone.
  const reopen = useCallback(async (paymentId: string) => {
    await api.post(`/accounting/feed/reopen/${encodeURIComponent(paymentId)}`)
    await load()
  }, [load])

  return { status, loading, error, refetch: () => load(), sync, verify, reopen }
}
