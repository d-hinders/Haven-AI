/**
 * #3922: `STILL_ENABLED_DELEGATION_STATUSES` (`@haven_ai/core`) is the
 * TypeScript mirror of `stillEnabledDelegationSql` — the CLI revoke gate and
 * the dashboard remove dialog consume the constant, the revoke-all target
 * list, `live_delegation_count` and the archive / account-delete guards
 * consume the SQL. This parses the SQL literal and compares the SET, so a
 * status added to one side and not the other fails here.
 */
import { describe, expect, it } from 'vitest'
import { STILL_ENABLED_DELEGATION_STATUSES } from '@haven_ai/core'
import { stillEnabledDelegationSql } from '../delegation-budgets.js'

function statusesIn(sql: string): string[] {
  const match = /status\s+IN\s*\(([^)]*)\)/i.exec(sql)
  if (!match) throw new Error(`no "status IN (...)" literal in: ${sql}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('STILL_ENABLED_DELEGATION_STATUSES == stillEnabledDelegationSql (#3922)', () => {
  it('names the same set of statuses, aliased or not', () => {
    const constant = [...STILL_ENABLED_DELEGATION_STATUSES].sort()
    expect(statusesIn(stillEnabledDelegationSql()).sort()).toEqual(constant)
    expect(statusesIn(stillEnabledDelegationSql('ad')).sort()).toEqual(constant)
  })

  it('has no duplicates and never includes revoked (the one status the chain has confirmed dead)', () => {
    expect(new Set(STILL_ENABLED_DELEGATION_STATUSES).size).toBe(STILL_ENABLED_DELEGATION_STATUSES.length)
    expect(STILL_ENABLED_DELEGATION_STATUSES).not.toContain('revoked')
  })
})
