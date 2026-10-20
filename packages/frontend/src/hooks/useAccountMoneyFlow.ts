'use client'

/**
 * The account page's "Last 30 days" figures (#4097, epic #4093): Money in
 * and Money out, the totals of the account's transaction feed filtered to
 * the ROLLING window `[now − 30×24h, now)` and to one direction each — the
 * owner's window rule from epic #3801 (rolling days, no calendar month).
 *
 * ## How the totals are taken
 *
 * The feed is served newest-first (`compareTransactions`, backend
 * `modules/transactions/ordering.ts`), so the hook pages forward and STOPS
 * at the window boundary: once a page's oldest row predates the window,
 * every later page is strictly older and no in-window row can follow. This
 * is the same set a server-side direction+date filter over the feed would
 * return, computed client-side because #4095's server-side filter
 * dimensions had not landed when this slice was built. When #4098 rebuilds
 * the Activity tab on those filters, this hook can move its window read to
 * them without changing a number it reports.
 *
 * A row is priced and summed by `lib/money-flow-tally.ts` (#4165), the one
 * tally this hook shares with the Activity tab's result line: `approx` is
 * the "≈" rule's answer for a total, `unpriced` says some rows could not be
 * valued, and a direction with nothing priceable totals `null` ("—"). FAILED
 * rows are excluded: a failed payment moved no money.
 *
 * ## Partial data
 *
 * The feed is capped at the explorer window per account (#2882), so the
 * paged-in set may not reach back through the full 30 days. `partial` is
 * true then (or when any per-source read failed), and the caller renders
 * the existing partial-data qualifier instead of letting the figures claim
 * completeness.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { AggregatedTransaction, TransactionsFeedResponse } from '@/types/transactions'
import type { DisplayCurrency } from '@/lib/account-holdings'
import { emptyFlowTally, flowFigures, tallyRow, type FlowTally } from '@/lib/money-flow-tally'

/** The rolling window's length, in days (the owner's #3801 rule). */
export const MONEY_FLOW_WINDOW_DAYS = 30

const PAGE_LIMIT = 100
const WINDOW_SECONDS = MONEY_FLOW_WINDOW_DAYS * 24 * 60 * 60

export interface AccountMoneyFlow {
  /** null when the window had inbound rows and none could be valued ("—"). */
  moneyIn: number | null
  moneyOut: number | null
  /** The "≈" decision for the totals (`shouldMarkApprox`, kind `total`). */
  approx: boolean
  /** Some in-window rows could not be valued; the caller says so in words. */
  unpriced: boolean
  loading: boolean
  error: string | null
  /**
   * True when the rows these totals were summed from may not cover the whole
   * 30-day window: the feed was truncated at its explorer cap, or a source
   * failed part-way. The caller shows the partial-data indicator.
   */
  partial: boolean
  /** Re-read the window (after a send, or a retry). */
  refresh: () => Promise<void>
}

interface FlowTotals {
  tally: FlowTally
  partial: boolean
}

function emptyTotals(): FlowTotals {
  return { tally: emptyFlowTally(), partial: false }
}

/**
 * Tally one page's in-window rows. Rows strictly older than the window are
 * skipped but still observed by the caller's stop rule.
 */
function sumPage(
  rows: readonly AggregatedTransaction[],
  windowStartSec: number,
  currency: DisplayCurrency,
  totals: FlowTotals,
): void {
  for (const tx of rows) {
    if (tx.timestamp < windowStartSec) continue
    tallyRow(tx, currency, totals.tally)
  }
}

export function useAccountMoneyFlow(
  accountId: string | undefined,
  currency: DisplayCurrency,
): AccountMoneyFlow {
  const [totals, setTotals] = useState<FlowTotals>(emptyTotals)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const fetchWindow = useCallback(async () => {
    if (!accountId) {
      setTotals(emptyTotals())
      setLoading(false)
      setError(null)
      return
    }
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    // The window is struck per fetch, not per mount: the figures describe
    // the LAST 30 days of whatever now is, including the row a send just
    // added (the send path calls `refresh` on success).
    const windowStartSec = Math.floor(Date.now() / 1000) - WINDOW_SECONDS
    const next = emptyTotals()
    try {
      let offset = 0
      // Page until the feed ends, a page tells us the window is fully
      // covered, or the feed itself is capped with more to come (a
      // truncated feed never reaches further back; #2882).
      for (;;) {
        const data = await api.get<TransactionsFeedResponse>(
          `/transactions?accountId=${encodeURIComponent(accountId)}&offset=${offset}&limit=${PAGE_LIMIT}`,
        )
        if (requestId !== requestIdRef.current) return
        const rows = data.transactions ?? []
        if (data.truncated) next.partial = true
        if (data.partialFailure) next.partial = true
        sumPage(rows, windowStartSec, currency, next)
        if (rows.length === 0 || !data.hasMore) break
        const oldest = rows[rows.length - 1].timestamp
        if (oldest < windowStartSec) break
        offset += rows.length
      }
      setTotals(next)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      // Keep the LAST good totals visible; the error is the page's retry
      // story, never a silent zeroing of figures that were true a moment ago.
      setError(err instanceof Error ? err.message : 'Failed to load the last 30 days')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [accountId, currency])

  useEffect(() => {
    void fetchWindow()
    return () => {
      requestIdRef.current += 1
    }
  }, [fetchWindow])

  return {
    ...flowFigures(totals.tally),
    loading,
    error,
    partial: totals.partial,
    refresh: fetchWindow,
  }
}
