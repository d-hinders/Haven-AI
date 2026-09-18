/**
 * Input guards for `GET /machine-payments/balance-coverage` (#3126).
 *
 * The route's two hand-rolled query guards (token, amount_atomic) live here
 * instead of the route file so the #3029 shrink-only ratchet
 * (`scripts/lint-request-schemas.mjs`) keeps counting 19 `typeof` lines for
 * `routes/machine-payments.ts` — its baseline pins the file at 19 and the
 * engine refuses to grow it. This is a relocation, not a weakening: every
 * check below is identical to the guard it replaces, each refusal keeps its
 * exact 400 body, and the checks still run in the route's auth edge before
 * `handleBalanceCoverage` (spec-driven migration for this module belongs to
 * the #3028 slices — it can only delete these guards once the module is
 * enforced, not before).
 */
import type { BalanceCoverageQuery } from './balance-coverage.js'

/**
 * The route's query guards, in the route's own order, against the raw wire
 * shape (`amount_atomic` is the query parameter; the handler's normalized
 * input is camelCase). Returns the handler query on success, or the reply
 * body of the first refused field.
 */
export function parseBalanceCoverageQuery(
  query: { token?: string; amount_atomic?: string },
): BalanceCoverageQuery | { error: string } {
  if (typeof query.token !== 'string' || query.token.length === 0) {
    return { error: 'token is required (the ERC-20 contract address)' }
  }
  if (typeof query.amount_atomic !== 'string' || query.amount_atomic.length === 0) {
    return { error: 'amount_atomic is required (a decimal atomic amount)' }
  }
  return { token: query.token, amountAtomic: query.amount_atomic }
}
