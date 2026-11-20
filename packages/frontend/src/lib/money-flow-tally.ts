/**
 * The Money in / Money out tally both account-page totals share (#4165): the
 * 30-day summary (`useAccountMoneyFlow`, #4097) and the Activity tab's
 * filtered result line (`useActivityMoneyTotals`, #4098). One definition, so
 * the page's two money figures cannot disagree about what a row is worth.
 *
 * A row's figure is the feed's own conversion (#3127): book-time
 * `convertedAmount` struck in the display currency, or a serve-time
 * `approxAmount` (#3824) when no book-time price was captured. FAILED rows
 * are skipped: a failed payment moved no money, and "Money out" claims what
 * left the account.
 *
 * Two signals, kept apart since #4165:
 *
 * - **`approxIn` / `approxOut` are "converted"**, the one rule's answer for each total
 *   (`shouldMarkApprox` in `@haven_ai/core`): a summed row priced at today's
 *   rate where the conversion changes the number. USDC in USD never marks it.
 * - **`unpriced` is "couldn't be valued"**: a row with no usable price in the
 *   display currency (no price at all, or priced in another currency — mixing
 *   currencies would invent an exchange rate). It adds nothing to the sum, and
 *   the caller says so in words instead of hanging a "≈" on the figure. A
 *   direction whose rows ALL lack a price totals `null`, which `<Amount>`
 *   renders as "—": an unknown total is never "$0.00".
 */
import { shouldMarkApprox } from '@haven_ai/core'
import type { AmountCurrency } from '@/components/haven/Amount'
import type { AggregatedTransaction } from '@/types/transactions'

export interface FlowTally {
  moneyIn: number
  moneyOut: number
  pricedIn: number
  pricedOut: number
  unpricedIn: number
  unpricedOut: number
  approxIn: boolean
  approxOut: boolean
  /**
   * #5001: the sales part of In — the inbound rows carrying #5000's sale
   * marker. It is a SUBSET of `moneyIn`, not a third direction: the
   * Transactions page renders it alone under Direction: Sales, and beside In
   * under Direction: Incoming. Its own fields, so its "≈" and its "—" are
   * decided by its own rows.
   */
  moneySales: number
  pricedSales: number
  unpricedSales: number
  approxSales: boolean
}

export function emptyFlowTally(): FlowTally {
  return {
    moneyIn: 0,
    moneyOut: 0,
    pricedIn: 0,
    pricedOut: 0,
    unpricedIn: 0,
    unpricedOut: 0,
    approxIn: false,
    approxOut: false,
    moneySales: 0,
    pricedSales: 0,
    unpricedSales: 0,
    approxSales: false,
  }
}

/** One row's figure in the display currency, or null when it has none. */
function rowFiat(
  tx: AggregatedTransaction,
  currency: AmountCurrency,
): { amount: number; repriced: boolean } | null {
  if (tx.convertedAmount != null && tx.convertedCurrency === currency) {
    const amount = Number(tx.convertedAmount)
    if (Number.isFinite(amount)) return { amount, repriced: false }
  }
  // `approxCurrency` is the backend's documented default when a producer
  // omits it beside a present amount, so it matches the display currency
  // unless the row says otherwise.
  if (tx.approxAmount != null && (tx.approxCurrency ?? currency) === currency) {
    const amount = Number(tx.approxAmount)
    if (Number.isFinite(amount)) return { amount, repriced: true }
  }
  return null
}

/**
 * Add one row to the tally; failed rows are skipped, and so is a folded move
 * between the user's own accounts (#4266): it left one account and entered
 * another, so it is neither money in nor money out of the wallet set.
 */
export function tallyRow(tx: AggregatedTransaction, currency: AmountCurrency, tally: FlowTally): void {
  if (tx.isError) return
  if (tx.ownTransfer) return
  const inbound = tx.direction === 'in'
  // #5001: a sale is inbound money carrying #5000's marker. It counts in In
  // AND in the sales part — the part is a subset, never a third direction.
  const sale = tx.sale !== undefined
  const fiat = rowFiat(tx, currency)
  if (!fiat) {
    if (inbound) tally.unpricedIn += 1
    else tally.unpricedOut += 1
    if (sale) tally.unpricedSales += 1
    return
  }
  if (inbound) {
    tally.moneyIn += fiat.amount
    tally.pricedIn += 1
  } else {
    tally.moneyOut += fiat.amount
    tally.pricedOut += 1
  }
  if (sale) {
    tally.moneySales += fiat.amount
    tally.pricedSales += 1
  }
  if (
    shouldMarkApprox({
      repriced: fiat.repriced,
      chainId: tx.chainId,
      tokenSymbol: tx.tokenSymbol ?? tx.asset,
      displayCurrency: currency,
      kind: 'total',
    })
  ) {
    // Per direction: a direction that converted nothing (an empty "Money in"
    // beside re-priced outflows) must not read "≈ 0,00 kr".
    if (inbound) tally.approxIn = true
    else tally.approxOut = true
    // The sales part follows the same rule through its own flag.
    if (sale) tally.approxSales = true
  }
}

export interface FlowFigures {
  /** null when the direction had rows and none of them could be valued. */
  moneyIn: number | null
  moneyOut: number | null
  /** #5001: the sales part of In; null when it had sale rows and none could be valued. */
  moneySales: number | null
  /** The "≈" decision per total — set only when THAT direction summed a converted row. */
  approxIn: boolean
  approxOut: boolean
  /** #5001: the sales part's own "≈" decision. */
  approxSales: boolean
  /** True when at least one row could not be valued and is not in a sum. */
  unpriced: boolean
  /**
   * #5001: at least one sale row is in the set — unpriced ones included. It
   * is a count of rows, never a test for a non-zero sum.
   */
  salesPresent: boolean
}

export function flowFigures(tally: FlowTally): FlowFigures {
  return {
    moneyIn: tally.unpricedIn > 0 && tally.pricedIn === 0 ? null : tally.moneyIn,
    moneyOut: tally.unpricedOut > 0 && tally.pricedOut === 0 ? null : tally.moneyOut,
    moneySales: tally.unpricedSales > 0 && tally.pricedSales === 0 ? null : tally.moneySales,
    approxIn: tally.approxIn,
    approxOut: tally.approxOut,
    approxSales: tally.approxSales,
    unpriced: tally.unpricedIn + tally.unpricedOut > 0,
    salesPresent: tally.pricedSales + tally.unpricedSales > 0,
  }
}

/**
 * The explicit "partly unpriced" line, said in words rather than by a "≈" —
 * under the account page's totals and the dashboard's 30-day spend alike.
 */
export const UNPRICED_TOTALS_NOTE = 'Some amounts couldn’t be valued and aren’t included.'
