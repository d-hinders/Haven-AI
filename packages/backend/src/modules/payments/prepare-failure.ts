/**
 * #3609: the 502 a delegation-rail PREPARE answers when its simulation fails —
 * `POST /payments` and the x402 EIP-3009 funding leg (`modules/x402/
 * delegation-authorize.ts`), after their typed budget fallbacks have had
 * their turn (#3500's task-budget re-read on both; #3503's period re-read on
 * `POST /payments` only).
 *
 * Before this, both answered one untyped 502 carrying the raw viem error as
 * `details` (~6 KB live: the whole callData, signatures, paymaster data), and
 * the hosted MCP turned every 5xx into "transient, retry once". That is true
 * for a bundler blip and false for a caveat revert, which reverts again on
 * every retry. Two typed answers now, split by the same classifier the
 * refusal ledger uses (`classifyRevertForLedger`):
 *
 * - `prepare_reverted` — the redemption REVERTED in execution (a decoded
 *   `Error(string)`, a named caveat-enforcer error, the timestamp caveat's
 *   text, or viem's `EstimateGasExecutionError`): deterministic, so not
 *   retryable as made. Carries the classifier's `refusal_reason` and the
 *   decoded `revert_reason`.
 * - `prepare_failed` — anything else: not a revert (bundler, RPC,
 *   transport), or an ERC-4337 VALIDATION failure the bundler words as a
 *   revert (`AA25` nonce race, `AA31`/`AA33` paymaster, review S1) — may
 *   clear on its own, so the hosted step stays "retry once". The ledger
 *   still books a classified revert either way (unchanged by #3609).
 *
 * Both stay HTTP 502 (the status the routes have always answered; the
 * `error_code` is the discriminator), and both carry `details` bounded by
 * `boundFailureMessage` after `redactVendorSecrets` — the #3494 bound the
 * sign route already applies.
 */
import { redactVendorSecrets } from '../../domain/redact-vendor-secrets.js'
import { boundFailureMessage } from './agent-payment-status.js'
import { classifyRevertForLedger, isExecutionRevert, revertReasonOf } from './refusal-ledger.js'

export const PREPARE_REVERTED_ERROR_CODE = 'prepare_reverted'
export const PREPARE_FAILED_ERROR_CODE = 'prepare_failed'

/**
 * The text worth showing for a caught error. A viem `BaseError`'s `.message`
 * is its headline, then a `Request Arguments:` block (kilobytes of callData),
 * then `Details:` — the actual cause — LAST, so bounding `.message` keeps the
 * callData and cuts the cause (#3609 review S2). For those errors the
 * headline (`shortMessage`) plus `details` is the cause without the dump.
 */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const { shortMessage, details } = err as { shortMessage?: unknown; details?: unknown }
  if (typeof shortMessage === 'string' && typeof details === 'string' && details) {
    // viem sometimes folds `details` into `shortMessage` already — never say it twice.
    if (shortMessage.includes(details)) return shortMessage
    return details.startsWith(shortMessage) ? details : `${shortMessage} — ${details}`
  }
  return err.message
}

/** The bounded, redacted `details` every prepare-failure body carries. */
export function boundedErrorDetails(err: unknown): string | null {
  return boundFailureMessage(redactVendorSecrets(errorText(err)))
}

export interface PrepareFailureBody {
  error: string
  error_code: typeof PREPARE_REVERTED_ERROR_CODE | typeof PREPARE_FAILED_ERROR_CODE
  refusal_reason?: NonNullable<ReturnType<typeof classifyRevertForLedger>>
  revert_reason?: string | null
  message?: string
  details: string | null
}

/**
 * The 502 body for a failed prepare. `refusalReason` is the caller's
 * `classifyRevertForLedger(err)` — passed in, not recomputed, so the body
 * and the ledger row can never disagree about what happened.
 * `infrastructureError` is the route's existing `error` text, kept for the
 * not-a-revert case.
 */
export function prepareFailureBody(
  err: unknown,
  refusalReason: ReturnType<typeof classifyRevertForLedger>,
  infrastructureError: string,
): PrepareFailureBody {
  const details = boundedErrorDetails(err)
  // #3609 review S1: the ledger books every classified revert (unchanged),
  // but only an EXECUTION revert is deterministic for this payment. A
  // validation failure the bundler words as a revert (AA25 nonce race,
  // AA31/AA33 paymaster) can clear on its own, so it answers prepare_failed
  // and keeps the retry step.
  if (!refusalReason || !isExecutionRevert(err)) {
    return { error: infrastructureError, error_code: PREPARE_FAILED_ERROR_CODE, details }
  }
  const revertReason = revertReasonOf(err)
  return {
    error: 'The payment reverted during on-chain simulation',
    error_code: PREPARE_REVERTED_ERROR_CODE,
    refusal_reason: refusalReason,
    revert_reason: revertReason,
    message:
      'This payment reverted during on-chain simulation' +
      (revertReason ? ` (${revertReason})` : '') +
      '. Nothing was signed or moved, and retrying the same payment reverts again. Tell the user: ' +
      'a budget, recipient or expiry caveat is changed by the wallet owner in Haven; any other ' +
      'revert (for example the account not holding enough of the token) needs the cause fixed first.',
    details,
  }
}
