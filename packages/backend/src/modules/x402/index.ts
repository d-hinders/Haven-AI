/**
 * Public entry point for the x402 module (#996, epic #980 M4). Outside
 * callers (routes, tests) must import ONLY from this file — see the
 * `no-deep-cross-module-import` dependency-cruiser rule in
 * `.dependency-cruiser.cjs`. Internal files (`helpers.ts`, `scheme-selection.ts`,
 * `replay.ts`, `delegation-authorize.ts`, `legacy-authorize.ts`, `authorize.ts`,
 * `settle.ts`) are private.
 *
 * `routes/x402.ts` keeps request validation, auth middleware wiring, rate
 * limiting, and response serialization; the authorize orchestration (scheme
 * routing, funding-leg prep, erc7710 child building), the #961 replay/resume
 * logic, and settle assembly live here. `x402-delegation.ts` (folded in by
 * #998 — its only production consumers were already inside this module) is
 * the settlement COMPILER (typed-data / header assembly primitives), not
 * route orchestration (M5's concern per #996); it stays private, not
 * re-exported here.
 */

export type { AuthorizeX402Input } from './authorize.js'
export { authorizeX402 } from './authorize.js'
export { settleX402 } from './settle.js'
export { getX402SignContext } from './sign-context.js'

export type { X402AuthorizeBody, X402ApprovalRow, X402HandlerResult } from './types.js'

export {
  isPositiveDecimalAtomicAmount,
  normaliseAddress,
  chainIdFromX402Network,
  ZERO_ADDRESS,
} from './helpers.js'
