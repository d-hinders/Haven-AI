/**
 * #4821: what a rejected owner-signed SUBMIT request is evidence of.
 *
 * Five dashboard callers submit an owner-signed treasury operation: the
 * signer-change hook, the budget hook's single and batch revocations, the
 * edit flow's Stop, and the re-key's revoke. Each submit POST is the only call
 * that can change authority, so a rejection there is NOT proof that nothing
 * happened:
 *
 * - no HTTP answer at all (a dropped connection, a timeout, a platform 502
 *   while the backend restarts) — the request may have reached the route;
 * - the route's own outcome-unknown answer (`submission_outcome_unknown`),
 *   which carries the UserOperation hash;
 * - a 5xx with no code, or with a code this client does not know — a proxy or
 *   platform answer, not the route's.
 *
 * All three are `unconfirmed`: the operation may have landed, so the caller
 * must not offer a control that signs the same operation again without
 * re-reading the account's state first. A 4xx, or the route's known-failure
 * code (`onchain_execution_failed` — an explicit pre-send rejection, or an
 * operation that landed and reverted), is the route saying nothing moved:
 * `failed`, and retrying is safe.
 *
 * The vocabulary matches the owner-send hook's (#4820) and the backend's
 * (`rails/owner-signed-failure.ts`), so one cause reads the same everywhere.
 */

/** The route's outcome-unknown code (#4817/#4820/#4821). */
export const OUTCOME_UNKNOWN_CODE = 'submission_outcome_unknown'
/** The route's known-failure code. */
export const KNOWN_FAILURE_CODE = 'onchain_execution_failed'

export type SubmitOutcome =
  | { reason: 'unconfirmed'; message?: string; userOpHash?: string }
  | { reason: 'failed'; message?: string }

function readStringField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Duck-typed on purpose (`body` is the `ApiRequestError` escape hatch,
 * `lib/api.ts`): several test suites mock `@/lib/api` without the class, and an
 * `instanceof` against an undefined export would throw instead of answering.
 * Same posture as `slotOccupiedFrom` in `hooks/useDelegationBudget.ts`.
 */
function readApiError(err: unknown): { status: number; body: unknown; message: string } | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { status?: unknown; body?: unknown; message?: unknown }
  if (typeof e.status !== 'number') return null
  return { status: e.status, body: e.body, message: typeof e.message === 'string' ? e.message : '' }
}

/**
 * Classify a throw from a submit POST. `userOpHash` is the operation the
 * bundler received when the route knew it — NOT the hash of a chain
 * transaction, so it is not an explorer link.
 */
export function classifySubmitOutcome(err: unknown): SubmitOutcome {
  const api = readApiError(err)
  if (!api) {
    return { reason: 'unconfirmed', message: err instanceof Error ? err.message : undefined }
  }
  const code = readStringField(api.body, 'error_code')
  if (code === OUTCOME_UNKNOWN_CODE) {
    return {
      reason: 'unconfirmed',
      message: api.message,
      userOpHash: readStringField(api.body, 'user_op_hash') ?? undefined,
    }
  }
  if (api.status >= 400 && api.status < 500) {
    return { reason: 'failed', message: api.message }
  }
  if (code === KNOWN_FAILURE_CODE) {
    return { reason: 'failed', message: api.message }
  }
  return { reason: 'unconfirmed', message: api.message }
}
