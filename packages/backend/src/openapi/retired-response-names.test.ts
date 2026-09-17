import { describe, expect, it } from 'vitest'
import { openapiSpec } from './spec.js'

/**
 * The retired Safe-vocabulary RESPONSE names, swept at the property level
 * (#2914 follow-up).
 *
 * #2914 removed the retired names from every response but three. Two were
 * deliberate twins — `safes` on `GET /user/accounts` and `safeName` on the
 * transactions feed — kept for exactly one release because
 * `@haven_ai/cli@0.2.1-alpha.0` read both and a published client cannot
 * dual-READ the way #2908 had it dual-SEND. The third, `safes` on
 * `GET /transactions/filters`, was never twinned and was simply missed;
 * independent review found it.
 *
 * All three are gone now, and this sweep is why a fourth would not be. The
 * earlier tests each pinned ONE shape they knew about, which is exactly how
 * the filters key survived a slice that believed it had removed everything.
 * This walks the whole served document instead.
 *
 * It is deliberately a PROPERTY-NAME walk, not a string search: the
 * `/user/safes*` tombstone paths and their 410 prose stay, and a string
 * search over the JSON would fail on those forever.
 *
 * The match is a PATTERN, not a list of the names that were removed. A fixed
 * list catches a twin coming back and misses a name nobody has thought of
 * yet, which is the same "knew about one shape" gap that let the filters key
 * survive #2914 — verified by mutation: with a five-name denylist, injecting
 * `safeChainId` onto `Transaction` passed silently. So: `safe`/`safes`
 * exactly, `safeSomething` in camelCase, `safe_something` in snake_case, and
 * `sessionSafe`.
 *
 * Widening it immediately paid: it found `safe_tx_hash` on
 * `AgentConnectionSetupStatus.approval`, a FOURTH retired name that outlived
 * #2914 by reading migration 084's `account_tx_hash` column through the old
 * wire key. Renamed in the same change — no published package read it.
 */
const RETIRED_NAME_PATTERN = /^(safes?|safe[A-Z]\w*|safe_\w+|sessionSafe)$/

/**
 * The retired REQUEST fields, which must STAY declared.
 *
 * This is the epic's governing asymmetry and the one exception the sweep
 * needs. Deleting a request field does not reject it — Fastify ignores a key
 * it was not told about, so `safe_id` would silently create an agent with no
 * account behind it. So these two stay declared precisely so the handler can
 * REFUSE them with a 400 naming the replacement. They are request bodies, and
 * this file is about response names.
 */
const DECLARED_TO_BE_REFUSED = [
  'components.schemas.CreateAgentConnectionSetupRequest.properties.safe_id',
  'components.schemas.CreateAgentRequest.properties.safe_id',
]

function collectPropertyPaths(node: unknown, trail: string[], found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectPropertyPaths(item, [...trail, String(i)], found))
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const name of Object.keys(value as Record<string, unknown>)) {
        if (RETIRED_NAME_PATTERN.test(name)) {
          found.push([...trail, 'properties', name].join('.'))
        }
      }
    }
    collectPropertyPaths(value, [...trail, key], found)
  }
}

describe('retired Safe-vocabulary response names (#2914 follow-up)', () => {
  it('no schema in the served spec declares one as a property', () => {
    const found: string[] = []
    collectPropertyPaths(openapiSpec, [], found)
    expect(found.filter((path) => !DECLARED_TO_BE_REFUSED.includes(path))).toEqual([])
  })

  it('still declares the two request fields it refuses — the exception is exact', () => {
    // If a refusal-declared field is ever deleted for real, this reddens and
    // the allowance above stops silently covering a name that is gone.
    const found: string[] = []
    collectPropertyPaths(openapiSpec, [], found)
    expect(found.sort()).toEqual([...DECLARED_TO_BE_REFUSED].sort())
  })

  it('the three shapes that carried them last name accounts instead', () => {
    const schemas = (openapiSpec as unknown as {
      components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> }
    }).components.schemas

    const filters = schemas.TransactionFilterOptionsResponse
    expect(filters.required).toContain('accounts')
    expect(filters.required).not.toContain('safes')

    const transaction = schemas.Transaction
    expect(transaction.required).toContain('accountName')
    expect(Object.keys(transaction.properties ?? {})).not.toContain('safeName')
  })

  // The tombstones are the counter-case: these paths MUST keep the old
  // vocabulary, because a path is what an old client types. Only the
  // response BODIES were contracted.
  it('leaves ALL FIVE /user/safes* tombstone paths alone', () => {
    // Named individually, not `arrayContaining(['/user/safes'])`: that form
    // stays green while four of the five are deleted, which is precisely the
    // one-shape blindness this file exists to end.
    expect(Object.keys(openapiSpec.paths).filter((p) => p.startsWith('/user/safes')).sort()).toEqual([
      '/user/safes',
      '/user/safes/deploy',
      '/user/safes/{id}',
      '/user/safes/{id}/default',
      '/user/safes/{id}/funding',
    ])
  })
})
