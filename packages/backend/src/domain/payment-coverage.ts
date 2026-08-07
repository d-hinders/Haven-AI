/**
 * Coverage decision for machine payments (PT-1 consolidation, PR3).
 *
 * Both money paths make the same policy-first routing decision — execute now,
 * queue for human approval, or reject as unfunded — but they used to inline it
 * with subtly different rules. This is the single, pure decision so the two
 * paths can share it while keeping their *intentionally* different coverage
 * models:
 *
 *  - `allowance-only` (MPP / generic rails): route purely on the on-chain
 *    remaining allowance. The delegate balance is irrelevant; over-allowance
 *    always queues. Never returns `insufficient`.
 *
 *  - `balance-aware` (x402): the delegate EOA briefly holds liquid funds during
 *    the x402 hot-wallet leg, so its existing balance can cover an allowance
 *    shortfall. Route on `delegateBalance + remaining`: anything beyond that is
 *    `insufficient`; a smaller overage the balance can cover still `queue`s.
 *
 * Pure and total: bigint math only, no I/O, no formatting. Callers own RPC
 * reads, human-readable formatting, persistence, and HTTP shaping.
 */

export type CoverageStrategy = 'balance-aware' | 'allowance-only'

export type CoverageDecision =
  | { kind: 'execute' }
  | { kind: 'queue' }
  | { kind: 'insufficient'; shortfall: bigint; totalCoverage: bigint }

export interface CoverageInputs {
  /** Requested transfer amount, atomic units. */
  amount: bigint
  /** Remaining on-chain allowance for the token, atomic units. */
  remaining: bigint
  /**
   * Delegate's current token balance, atomic units. Required for
   * `balance-aware`; ignored for `allowance-only`. Defaults to 0n, which makes
   * `balance-aware` behave like a strict allowance check (any over-allowance
   * amount is `insufficient`) — matching x402 when the delegate holds nothing.
   */
  delegateBalance?: bigint
}

/**
 * Decide how to route a payment against the agent's coverage. See module docs
 * for the two strategies. The boundary is inclusive of exact coverage: an
 * amount equal to `remaining` (or, for balance-aware, equal to
 * `delegateBalance + remaining`) is NOT over that threshold.
 */
export function decideCoverage(
  strategy: CoverageStrategy,
  { amount, remaining, delegateBalance = 0n }: CoverageInputs,
): CoverageDecision {
  if (strategy === 'balance-aware') {
    const totalCoverage = delegateBalance + remaining
    if (amount > totalCoverage) {
      return { kind: 'insufficient', shortfall: amount - totalCoverage, totalCoverage }
    }
  }
  if (amount > remaining) return { kind: 'queue' }
  return { kind: 'execute' }
}
