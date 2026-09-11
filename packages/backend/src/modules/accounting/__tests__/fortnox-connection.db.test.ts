/**
 * Fortnox token lifecycle against the REAL database (#2860).
 *
 * The persist-on-refresh path writes an encrypted blob to
 * `accounting_connections`, and the fail-closed path must leave the row
 * untouched. Neither is a claim a `db.js` mock can make — a mocked UPDATE
 * cannot show what landed in the column, and a mocked refusal cannot show
 * the row is intact afterwards.
 *
 * Only the Fortnox HTTP call is stubbed — with the plain `mockResolvedValue`,
 * reset per test, deliberately not the one-shot form: `lint:db-mocks` counts
 * every occurrence of that form's NAME in the suite as positional DB mocking
 * (it reads source, comments included), and this file's whole point is to
 * hold none.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { refreshTokens } = vi.hoisted(() => ({ refreshTokens: vi.fn() }))
vi.mock('../fortnox.js', () => ({ refreshTokens }))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getConnection, upsertConnection } from '../../../infra/repositories/accounting-connections.js'
import { SECRETS_KEY_ENV, SecretsKeyMissingError, decryptSecrets, plaintextSecrets } from '../../../infra/secrets.js'
import { getValidFortnoxAccessToken } from '../fortnox-connection.js'

const KEY = randomBytes(32).toString('base64')
const STORED = { accessToken: 'stored-access', refreshToken: 'stored-refresh', tokenType: 'Bearer', scope: 'bookkeeping' }
const FRESH = { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', tokenType: 'Bearer', scope: 'bookkeeping', expiresAt: new Date(Date.now() + 3600e3) }

async function seedExpiredPlaintextConnection(email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email])
  const userId = rows[0].id
  const { ciphertext, keyVersion } = plaintextSecrets(STORED)
  await upsertConnection(userId, {
    provider: 'fortnox', authKind: 'oauth2', secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion,
    grantedScope: 'bookkeeping', tokenExpiresAt: new Date(Date.now() - 1000),
  })
  return userId
}

describeDb('Fortnox token lifecycle on the real database (#2860)', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)
  afterEach(() => {
    refreshTokens.mockReset()
    delete process.env[SECRETS_KEY_ENV]
  })

  it('refreshes an expired token and persists the new set ENCRYPTED — which is also what moves a migrated plaintext row off version 0', async () => {
    process.env[SECRETS_KEY_ENV] = KEY
    const userId = await seedExpiredPlaintextConnection('lc-refresh@example.test')
    refreshTokens.mockResolvedValue(FRESH)

    expect(await getValidFortnoxAccessToken(userId)).toBe('fresh-access')
    expect(refreshTokens).toHaveBeenCalledOnce()

    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.secrets_key_version).toBe(1)
    expect(row.secrets_ciphertext!.toString('latin1')).not.toContain('fresh-access')
    expect(row.secrets_ciphertext!.toString('latin1')).not.toContain('fresh-refresh')
    expect(decryptSecrets(row.secrets_ciphertext!, 1)).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
    expect(new Date(row.token_expires_at!).getTime()).toBeGreaterThan(Date.now())
  })

  it('FAILS CLOSED: without HAVEN_SECRETS_KEY a refresh throws and the row is UNTOUCHED', async () => {
    const userId = await seedExpiredPlaintextConnection('lc-nokey@example.test')
    refreshTokens.mockResolvedValue(FRESH)

    await expect(getValidFortnoxAccessToken(userId)).rejects.toThrow(SecretsKeyMissingError)

    // The refusal came AFTER the provider call (the token was minted at Fortnox)
    // but BEFORE any write: the stored row is exactly what was seeded.
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.secrets_key_version).toBe(0)
    expect(decryptSecrets(row.secrets_ciphertext!, 0)).toEqual(STORED)
    expect(new Date(row.token_expires_at!).getTime()).toBeLessThan(Date.now())
  })
})
