/**
 * Shared token-breakdown predicates for the two balance surfaces (#4021).
 *
 * `derivePortfolio` (backend `modules/accounts/portfolio.ts`) emits EVERY
 * registry token, native first — a token that has never been read arrives as
 * filler `balance: '0'` with `balanceFreshness.status: 'unavailable'`. Both
 * `/accounts` and `/accounts/<id>` therefore hide rows on the RAW `balance`,
 * never the fiat value: a held but unpriced token has fiat 0 and must still
 * render. The freshness markers keep reading the FULL breakdown, so hiding an
 * unavailable filler row never drops the total's "Unavailable" marker (#3295).
 */

/**
 * Exact zero test on the atomic decimal string. BigInt is exact; the catch
 * keeps a malformed string from taking a card down (it degrades to a literal
 * `'0'` comparison instead).
 */
export function hasNonZeroBalance(item: { balance: string }): boolean {
  try {
    return BigInt(item.balance) !== 0n
  } catch {
    return item.balance !== '0'
  }
}

/** The breakdown items whose raw balance is non-zero, order preserved. */
export function nonZeroBreakdown<T extends { balance: string }>(breakdown: readonly T[]): T[] {
  return breakdown.filter(hasNonZeroBalance)
}
