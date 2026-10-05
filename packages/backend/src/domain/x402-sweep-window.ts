/**
 * The settlement sweeper's WINDOW constants (#2213, #3514), lifted into
 * their own zero-import module so `GET /ops/health` reads the SAME window
 * the sweeper runs with — one definition, two importers — WITHOUT the ops
 * console importing the sweeper. The ops invariant-1 walk
 * (`__tests__/ops.invariants.test.ts`) forbids the ops graph from reaching
 * `modules/x402/*`; `settlement-sweeper.ts` re-exports these unchanged and
 * its behaviour is untouched.
 */

/** Payments younger than this are too young to sweep — see the sweeper. */
export const SWEEP_MIN_AGE_SECONDS = 90
/**
 * How far back the sweep looks: deliberately much wider than a payment's
 * on-chain settlement window, so an RPC outage spanning a payment's window
 * does not lose the payment — see the sweeper header.
 */
export const SWEEP_RECOVERY_HORIZON_SECONDS = 24 * 60 * 60
