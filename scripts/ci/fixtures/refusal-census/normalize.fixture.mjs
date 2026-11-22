/**
 * Fixture `normalizeError` results for `refusal-census.test.mjs` (#4471).
 *
 * The self-test must run in the always-run *Repo CI config checks* job, which
 * does no `npm ci` and no build, so it cannot import the real
 * `packages/mcp-server/dist`. This module is the fixture half of the join: it
 * answers the codes the fixture recording carries the way the real mapper does
 * at `aad313ad9`, and falls through to `API_ERROR` for everything else — which
 * is the branch block 8 exists to count. The generic branch's reasons and the
 * relayer-budget stop were added at `374986531` (#5040); a self-test checks
 * each copied string against `errors.ts`.
 *
 * It is a FIXTURE, not a second mapper: the block's numbers come from the built
 * `normalizeError`, and the self-test only proves the join can say yes and no.
 */

/** The SDK's error shape, reduced to what the join reads. */
export class FixtureHavenApiError extends Error {
  constructor(message, statusCode, body) {
    super(message)
    this.name = 'HavenApiError'
    this.code = 'API_ERROR'
    this.statusCode = statusCode
    this.body = body
  }
}

/**
 * The generic branch's reasons, copied from
 * `packages/mcp-server/src/tools/support/errors.ts` (#5040). The self-test
 * reads that file and fails if a string here is not in it, so the copy cannot
 * drift. The census treats an `API_ERROR` answer carrying one of these (or no
 * reason) as the generic branch.
 */
export const FIXTURE_REFUSED_AS_MADE =
  'the upstream call was refused as made (4xx); re-calling it the same way cannot succeed, so tell the user what failed'
export const FIXTURE_TRANSIENT =
  'the upstream call failed transiently; re-call the same tool with the same arguments (and the same idempotency_key where the tool has one) once before telling the user'
export const FIXTURE_RATE_LIMITED =
  'the upstream call was rate-limited; wait (retry_after_seconds when the answer carries it), then re-call the same tool with the same arguments (and the same idempotency_key where the tool has one) once before telling the user'
export const FIXTURE_GENERIC_REASONS = new Set([FIXTURE_REFUSED_AS_MADE, FIXTURE_RATE_LIMITED, FIXTURE_TRANSIENT])

/**
 * A typed stop the real mapper answers INSIDE `API_ERROR` (#4844): the code
 * stays `API_ERROR`, the reason is its own. Copied from `errors.ts` likewise.
 */
export const FIXTURE_RELAYER_BUDGET_REASON =
  'the relayer sponsorship budget for this operation is exhausted; a slot frees when the oldest counted operation ages out (up to 24 hours for an account deploy, up to 60 minutes for a sweep), so tell the user the window and do not re-call it now'

/** Codes the real mapper answers with their own branch at `aad313ad9`. */
const MAPPED = new Map([
  ['delegation_expired', { code: 'DELEGATION_EXPIRED', next_action: 'fund_account_or_raise_allowance' }],
  ['submission_outcome_unknown', { code: 'SUBMISSION_OUTCOME_UNKNOWN', next_action: 'check_status_later' }],
  ['prepare_reverted', { code: 'PREPARE_REVERTED', next_action: 'stop_and_tell_user' }],
])

export function fixtureNormalize(err) {
  const body = err.body !== null && typeof err.body === 'object' ? err.body : {}
  const mapped = MAPPED.get(body.error_code)
  if (mapped) {
    return { success: false, code: mapped.code, statusCode: err.statusCode, next_action: mapped.next_action }
  }
  if (body.error_code === 'relayer_budget_exceeded') {
    return {
      success: false,
      code: err.code,
      statusCode: err.statusCode,
      next_action: 'stop_and_tell_user',
      next_tool_omitted_reason: FIXTURE_RELAYER_BUDGET_REASON,
    }
  }
  // The generic branch: a 5xx (or a status-less answer) reads transient, a 4xx
  // reads "refused as made" — each with the real branch's reason (#5040).
  if (err.statusCode === 429) {
    return { success: false, code: err.code, statusCode: 429, next_action: 'retry_with_explicit_context', next_tool_omitted_reason: FIXTURE_RATE_LIMITED }
  }
  const transient = err.statusCode === undefined || err.statusCode >= 500 || err.statusCode === 0
  return {
    success: false,
    code: err.code,
    statusCode: err.statusCode,
    next_action: transient ? 'retry_with_explicit_context' : 'stop_and_tell_user',
    next_tool_omitted_reason: transient ? FIXTURE_TRANSIENT : FIXTURE_REFUSED_AS_MADE,
  }
}
