/**
 * The x402 settlement grant's TIMING constants, lifted into their own
 * zero-import module (#4379) so `modules/payments/agent-payment-status.ts`
 * reads the SAME numbers the x402 verifier uses WITHOUT importing
 * `modules/x402/*`: payments' status projection and x402's sign-context
 * already depend on each other's barrels, so a payments → x402 import was a
 * cycle. `x402-delegation.ts` and `settlement-observed.ts` re-export these
 * unchanged, and their behaviour is untouched — the same move
 * `x402-sweep-window.ts` made for the sweeper's window.
 */

/** Cap on how long a settlement grant may live, whatever the merchant asks. */
export const MAX_SETTLEMENT_WINDOW_SECONDS = 600 // the #715 discipline carries over

/**
 * Clock-skew allowance between Postgres' `created_at` and the chain's block
 * timestamps. Generous on purpose: this bound exists to EXCLUDE settlements
 * from unrelated windows, so widening it costs a little precision, while
 * narrowing it could reject a genuine payment — which on this path means
 * silently dropping it out of the user's bookkeeping.
 *
 * #3420: the agent-facing status projection (`agent-payment-status.ts`)
 * derives its terminal cutover from THIS constant rather than restating 120:
 * the instant past which no verification is possible is the verifier's own
 * `notAfterSec`, and a second copy of the number would let the two disagree
 * silently.
 */
export const CLOCK_SKEW_SECONDS = 120
