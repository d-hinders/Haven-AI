'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { TransactionsFeedResponse } from '@/types/transactions'

interface Options {
  /** True when the page's list is narrowed by any filter. */
  filtered: boolean
  /** The feed's own server `total` for the scope it fetched. */
  feedTotal: number
  /** Changes with the filters; the figure is re-read when it does. */
  retryKey: string
}

/**
 * The server's count of ALL transactions, for the filtered count's
 * "{shown} of {total}" (#4111, the list-controls count rule in
 * `components/ui/list-controls-copy.ts`): on a server-paged list both
 * numbers are server figures, never loaded rows against a server total.
 *
 * Unfiltered, the feed's own `total` IS that number, and nothing extra is
 * fetched. Filtered, one `limit=1` read with no filters asks for it. It is
 * read again whenever the filtered feed's total moves — the feed polls, so a
 * new payment that matches the filter must move the denominator too, or the
 * count reads "26 of 25" — and on every filter change. Re-reads after the
 * first pass `fresh=1`, the cache bypass the feed's own poll uses. The last
 * known figure stays up while a re-read is in flight. (The feed's total is
 * never reused for it: for one render after a filter change it still
 * describes the previous scope.)
 *
 * `null` means unknown: before the first answer, after a failed read, and
 * when the read reports a partial failure (its total would be short). The
 * count then shows its loading state rather than a figure it cannot back.
 */
export function useUnfilteredTransactionTotal({
  filtered,
  feedTotal,
  retryKey,
}: Options): number | null {
  const [fetchedTotal, setFetchedTotal] = useState<number | null>(null)
  const hasRead = useRef(false)

  useEffect(() => {
    if (!filtered) {
      hasRead.current = false
      setFetchedTotal(null)
      return
    }
    let cancelled = false
    const query = hasRead.current ? 'offset=0&limit=1&fresh=1' : 'offset=0&limit=1'
    hasRead.current = true
    api
      .get<TransactionsFeedResponse>(`/transactions?${query}`)
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
  }, [filtered, feedTotal, retryKey])

  return filtered ? fetchedTotal : feedTotal
}
