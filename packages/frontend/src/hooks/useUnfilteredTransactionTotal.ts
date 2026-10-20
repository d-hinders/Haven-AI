'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { TransactionsFeedResponse } from '@/types/transactions'

interface Options {
  /** True when the page's list is narrowed by any filter. */
  filtered: boolean
  /** The feed's own server `total` for the scope it fetched. */
  feedTotal: number
  /** Changes with the filters; a failed read is retried when it does. */
  retryKey: string
}

/**
 * The server's count of ALL transactions, for the filtered count's
 * "{shown} of {total}" (#4111, the list-controls count rule in
 * `components/ui/list-controls-copy.ts`): on a server-paged list both
 * numbers are server figures, never loaded rows against a server total.
 *
 * Unfiltered, the feed's own `total` IS that number, and nothing extra is
 * fetched. Once filtered, one `limit=1` read with no filters asks for it,
 * kept while the list stays filtered and dropped when it is cleared, so the
 * next filtered view reads a fresh figure. (The feed's total is not reused
 * for it: for one render after a filter change it still describes the
 * previous scope.) A failed read answers `null` and is retried on the next
 * filter change, so the count shows its loading state rather than a figure
 * it cannot back.
 */
export function useUnfilteredTransactionTotal({
  filtered,
  feedTotal,
  retryKey,
}: Options): number | null {
  const [fetchedTotal, setFetchedTotal] = useState<number | null>(null)

  useEffect(() => {
    if (!filtered) setFetchedTotal(null)
  }, [filtered])

  useEffect(() => {
    if (!filtered || fetchedTotal !== null) return
    let cancelled = false
    api
      .get<TransactionsFeedResponse>('/transactions?offset=0&limit=1')
      .then((data) => {
        if (!cancelled) setFetchedTotal(data.total ?? 0)
      })
      .catch(() => {
        // Stays null: the count shows its loading state, never a guess.
      })
    return () => {
      cancelled = true
    }
  }, [filtered, fetchedTotal, retryKey])

  return filtered ? fetchedTotal : feedTotal
}
