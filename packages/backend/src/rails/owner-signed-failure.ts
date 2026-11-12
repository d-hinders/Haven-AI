/**
 * #4821: the failure body every OWNER-SIGNED operation answers with.
 *
 * Five handlers submit an owner-signed treasury UserOperation through
 * `submitCall` (`rails/delegation-rail.ts`): the two signer-change routes, the
 * single and batch delegation revocations, and the re-key's revoke. Before
 * this slice each answered ANY throw with `502` and a "… failed" body, so a
 * pre-send rejection (nothing was sent) and a dispatched operation whose
 * answer was lost (it may have landed) read identically to the caller.
 *
 * #4817 gave `submitCall` a typed error that separates them
 * (`SubmittedUserOpFailedError.outcome`). This module turns that error into
 * the wire shape, so the five handlers cannot drift apart:
 *
 * - `submission_outcome_unknown` — the operation was SENT and its answer (or
 *   its receipt) was lost. It may have landed. `user_op_hash` names the
 *   operation the bundler received (a 4337 operation hash, NOT a transaction
 *   hash), and the sentence never says "failed".
 * - `onchain_execution_failed` — a KNOWN failure: an explicit pre-send
 *   rejection, or an operation that landed and reverted (nothing moved).
 *   Retrying is safe.
 *
 * The vocabulary matches the agent payment route's
 * (`modules/payments/sign-payment.ts`) and the owner-send route's (#4820), so
 * one cause reads the same on every rail.
 */
import { SubmittedUserOpFailedError } from './delegation-rail.js'
import { boundedErrorDetails } from '../modules/payments/index.js'

/** The operation was sent and its answer or receipt was lost. */
export const SUBMISSION_OUTCOME_UNKNOWN = 'submission_outcome_unknown' as const
/** A known failure: an explicit pre-send rejection, or a landed-and-reverted op. */
export const ONCHAIN_EXECUTION_FAILED = 'onchain_execution_failed' as const

export type OwnerSignedFailureCode =
  | typeof SUBMISSION_OUTCOME_UNKNOWN
  | typeof ONCHAIN_EXECUTION_FAILED

/**
 * A refusal from an owner-signed submit. `error` is the sentence every caller
 * already shows; `error_code` and `user_op_hash` are additive, so a caller
 * that only reads `error` is unaffected.
 */
export type OwnerSignedFailure = {
  status: 502
  error: string
  details?: string
  error_code?: OwnerSignedFailureCode
  user_op_hash?: string
}

/**
 * The wire body for a failure. Fields are omitted rather than sent empty, so
 * a caller can branch on presence.
 */
export function ownerSignedFailureBody(failure: {
  error: string
  details?: string
  error_code?: OwnerSignedFailureCode
  user_op_hash?: string
}): Record<string, unknown> {
  const body: Record<string, unknown> = { error: failure.error }
  if (failure.details) body.details = failure.details
  if (failure.error_code) body.error_code = failure.error_code
  if (failure.user_op_hash) body.user_op_hash = failure.user_op_hash
  return body
}

/**
 * Classify a throw from `submitCall` into the answer the route sends.
 *
 * `texts.unknown` is the outcome-unknown sentence (it must not say "failed");
 * `texts.known` is the operation's existing failure sentence, kept verbatim so
 * a pre-send rejection answers exactly what it answered before.
 *
 * Only the typed `receipt_unconfirmed` variant is outcome-unknown. Everything
 * else — a pre-send rejection, an included-and-reverted receipt, a failure
 * before the request left — is a known failure.
 */
export function classifySubmitThrow(
  err: unknown,
  texts: { unknown: string; known: string },
): OwnerSignedFailure {
  const details = boundedErrorDetails(err) ?? ''
  if (err instanceof SubmittedUserOpFailedError && err.outcome === 'receipt_unconfirmed') {
    return {
      status: 502,
      error: texts.unknown,
      error_code: SUBMISSION_OUTCOME_UNKNOWN,
      user_op_hash: err.userOpHash,
      details,
    }
  }
  return { status: 502, error: texts.known, error_code: ONCHAIN_EXECUTION_FAILED, details }
}

/**
 * #4821: the body a REVOCATION submit answers with. The single revoke, the
 * batch revoke and the re-key's revoke share the outcome-unknown sentence —
 * the operation may have disabled the delegations — so only the known-failure
 * sentence is the caller's.
 */
export function revocationFailureBody(err: unknown, known: string): Record<string, unknown> {
  return ownerSignedFailureBody(
    classifySubmitThrow(err, { unknown: 'The revocation may have gone through', known }),
  )
}
