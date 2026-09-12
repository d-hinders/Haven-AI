/**
 * Real-DB tests for `accounting_connections` (#2860). Every assertion here is
 * about a database behaviour — a constraint, an atomic statement, a
 * preserved-on-conflict column — so none of it can be proven against a mock.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import type { Executor, QueryRow } from '../../transaction.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  disconnect,
  getActiveConnection,
  getConnection,
  listConnections,
  listPlaintextConnections,
  setActiveDestination,
  setStatus,
  updateSecrets,
  upsertConnection,
} from '../accounting-connections.js'
import { SECRETS_KEY_ENV, decryptSecrets, encryptSecrets, plaintextSecrets } from '../../secrets.js'
import { reencryptPlaintextSecrets } from '../../../modules/accounting/secrets-migration.js'

const KEY = randomBytes(32).toString('base64')
const withKey = { [SECRETS_KEY_ENV]: KEY } as NodeJS.ProcessEnv
const noKey = {} as NodeJS.ProcessEnv

async function seedUser(email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  return rows[0].id
}

const TOKENS = { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', scope: 'bookkeeping' }

function encrypted() {
  const { ciphertext, keyVersion } = encryptSecrets(TOKENS, withKey)
  return { secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion }
}

describeDb('accounting_connections repository (#2860)', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('upsert then read round-trips; the stored blob is not the plaintext', async () => {
    const userId = await seedUser('ac-rt@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: 'bookkeeping', tokenExpiresAt: new Date(Date.now() + 3600e3) })
    const row = await getConnection(userId, 'fortnox')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('connected')
    expect(row!.secrets_key_version).toBe(1)
    expect(row!.secrets_ciphertext!.toString('latin1')).not.toContain('accessToken')
    expect(decryptSecrets(row!.secrets_ciphertext!, row!.secrets_key_version, withKey)).toEqual(TOKENS)
  })

  it('the FIRST connection becomes the active destination; a second one does not steal it', async () => {
    const userId = await seedUser('ac-first@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await upsertConnection(userId, { provider: 'accounted', authKind: 'api_key', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    const rows = await listConnections(userId)
    expect(rows.map((r) => [r.provider, r.is_active_destination])).toEqual([
      ['fortnox', true],
      ['accounted', false],
    ])
    expect((await getActiveConnection(userId))!.provider).toBe('fortnox')
  })

  it('setActiveDestination moves the flag without tripping the index (clear-then-set, one transaction)', async () => {
    const userId = await seedUser('ac-switch@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await upsertConnection(userId, { provider: 'accounted', authKind: 'api_key', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await setActiveDestination(userId, 'accounted')
    const rows = await listConnections(userId)
    expect(rows.map((r) => [r.provider, r.is_active_destination])).toEqual([
      ['fortnox', false],
      ['accounted', true],
    ])
  })

  it('a second ACTIVE row is refused by the database, not by convention', async () => {
    const userId = await seedUser('ac-two-active@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await expect(
      db.query(`UPDATE accounting_connections SET is_active_destination = true WHERE user_id = $1`, [userId]),
    ).resolves.toBeTruthy() // one row: fine
    await upsertConnection(userId, { provider: 'accounted', authKind: 'api_key', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await expect(
      db.query(`UPDATE accounting_connections SET is_active_destination = true WHERE user_id = $1 AND provider = 'accounted'`, [userId]),
    ).rejects.toThrow(/idx_accounting_connections_one_active/)
  })

  it('reconnect (upsert on conflict) replaces secrets and status but PRESERVES settings, feed_from and the active flag', async () => {
    const userId = await seedUser('ac-reconnect@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: 'a', tokenExpiresAt: null })
    await db.query(
      `UPDATE accounting_connections SET settings = '{"auto_feed": false}'::jsonb, feed_from = '2026-01-01T00:00:00Z', status = 'scope_missing'
       WHERE user_id = $1 AND provider = 'fortnox'`,
      [userId],
    )
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: 'a b', tokenExpiresAt: null })
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status).toBe('connected')
    expect(row.granted_scope).toBe('a b')
    expect(row.settings).toEqual({ auto_feed: false })
    expect(new Date(row.feed_from!).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(row.is_active_destination).toBe(true)
  })

  it('RECONNECT after DISCONNECT reclaims the active flag — the user never ends with zero destinations', async () => {
    // Disconnect clears the flag; a first draft's ON CONFLICT path preserved
    // whatever the row had, so the reconnect kept `false` and the user had a
    // connected row that fed nowhere. Reproduced in review via
    // DELETE /accounting/fortnox → connect.
    const userId = await seedUser('ac-reconnect-active@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await disconnect(userId, 'fortnox', 'user disconnected')
    expect(await getActiveConnection(userId)).toBeNull()
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    expect((await getActiveConnection(userId))!.provider).toBe('fortnox')
    // …but if ANOTHER provider already holds the flag, a reconnect does not steal it.
    await upsertConnection(userId, { provider: 'accounted', authKind: 'api_key', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await setActiveDestination(userId, 'accounted')
    await disconnect(userId, 'fortnox', 'again')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    expect((await getActiveConnection(userId))!.provider).toBe('accounted')
  })

  it('status transitions persist their reason', async () => {
    const userId = await seedUser('ac-status@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await setStatus(userId, 'fortnox', 'needs_reauthorisation', 'invalid_grant from token endpoint')
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status).toBe('needs_reauthorisation')
    expect(row.status_reason).toBe('invalid_grant from token endpoint')
    // …and the active read excludes it: a connection needing attention is not a destination.
    expect(await getActiveConnection(userId)).toBeNull()
  })

  it('disconnect clears the secrets and KEEPS the row', async () => {
    const userId = await seedUser('ac-disc@example.test')
    await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', ...encrypted(), grantedScope: null, tokenExpiresAt: null })
    await disconnect(userId, 'fortnox', 'user disconnected')
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status).toBe('disconnected')
    expect(row.secrets_ciphertext).toBeNull()
    expect(row.secrets_key_version).toBe(0)
    expect(row.is_active_destination).toBe(false)
    expect(await listConnections(userId)).toHaveLength(1)
  })

  describe('boot-time re-encryption (#2860)', () => {
    async function seedPlaintext(email: string): Promise<string> {
      const userId = await seedUser(email)
      const { ciphertext, keyVersion } = plaintextSecrets(TOKENS)
      await upsertConnection(userId, { provider: 'fortnox', authKind: 'oauth2', secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion, grantedScope: null, tokenExpiresAt: new Date('2027-01-01T00:00:00Z') })
      return userId
    }

    it('with the key set: version-0 rows are encrypted and decrypt to the same tokens; a second pass does nothing', async () => {
      const userId = await seedPlaintext('re-key@example.test')
      expect((await listPlaintextConnections()).map((r) => r.user_id)).toContain(userId)
      const first = await reencryptPlaintextSecrets({ env: withKey, log: () => {} })
      expect(first).toEqual({ skipped: false, considered: 1, encrypted: 1, moved: 0, failed: 0 })
      const row = (await getConnection(userId, 'fortnox'))!
      expect(row.secrets_key_version).toBe(1)
      expect(row.secrets_ciphertext!.toString('latin1')).not.toContain('"accessToken"')
      expect(decryptSecrets(row.secrets_ciphertext!, 1, withKey)).toEqual(TOKENS)
      expect(new Date(row.token_expires_at!).toISOString()).toBe('2027-01-01T00:00:00.000Z')
      // Idempotent.
      expect(await reencryptPlaintextSecrets({ env: withKey, log: () => {} })).toEqual({ skipped: false, considered: 0, encrypted: 0, moved: 0, failed: 0 })
    })

    it('WITHOUT the key: rows are left alone, logged, and can be decrypted as version 0', async () => {
      const userId = await seedPlaintext('re-nokey@example.test')
      const logs: string[] = []
      const out = await reencryptPlaintextSecrets({ env: noKey, log: (m) => logs.push(m) })
      expect(out.skipped).toBe(true)
      expect(logs.join('\n')).toMatch(/HAVEN_SECRETS_KEY not set/)
      const row = (await getConnection(userId, 'fortnox'))!
      expect(row.secrets_key_version).toBe(0)
      expect(decryptSecrets(row.secrets_ciphertext!, 0, noKey)).toEqual(TOKENS)
    })

    it('NEVER overwrites a credential rotated between the worklist read and the write (compare-and-swap)', async () => {
      // The lost-update review reproduced: a serving replica refreshes the
      // token — rotating the secrets to version 1 — after this job has read
      // its worklist but before it writes. The job's copy holds a refresh
      // token Fortnox has already consumed. Writing it back bricks the
      // connection. Simulated by interposing on the executor: the moment the
      // job lists its worklist, a "refresh" lands on the same row.
      const userId = await seedPlaintext('re-race@example.test')
      const rotated = encryptSecrets({ ...TOKENS, refreshToken: 'ROTATED' }, withKey)
      let interposed = false
      const racing: Executor = {
        query: async <R extends QueryRow = QueryRow>(sql: string, values?: unknown[]) => {
          const out = await db.query<R>(sql, values)
          if (!interposed && /secrets_key_version = 0 AND secrets_ciphertext IS NOT NULL/.test(sql)) {
            interposed = true
            await updateSecrets(userId, 'fortnox', { secretsCiphertext: rotated.ciphertext, secretsKeyVersion: rotated.keyVersion, tokenExpiresAt: new Date('2028-01-01T00:00:00Z') })
          }
          return out
        },
      }
      const out = await reencryptPlaintextSecrets({ db: racing, env: withKey, log: () => {} })
      expect(interposed).toBe(true)
      expect(out).toEqual({ skipped: false, considered: 1, encrypted: 0, moved: 1, failed: 0 })
      const row = (await getConnection(userId, 'fortnox'))!
      expect(decryptSecrets(row.secrets_ciphertext!, 1, withKey)).toMatchObject({ refreshToken: 'ROTATED' })
      expect(new Date(row.token_expires_at!).toISOString()).toBe('2028-01-01T00:00:00.000Z')
    })

    it('a row whose plaintext does not parse is skipped and counted, not allowed to abort the pass', async () => {
      const good = await seedPlaintext('re-good@example.test')
      const bad = await seedUser('re-bad@example.test')
      await upsertConnection(bad, { provider: 'fortnox', authKind: 'oauth2', secretsCiphertext: Buffer.from('not json', 'utf8'), secretsKeyVersion: 0, grantedScope: null, tokenExpiresAt: null })
      const logs: string[] = []
      const out = await reencryptPlaintextSecrets({ env: withKey, log: (m) => logs.push(m) })
      expect(out).toEqual({ skipped: false, considered: 2, encrypted: 1, moved: 0, failed: 1 })
      expect((await getConnection(good, 'fortnox'))!.secrets_key_version).toBe(1)
      expect((await getConnection(bad, 'fortnox'))!.secrets_key_version).toBe(0)
      expect(logs.join('\n')).toMatch(/could not re-encrypt secrets for connection=[0-9a-f-]+ \(SyntaxError\)/)
    })
  })
})
