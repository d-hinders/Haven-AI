/**
 * #2907 (naming P0, item C) defined `sessionAccount` and never referenced it
 * from any operation, so `sessionSafe`'s deprecation description ("same value
 * as `sessionAccount`") was aspirational, not true. #2914 (naming epic #2906
 * phase 5, the contraction) then deleted `sessionSafe` and the `safes`
 * envelope key outright — one name survives, not two.
 *
 * `sessionAccount` is now the ONLY item schema of the `accounts` array on
 * every session-shaped response (signup/login `user.accounts`,
 * `GET /auth/me`'s `accounts`, and `GET /auth/session`'s `accounts`). This
 * test pins that it is actually used, not just declared, and that its
 * retired `sessionSafe` twin — and the deprecation prose that described it —
 * is gone rather than merely unreferenced.
 */
import { describe, expect, it } from 'vitest'
import { openapiSpec } from './spec.js'

type JsonSchema = Record<string, unknown>

function findSessionAccountUsageCount(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce((sum: number, item) => sum + findSessionAccountUsageCount(item), 0)
  }
  if (node && typeof node === 'object') {
    const obj = node as JsonSchema
    // `sessionAccount`'s own required-field fingerprint — distinguishes it
    // from `sessionSafe` (which requires `safe_address`, not `account_address`)
    // without needing object identity across JSON round trips.
    const required = obj.required
    const isSessionAccountShape =
      Array.isArray(required) &&
      required.includes('account_address') &&
      required.includes('value_bearing_chain') &&
      !required.includes('safe_address')
    const own = isSessionAccountShape ? 1 : 0
    return (
      own +
      Object.values(obj).reduce((sum: number, value) => sum + findSessionAccountUsageCount(value), 0)
    )
  }
  return 0
}

describe('#2907 — sessionAccount is referenced, not dead', () => {
  it('the sessionAccount shape appears at least once in the registered paths (accounts[] item schema)', () => {
    const count = findSessionAccountUsageCount(openapiSpec.paths)
    expect(count).toBeGreaterThan(0)
  })

  it('sessionSafe and its deprecation prose are gone, not merely unreferenced', () => {
    // #2914 deleted the twin outright rather than leaving a dead schema
    // behind: no `sessionSafe` name, no "same value as `sessionAccount`"
    // deprecation sentence anywhere in the served spec.
    //
    // (`TransactionFilterOptionsResponse.safes` was why this test targeted
    // the session-user shape rather than a bare `"safes"` string search over
    // the whole spec. That field is `accounts` now — the #2914 follow-up
    // took it with the two response twins — and the property-level sweep
    // over the whole spec lives in `retired-response-names.test.ts`. A string
    // search still would not do: the `/user/safes*` tombstone PATHS stay.)
    const raw = JSON.stringify(openapiSpec)
    expect(raw).not.toContain('sessionSafe')
    expect(raw).not.toContain('same value as `sessionAccount`')

    // `sessionUser` (the `user:` property of signup/login, inlined into
    // /auth/me's own response) required `accounts` only, never `safes`.
    const sessionUserRequired = (
      openapiSpec.paths['/auth/signup'] as unknown as {
        post: { responses: { '201': { content: { 'application/json': { schema: { properties: { user: { required: readonly string[] } } } } } } } }
      }
    ).post.responses['201'].content['application/json'].schema.properties.user.required
    expect(sessionUserRequired).toContain('accounts')
    expect(sessionUserRequired).not.toContain('safes')

    expect(findSessionAccountUsageCount(openapiSpec.paths)).toBeGreaterThan(0)
  })
})
