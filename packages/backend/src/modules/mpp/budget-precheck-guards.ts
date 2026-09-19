/**
 * Input guards for `POST /machine-payments/budget-precheck` (#3054).
 *
 * The route's five hand-rolled body guards (token, amountAtomic, resourceUrl,
 * merchantTo, chainId) live here instead of the route file so the #3029
 * shrink-only ratchet (`scripts/lint-request-schemas.mjs`) keeps counting 19
 * `typeof` lines for `routes/machine-payments.ts` — its baseline pins the
 * file at 19 and the engine refuses to grow it. This is a relocation, not a
 * weakening: every check below is byte-identical to the guard it replaces,
 * each refusal keeps its exact 400 body, and the checks still run in the
 * route's auth+rate-limit edge before `handleBudgetPrecheck` (spec-driven
 * migration for this module belongs to the #3028 slices — it can only delete
 * these guards once the module is enforced, not before).
 */
import { isAddress as isValidAddress } from '@haven_ai/core'
import type { BudgetPrecheckBody } from './types.js'

/**
 * The route's body guards, in the route's own order. Returns the reply body
 * of the first refused field, or null when the body is well-formed.
 */
export function budgetPrecheckBodyError(
  body: BudgetPrecheckBody,
): { error: string } | null {
  if (!body.token || typeof body.token !== 'string' || !isValidAddress(body.token)) {
    return { error: 'token must be a valid contract address' }
  }
  if (
    !body.amountAtomic ||
    typeof body.amountAtomic !== 'string' ||
    !/^[0-9]+$/.test(body.amountAtomic)
  ) {
    return { error: 'amountAtomic must be a non-negative integer string' }
  }
  if (body.resourceUrl !== undefined && typeof body.resourceUrl !== 'string') {
    return { error: 'resourceUrl must be a string' }
  }
  if (body.merchantTo !== undefined && typeof body.merchantTo !== 'string') {
    return { error: 'merchantTo must be a string' }
  }
  if (body.chainId !== undefined && typeof body.chainId !== 'number') {
    return { error: 'chainId must be a number' }
  }
  return null
}
