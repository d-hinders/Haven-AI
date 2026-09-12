import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConfig, mockQuery } = vi.hoisted(() => ({
  mockConfig: { hosted: false, accountingEnabled: false, accountingEntitlementMode: 'granted' as 'granted' | 'all' },
  mockQuery: vi.fn(),
}))

vi.mock('../../../config.js', () => ({ config: mockConfig }))
vi.mock('../../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

import {
  hasEntitlement,
  grantEntitlement,
  revokeEntitlement,
  accountingFeedAvailable,
  accountingFeedAvailability,
  ACCOUNTING_FEED,
} from '../entitlements.js'

const USER = 'u1'

describe('entitlements', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockConfig.hosted = false
    mockConfig.accountingEnabled = false
    mockConfig.accountingEntitlementMode = 'granted'
  })
  afterEach(() => vi.clearAllMocks())

  it('hasEntitlement reflects an unrevoked row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    expect(await hasEntitlement(USER, ACCOUNTING_FEED)).toBe(true)
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await hasEntitlement(USER, ACCOUNTING_FEED)).toBe(false)
  })

  describe('accountingFeedAvailable — requires hosted AND flag AND entitlement', () => {
    it('false when not hosted (no DB lookup)', async () => {
      mockConfig.hosted = false
      mockConfig.accountingEnabled = true
      expect(await accountingFeedAvailable(USER)).toBe(false)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('false when the global flag is off', async () => {
      mockConfig.hosted = true
      mockConfig.accountingEnabled = false
      expect(await accountingFeedAvailable(USER)).toBe(false)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('false when hosted + flag but no entitlement', async () => {
      mockConfig.hosted = true
      mockConfig.accountingEnabled = true
      mockQuery.mockResolvedValueOnce({ rows: [] })
      expect(await accountingFeedAvailable(USER)).toBe(false)
    })

    it('true only when hosted + flag + entitlement', async () => {
      mockConfig.hosted = true
      mockConfig.accountingEnabled = true
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      expect(await accountingFeedAvailable(USER)).toBe(true)
    })
  })

  describe('entitlement mode all (#2861) — every account is entitled, the row is not consulted', () => {
    it('a user with NO entitlement row is available, and no lookup is made', async () => {
      mockConfig.hosted = true
      mockConfig.accountingEnabled = true
      mockConfig.accountingEntitlementMode = 'all'
      expect(await accountingFeedAvailability(USER)).toEqual({ available: true, entitled: true, entitlementMode: 'all' })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('the hosted and flag checks still come FIRST: all on a self-hosted box is false', async () => {
      mockConfig.hosted = false
      mockConfig.accountingEnabled = true
      mockConfig.accountingEntitlementMode = 'all'
      expect(await accountingFeedAvailability(USER)).toEqual({ available: false, entitled: false, entitlementMode: 'all' })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('mode granted reports WHY: entitled false when the row is missing', async () => {
      mockConfig.hosted = true
      mockConfig.accountingEnabled = true
      mockQuery.mockResolvedValue({ rows: [] }) // not the positional Once form: the db-mock ratchet is shrink-only (#1227)
      expect(await accountingFeedAvailability(USER)).toEqual({ available: false, entitled: false, entitlementMode: 'granted' })
    })
  })

  it('grant uses an idempotent upsert that clears revocation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await grantEntitlement(USER, ACCOUNTING_FEED)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('INSERT INTO account_entitlements')
    expect(sql).toContain('ON CONFLICT')
    expect(sql).toContain('revoked_at = NULL')
  })

  it('revoke stamps revoked_at and is a no-op when not granted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await revokeEntitlement(USER, ACCOUNTING_FEED)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('UPDATE account_entitlements')
    expect(sql).toContain('revoked_at = NOW()')
  })
})
