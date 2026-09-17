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
 */
const RETIRED_RESPONSE_NAMES = ['safes', 'safeName', 'safeId', 'safeAddress', 'sessionSafe']

function collectPropertyPaths(node: unknown, trail: string[], found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectPropertyPaths(item, [...trail, String(i)], found))
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const name of Object.keys(value as Record<string, unknown>)) {
        if (RETIRED_RESPONSE_NAMES.includes(name)) {
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
    expect(found).toEqual([])
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
  it('leaves the /user/safes* tombstone paths alone', () => {
    expect(Object.keys(openapiSpec.paths)).toEqual(expect.arrayContaining(['/user/safes']))
  })
})
