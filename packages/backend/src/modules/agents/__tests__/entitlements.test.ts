import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConfig, mockQuery } = vi.hoisted(() => ({
  mockConfig: { hosted: false, accountingEnabled: false },
  mockQuery: vi.fn(),
}))

vi.mock('../../../config.js', () => ({ config: mockConfig }))
vi.mock('../../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

import {
  hasEntitlement,
  grantEntitlement,
  revokeEntitlement,
  accountingFeedAvailable,
  REPORTING_FEED,
} from '../entitlements.js'

const USER = 'u1'

describe('entitlements', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockConfig.hosted = false
    mockConfig.accountingEnabled = false
  })
  afterEach(() => vi.clearAllMocks())

  it('hasEntitlement reflects an unrevoked row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    expect(await hasEntitlement(USER, REPORTING_FEED)).toBe(true)
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await hasEntitlement(USER, REPORTING_FEED)).toBe(false)
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

  it('grant uses an idempotent upsert that clears revocation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await grantEntitlement(USER, REPORTING_FEED)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('INSERT INTO account_entitlements')
    expect(sql).toContain('ON CONFLICT')
    expect(sql).toContain('revoked_at = NULL')
  })

  it('revoke stamps revoked_at and is a no-op when not granted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await revokeEntitlement(USER, REPORTING_FEED)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('UPDATE account_entitlements')
    expect(sql).toContain('revoked_at = NOW()')
  })
})
