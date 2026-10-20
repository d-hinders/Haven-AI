/**
 * Holdings rules for the account page's summary card (#4097, epic #4093).
 *
 * The owner decisions, from the 2026-10-19 mockup review:
 *
 * - Holdings ALWAYS shows the token and its full-precision amount (this
 *   supersedes #4021's two-or-more rule for the detail page: only the VALUE
 *   column follows it, the token row never hides behind it).
 * - One token shows NO value: it would repeat the balance figure beside it.
 * - When the display currency is not USD, the single-token case shows the
 *   RATE instead ("1 USDC = 9,50 kr") — the one figure a conversion adds
 *   that the balance does not already say.
 * - Two or more tokens each show their value.
 *
 * The freshness markers (#3295) are NOT decided here: the caller keeps
 * rendering `BalanceFreshnessIndicator` beside whatever these helpers
 * produce, exactly as the old token table did.
 */
import type { PortfolioBreakdown } from '@/types/transactions'
import { nonZeroBreakdown } from '@/lib/portfolio-breakdown'
import { formatFiat } from '@/lib/format'

/** The display currency, as `usePreferences` and `formatFiat` spell it. */
export type DisplayCurrency = 'USD' | 'EUR' | 'SEK'

/** One token's Holdings row: the amount, plus a value or a rate, never both. */
export interface HoldingRow {
  symbol: string
  /** Full-precision human amount, exactly as the portfolio wire formatted it. */
  amount: string
  /**
   * The token's value in the display currency, or `null` when the rules
   * above hold it back (single token). A held-but-unpriced token keeps its
   * wire value — unpriced is not worthless, and the balance's own degraded
   * marker already says the read is partial.
   */
  value: number | null
  /**
   * The implied `1 <symbol> = <rate>` rate when the single-token case shows
   * the rate instead of a value, `null` otherwise (and when no rate can be
   * computed from an unpriced or zero-amount read).
   */
  rate: number | null
  /** The row's degraded-read marker, passed straight through to the caller. */
  balanceFreshness?: PortfolioBreakdown['balanceFreshness']
}

/**
 * The display currency's value of one breakdown item.
 */
function fiatValueOf(item: PortfolioBreakdown, currency: DisplayCurrency): number {
  if (currency === 'EUR') return item.eurValue
  if (currency === 'SEK') return item.sekValue ?? 0
  return item.usdValue
}

/**
 * The token→currency rate implied by a priced holding, or `null` when the
 * amount or the value is unusable (unpriced, zero amount, a malformed
 * precision string). A zero rate is never shown: a rate of 0 says "worth
 * nothing", which an unpriced read is not.
 */
function impliedRate(item: PortfolioBreakdown, currency: DisplayCurrency): number | null {
  const value = fiatValueOf(item, currency)
  const amount = Number.parseFloat(item.formatted)
  if (!Number.isFinite(value) || !Number.isFinite(amount) || amount <= 0) {
    return null
  }
  const rate = value / amount
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

/**
 * The Holdings column's rows, applying the owner rules above to the
 * portfolio breakdown. Zero-raw-balance filler rows are hidden by the shared
 * `nonZeroBreakdown` predicate (#4021 — a filler ETH 0 renders nowhere),
 * which on this page is also the "holds money" signal for the header's
 * Send/Receive primacy.
 */
export function holdingRows(
  breakdown: readonly PortfolioBreakdown[],
  currency: DisplayCurrency,
): HoldingRow[] {
  const visible = nonZeroBreakdown(breakdown)
  const single = visible.length === 1
  return visible.map((item) => ({
    symbol: item.symbol,
    amount: item.formatted,
    // One token: no value (it repeats the balance). The rate shows instead
    // only when the display currency is not USD — a USD user holding a
    // USD-pegged token would read the same figure twice.
    value: single ? null : fiatValueOf(item, currency),
    rate: single && currency !== 'USD' ? impliedRate(item, currency) : null,
    ...(item.balanceFreshness ? { balanceFreshness: item.balanceFreshness } : {}),
  }))
}

/** "1 USDC = 9,50 kr" — the rate line, rendered only for a computable rate. */
export function holdingRateLine(row: HoldingRow, currency: DisplayCurrency): string | null {
  if (row.rate == null) return null
  return `1 ${row.symbol} = ${formatFiat(row.rate, currency)}`
}
