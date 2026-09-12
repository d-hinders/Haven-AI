import { describe, expect, it } from 'vitest'
import { parseAccountingEntitlementMode } from '../config.js'

/**
 * `HAVEN_ACCOUNTING_ENTITLEMENT_MODE` (#2861), on the `parseConnectorChannel`
 * pattern: unset and empty land on the production-safe value; an invalid
 * non-empty value throws at import time and refuses the boot.
 */
describe('parseAccountingEntitlementMode (#2861)', () => {
  it('defaults to granted when unset, null, or empty — production is unchanged by the variable\'s absence', () => {
    expect(parseAccountingEntitlementMode(undefined)).toBe('granted')
    expect(parseAccountingEntitlementMode(null)).toBe('granted')
    expect(parseAccountingEntitlementMode('')).toBe('granted')
    expect(parseAccountingEntitlementMode('   ')).toBe('granted')
  })

  it('accepts the two modes, trimmed', () => {
    expect(parseAccountingEntitlementMode('granted')).toBe('granted')
    expect(parseAccountingEntitlementMode('all')).toBe('all')
    expect(parseAccountingEntitlementMode(' all ')).toBe('all')
  })

  it('REFUSES an unknown value rather than falling back — a misspelled "all" on dev must not silently mean "granted"', () => {
    for (const bad of ['al', 'ALL', 'everyone', 'true', 'granted,all']) {
      expect(() => parseAccountingEntitlementMode(bad), bad).toThrow(/HAVEN_ACCOUNTING_ENTITLEMENT_MODE is set to/)
    }
  })

  it('the refusal names the variable and both valid values, so the operator can fix it from the log line', () => {
    expect(() => parseAccountingEntitlementMode('everyone')).toThrow(/"granted".*"all"/s)
  })
})
