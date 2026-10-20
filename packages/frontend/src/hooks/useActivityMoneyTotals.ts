'use client'

/**
 * The account Activity tab's in/out totals (#4098, epic #4093): Money in and
 * Money out for the FILTERED set the tab shows, under the same filters the
 * list and the CSV export carry.
 *
 * ## How the totals are taken
 *
 * Every FilterBar dimension rides the feed request server-side since #4095,
 * so the filtered feed the hook pages through IS the set the count line
 * counts and the export writes — no client-side filtering, and no window
 * arithmetic either: a Period or custom-range filter bounds the set ON THE
 * SERVER, so the walk simply follows the filtered feed until it ends. (This
 * is the move #4097's `useAccountMoneyFlow` docblock anticipated — its
 * client-side 30-day window read could go to #4095's filters "without
 * changing a number it reports"; on this surface the read already has.)
 *
 * The feed is served newest-first (`compareTransactions`, backend
 * `modules/transactions/ordering.ts`), so the hook pages forward at
 * `PAGE_LIMIT` until `hasMore` turns false or a page comes back empty —
 * the server has already applied every filter and the paging window.
 *
 * A row's fiat figure is the feed's own conversion (#3127): book-time
 * `convertedAmount` struck in the user's preferred currency, or a serve-time
 * `approxAmount` (#3824) when no book-time price was captured. A row priced
 * in ANOTHER currency is not summed — mixing currencies into one figure would
 * invent an exchange rate — and neither is a row with no usable price; both
 * mark the total `approx` instead, the same honesty mark the dashboard's
 * spending figure carries (#3803). FAILED rows are excluded from both
 * totals: a failed payment moved no money, and "Money out" claims what left
 * the account.
 *
 * ## Partial data
 *
 * The feed is capped at the explorer window per account (#2882), so the
 * paged walk may not reach the whole filtered set; a failed source leg is
 * unknown rather than capped. `partial` is true then, and the caller
 * renders the existing partial-data qualifier instead of letting the
 * figures claim completeness.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { transactionFeedQuery } from '@/hooks/useTransactionsFeed'
import type { AmountCurrency } from '@/components/haven/Amount'
import type { AggregatedTransaction, TransactionFilterState, TransactionsFeedResponse } from '@/types/transactions'

const PAGE_LIMIT = 100

export interface ActivityMoneyTotals {
  moneyIn: number
  moneyOut: number
  /**
   * True when at least one row in the filtered set was priced at serve time,
   * in another currency, or not at all — the totals then carry the `≈` mark,
   * never a bare figure claiming exactness.
   */
  approx: boolean
  loading: boolean
  error: string | null
  /**
   * True when the walk could not cover the whole filtered set: the feed was
   * truncated at its explorer cap, or a source failed part-way. The caller
   * shows the partial-data indicator rather than letting the totals claim
   * completeness.
   */
  partial: boolean
  /** Re-read the filtered set (after a send, a filter change, or a retry). */
  refresh: () => Promise<void>
}

interface FlowTotals {
  moneyIn: number
  moneyOut: number
  approx: boolean
  partial: boolean
}

/**
 * One row's contribution to a direction total, priced like the feed prices
 * it — the same rules `useAccountMoneyFlow` sums the 30-day window by
 * (#4097), so the account page's two money figures cannot disagree about
 * what a row is worth. Book-time first (#3127); a foreign-currency triple
 * is not silently summed.
 */
function rowFiat(
  tx: AggregatedTransaction,
  currency: AmountCurrency,
): { amount: number; approx: boolean } | null {
  if (tx.convertedAmount != null && tx.convertedCurrency === currency) {
    const amount = Number(tx.convertedAmount)
    if (Number.isFinite(amount)) return { amount, approx: false }
  }
  // Serve-time (#3824): today's rate, marked. `approxCurrency` is the
  // backend's documented default when a producer omits it beside a present
  // amount, so it matches the display currency unless the row says otherwise.
  if (tx.approxAmount != null && (tx.approxCurrency ?? currency) === currency) {
    const amount = Number(tx.approxAmount)
    if (Number.isFinite(amount)) return { amount, approx: true }
  }
  // No usable price in the display currency: the row exists in the filtered
  // set but adds no claimed figure — and the total must not claim exactness.
  return null
}

/** Sum one page's rows into the running totals. */
function sumPage(
  rows: readonly AggregatedTransaction[],
  currency: AmountCurrency,
  totals: FlowTotals,
): void {
  for (const tx of rows) {
    // A failed payment moved no money; the totals claim what actually moved.
    if (tx.isError) continue
    const fiat = rowFiat(tx, currency)
    if (!fiat) {
      totals.approx = true
      continue
    }
    if (fiat.approx) totals.approx = true
    if (tx.direction === 'in') totals.moneyIn += fiat.amount
    else if (tx.direction === 'out') totals.moneyOut += fiat.amount
  }
}

export function useActivityMoneyTotals(
  filters: TransactionFilterState,
  currency: AmountCurrency,
): ActivityMoneyTotals {
  const [totals, setTotals] = useState<FlowTotals>({ moneyIn: 0, moneyOut: 0, approx: false, partial: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const fetchTotals = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    const next: FlowTotals = { moneyIn: 0, moneyOut: 0, approx: false, partial: false }
    try {
      let offset = 0
      // Page until the FILTERED feed ends. The server applied every filter
      // dimension before paging (#4095), so the walk sees exactly the set
      // the count line and the export describe. A truncated feed never
      // reaches further back (#2882) — that is what `partial` reports.
      for (;;) {
        const data = await api.get<TransactionsFeedResponse>(
          `/transactions?${transactionFeedQuery(filters, offset, PAGE_LIMIT)}`,
        )
        if (requestId !== requestIdRef.current) return
        const rows = data.transactions ?? []
        if (data.truncated) next.partial = true
        if (data.partialFailure) next.partial = true
        sumPage(rows, currency, next)
        if (rows.length === 0 || !data.hasMore) break
        offset += rows.length
      }
      setTotals(next)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      // Keep the LAST good totals visible; the error is the tab's retry
      // story, never a silent zeroing of figures that were true a moment ago.
      setError(err instanceof Error ? err.message : 'Failed to load the totals')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [filters, currency])

  useEffect(() => {
    void fetchTotals()
    return () => {
      requestIdRef.current += 1
    }
  }, [fetchTotals])

  return {
    moneyIn: totals.moneyIn,
    moneyOut: totals.moneyOut,
    approx: totals.approx,
    loading,
    error,
    partial: totals.partial,
    refresh: fetchTotals,
  }
}
