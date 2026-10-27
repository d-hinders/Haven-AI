/**
 * Fixture `normalizeError` results for `refusal-census.test.mjs` (#4471).
 *
 * The self-test must run in the always-run *Repo CI config checks* job, which
 * does no `npm ci` and no build, so it cannot import the real
 * `packages/mcp-server/dist`. This module is the fixture half of the join: it
 * answers the codes the fixture recording carries the way the real mapper does
 * at `aad313ad9`, and falls through to `API_ERROR` for everything else — which
 * is the branch block 8 exists to count.
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
  // The generic branch: a 5xx (or a status-less answer) reads transient, a 4xx
  // reads "refused as made".
  const transient = err.statusCode === undefined || err.statusCode >= 500 || err.statusCode === 0
  return {
    success: false,
    code: err.code,
    statusCode: err.statusCode,
    next_action: transient ? 'retry_with_explicit_context' : 'stop_and_tell_user',
  }
}
