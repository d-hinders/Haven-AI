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
vi.mock('../../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

vi.mock('../../../config.js', () => ({
  config: {
    fortnoxClientId: 'cid',
    fortnoxClientSecret: 'secret',
    fortnoxRedirectUri: 'https://app.test/cb',
  },
}))

const { refreshTokens } = vi.hoisted(() => ({ refreshTokens: vi.fn() }))
vi.mock('../fortnox.js', () => ({ refreshTokens }))

import { randomBytes } from 'node:crypto'
import {
  getValidFortnoxAccessToken,
  fortnoxConfigured,
} from '../fortnox-connection.js'
import { SECRETS_KEY_ENV, SecretsKeyMissingError, decryptSecrets, plaintextSecrets } from '../../../infra/secrets.js'

// #2860: the row is the generic `accounting_connections` shape. Secrets travel
// as a blob + key version; a version-0 (plaintext JSON) blob needs no key to
// read, which is what lets the "still valid" path run without configuring one.
function connectionRow(over: Record<string, unknown> = {}) {
  const { ciphertext, keyVersion } = plaintextSecrets({
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    tokenType: 'Bearer',
    scope: 'bookkeeping',
  })
  return {
    id: 'conn-1',
    user_id: 'user-1',
    provider: 'fortnox',
    auth_kind: 'oauth2',
    secrets_ciphertext: ciphertext,
    secrets_key_version: keyVersion,
    status: 'connected',
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    is_active_destination: true,
    ...over,
  }
}

const KEY = randomBytes(32).toString('base64')

afterEach(() => {
  mockQuery.mockReset()
  refreshTokens.mockReset()
  delete process.env[SECRETS_KEY_ENV]
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

  // The refresh-and-persist path and the fail-closed-without-a-key path are
  // DATABASE behaviour now (#2860): an encrypted UPDATE against a real table,
  // and a refusal that must leave the row untouched. Both live on the real
  // harness in `fortnox-connection.db.test.ts`, not behind a positional
  // `db.js` mock — which is where `lint:db-mocks` wants them.
})
