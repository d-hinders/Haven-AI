import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Lifecycle coverage for the Fortnox connection store.
 *
 * `getValidFortnoxAccessToken` is the single seam every server-side Fortnox
 * call goes through, and it was untested. These tests pin its three branches
 * (no connection → null; live token → returned as-is; expired token →
 * refreshed and persisted) and document the deliberate design point that the
 * stored row carries the raw OAuth tokens for server-side use — redaction is
 * enforced at the route boundary (see routes/__tests__/fortnox.test.ts), not
 * here.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

vi.mock('../../config.js', () => ({
  config: {
    fortnoxClientId: 'cid',
    fortnoxClientSecret: 'secret',
    fortnoxRedirectUri: 'https://app.test/cb',
  },
}))

const { refreshTokens } = vi.hoisted(() => ({ refreshTokens: vi.fn() }))
vi.mock('../fortnox.js', () => ({ refreshTokens }))

import {
  getValidFortnoxAccessToken,
  fortnoxConfigured,
} from '../fortnox-connection.js'

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    user_id: 'user-1',
    access_token: 'stored-access',
    refresh_token: 'stored-refresh',
    token_type: 'Bearer',
    scope: 'bookkeeping',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...over,
  }
}

afterEach(() => {
  mockQuery.mockReset()
  refreshTokens.mockReset()
})

describe('fortnoxConfigured', () => {
  it('is true when all three OAuth credentials are present', () => {
    expect(fortnoxConfigured()).toBe(true)
  })
})

describe('getValidFortnoxAccessToken', () => {
  it('returns null when the user has no connection', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await getValidFortnoxAccessToken('user-1')).toBeNull()
    expect(refreshTokens).not.toHaveBeenCalled()
  })

  it('returns the stored access token while it is still valid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [connectionRow()] })
    expect(await getValidFortnoxAccessToken('user-1')).toBe('stored-access')
    expect(refreshTokens).not.toHaveBeenCalled()
  })

  it('refreshes and persists when the stored token has expired', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [connectionRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] })
      .mockResolvedValueOnce({ rows: [] }) // the persist (saveFortnoxConnection) write
    refreshTokens.mockResolvedValueOnce({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      tokenType: 'Bearer',
      scope: 'bookkeeping',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    expect(await getValidFortnoxAccessToken('user-1')).toBe('fresh-access')
    expect(refreshTokens).toHaveBeenCalledOnce()
    // The refreshed token was persisted back (the second query is the upsert).
    const upsert = mockQuery.mock.calls[1]
    expect(String(upsert[0])).toMatch(/INSERT INTO fortnox_connections/)
    expect(upsert[1]).toContain('fresh-access')
    expect(upsert[1]).toContain('fresh-refresh')
  })
})
