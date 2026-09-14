/**
 * #2907 (naming P0, item C): `sessionAccount` was defined in `spec.ts` and
 * never referenced by any operation — so it never reached the generated
 * `packages/core/src/api-types.ts`, and `sessionSafe`'s deprecation
 * description ("same value as `sessionAccount`") was aspirational, not true.
 *
 * `sessionAccount` is now the item schema of the `accounts` twin array on
 * every session-shaped response (signup/login `user.accounts`,
 * `GET /auth/me`'s `accounts`, and `GET /auth/session`'s `accounts`). This
 * test pins that it is actually used, not just declared.
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

  it('sessionSafe.description names sessionAccount, and that claim is now true', () => {
    // Reach into the getSession-adjacent schemas the same way the mapper
    // tests do: the deprecation sentence lives on `safe_address` in the
    // `sessionUser`-shaped schemas, referencing `sessionAccount` by name.
    const raw = JSON.stringify(openapiSpec)
    expect(raw).toContain('same value as `sessionAccount`')
    expect(findSessionAccountUsageCount(openapiSpec.paths)).toBeGreaterThan(0)
  })
})
