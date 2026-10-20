'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { TransactionsFeedResponse } from '@/types/transactions'

interface Options {
  /** True when the page's list is narrowed by any filter. */
  filtered: boolean
  /** The feed's own server `total` for the scope it fetched. */
  feedTotal: number
  /** The feed is loading a new scope; its `total` is not an answer yet. */
  feedLoading: boolean
}

/**
 * The server's count of ALL transactions, for the filtered count's
 * "{shown} of {total}" (#4111, the list-controls count rule in
 * `components/ui/list-controls-copy.ts`): on a server-paged list both
 * numbers are server figures, never loaded rows against a server total.
 *
 * Unfiltered, the feed's own `total` IS that number, and nothing extra is
 * fetched. Filtered, one `limit=1` read with no filters asks for it, each
 * time the filtered feed settles on a total: once per filter change, and
 * again when a poll moves the total — a new payment that matches the filter
 * must move the denominator too, or the count reads "26 of 25". Nothing is
 * read while the feed is loading, so the reset to 0 between scopes costs no
 * request. The read is an ordinary cached one: the server caches per account,
 * before filtering. What keeps that cache fresh is the feed's poll — but its
 * `fresh=1` refreshes only the accounts IN THE REQUEST'S SCOPE: only an
 * Account filter narrows `accounts` before `aggregateAccountTransactions`
 * runs, so on any other filter every account's entry ages out with the 30 s
 * TTL. That cannot read short: a narrowed account was just refreshed by the
 * same poll. The last known figure stays up while a read is in flight.
 *
 * `null` means unknown: before the first answer, after a failed read, and
 * when the read reports a partial failure (its total would be short). The
 * count then shows its loading state rather than a figure it cannot back.
 */
export function useUnfilteredTransactionTotal({
  filtered,
  feedTotal,
  feedLoading,
}: Options): number | null {
  const [fetchedTotal, setFetchedTotal] = useState<number | null>(null)

  useEffect(() => {
    if (!filtered) {
      setFetchedTotal(null)
      return
    }
    if (feedLoading) return
    let cancelled = false
    api
      .get<TransactionsFeedResponse>('/transactions?offset=0&limit=1')
      .then((data) => {
        if (cancelled) return
        setFetchedTotal(data.partialFailure ? null : (data.total ?? 0))
      })
      .catch(() => {
        if (!cancelled) setFetchedTotal(null)
      })
    return () => {
      cancelled = true
    }
  }, [filtered, feedTotal, feedLoading])

  return filtered ? fetchedTotal : feedTotal
}
