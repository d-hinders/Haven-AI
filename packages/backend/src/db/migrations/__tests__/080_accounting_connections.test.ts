/**
 * #2860 — the epic's one migration, proven on a real database with NO
 * environment set, because that is how every replica and every CI runner will
 * apply it.
 *
 * The harness applies the full migration set before any test runs, so the
 * post-080 state is the baseline. Tests that need the pre-080 shape call
 * `down()`, seed the old tables, and drive `up()` by hand — inside
 * `withMigrationReverted` so a failing assertion cannot leave the shared
 * worker schema off head for the next file (#2616 / #2020).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../080_accounting_connections.js'
import { PLAINTEXT_KEY_VERSION, decryptSecrets } from '../../../infra/secrets.js'

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [name],
  )
  return rows[0].ok
}

async function withClient<T>(fn: (c: Awaited<ReturnType<typeof db.connect>>) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

async function seedUser(email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  return rows[0].id
}

describeDb('080_accounting_connections (#2860)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // The environment must NOT carry a key here: the whole point is that the
    // migration works without one. Guard against a developer's shell leaking it.
    delete process.env.HAVEN_SECRETS_KEY
  })
  // 075's test also re-runs `up()` in an afterAll as belt-and-braces. That
  // works there because 075's `up()` is idempotent (DROP IF EXISTS, SET
  // DEFAULT). This migration's is deliberately NOT: `INSERT … FROM
  // fortnox_connections` must fail when the source table is already renamed,
  // rather than silently copy nothing. So an unconditional afterAll `up()`
  // fails every run that is already at head — which is every run, since each
  // reverting test restores through `withMigrationReverted`. The head
  // assertion alone is the right guard here.
  afterAll(assertWorkerSchemaAtHead)
  beforeEach(async () => {
    await resetDb()
  })

  it('is registered under its own version string', () => {
    expect(version).toBe('080_accounting_connections')
  })

  it('at head: the new table exists, the old one is RENAMED not dropped, and both deferred renames landed', async () => {
    expect(await tableExists('accounting_connections')).toBe(true)
    expect(await tableExists('fortnox_connections')).toBe(false)
    expect(await tableExists('fortnox_connections_retired')).toBe(true)
    expect(await tableExists('accounting_feed_syncs')).toBe(true)
    expect(await tableExists('reporting_feed_syncs')).toBe(false)
  })

  it('reads no environment: up() succeeds with HAVEN_SECRETS_KEY unset and copies rows as plaintext', async () => {
    expect(process.env.HAVEN_SECRETS_KEY).toBeUndefined()
    let userId = ''
    await withClient(async (client) => {
      // The seed happens in the REVERTED state and the helper's restore step IS
      // the `up()` under test. Calling `up()` inside the body too would run it
      // twice, and the second run correctly fails — `INSERT … FROM
      // fortnox_connections` after that table has been renamed. That is the
      // migration being non-idempotent on purpose: a missing source table
      // must fail loudly, not silently copy nothing.
      await withMigrationReverted(
        () => down(client),
        async () => {
          userId = await seedUser('mig080-copy@example.test')
          await client.query(
            `INSERT INTO fortnox_connections (user_id, access_token, refresh_token, token_type, scope, expires_at)
             VALUES ($1, 'ACCESS-plain', 'REFRESH-plain', 'Bearer', 'bookkeeping supplierinvoice', NOW() + interval '1 hour')`,
            [userId],
          )
          await client.query(`INSERT INTO reporting_feed_syncs (user_id, provider, payment_id, status) VALUES ($1, 'fortnox', 'pay-1', 'pushed')`, [userId])
          await client.query(`INSERT INTO account_entitlements (user_id, entitlement) VALUES ($1, 'reporting_feed')`, [userId])
        },
        () => up(client),
      )
    })

    // The copied row: identical secrets, version 0, the fixed Fortnox facts.
    const { rows } = await db.query(
      `SELECT provider, auth_kind, secrets_ciphertext, secrets_key_version, base_currency, status,
              granted_scope, is_active_destination, token_expires_at
         FROM accounting_connections WHERE user_id = $1`,
      [userId],
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.provider).toBe('fortnox')
    expect(row.auth_kind).toBe('oauth2')
    expect(row.status).toBe('connected')
    expect(row.base_currency).toBe('SEK')
    expect(row.is_active_destination).toBe(true)
    expect(row.granted_scope).toBe('bookkeeping supplierinvoice')
    expect(row.token_expires_at).not.toBeNull()
    expect(row.secrets_key_version).toBe(PLAINTEXT_KEY_VERSION)
    // Decrypts (i.e. parses) without a key, to the same tokens.
    const secrets = decryptSecrets<Record<string, unknown>>(row.secrets_ciphertext, row.secrets_key_version, {})
    expect(secrets).toEqual({
      accessToken: 'ACCESS-plain',
      refreshToken: 'REFRESH-plain',
      tokenType: 'Bearer',
      scope: 'bookkeeping supplierinvoice',
    })

    // The retired table still holds the original — nothing was dropped.
    const retired = await db.query(`SELECT access_token FROM fortnox_connections_retired WHERE user_id = $1`, [userId])
    expect(retired.rows[0].access_token).toBe('ACCESS-plain')

    // The two deferred renames: the sync row is reachable under the new name,
    // and the entitlement string was rewritten.
    const syncs = await db.query(`SELECT status FROM accounting_feed_syncs WHERE user_id = $1`, [userId])
    expect(syncs.rows[0].status).toBe('pushed')
    const ent = await db.query(`SELECT entitlement FROM account_entitlements WHERE user_id = $1`, [userId])
    expect(ent.rows.map((r) => r.entitlement)).toEqual(['accounting_feed'])
  })

  it('down() reverses every step, proving the assertions above are load-bearing', async () => {
    await withClient(async (client) => {
      await withMigrationReverted(
        () => down(client),
        async () => {
          expect(await tableExists('accounting_connections')).toBe(false)
          expect(await tableExists('fortnox_connections')).toBe(true)
          expect(await tableExists('fortnox_connections_retired')).toBe(false)
          expect(await tableExists('reporting_feed_syncs')).toBe(true)
          expect(await tableExists('accounting_feed_syncs')).toBe(false)
        },
        () => up(client),
      )
    })
  })

  it('exactly ONE active destination per user is a constraint, not a convention', async () => {
    const userId = await seedUser('mig080-active@example.test')
    const insert = (provider: string) =>
      db.query(
        `INSERT INTO accounting_connections (user_id, provider, auth_kind, is_active_destination)
         VALUES ($1, $2, 'oauth2', true)`,
        [userId, provider],
      )
    await insert('fortnox')
    await expect(insert('accounted')).rejects.toThrow(/idx_accounting_connections_one_active/)
    // …but a second, INACTIVE connection is fine — several connections, one destination.
    await db.query(
      `INSERT INTO accounting_connections (user_id, provider, auth_kind, is_active_destination)
       VALUES ($1, 'accounted', 'api_key', false)`,
      [userId],
    )
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM accounting_connections WHERE user_id = $1`, [userId])
    expect(rows[0].n).toBe(2)
  })

  it('one row per (user, provider), and the status/auth_kind vocabularies are CHECKed', async () => {
    const userId = await seedUser('mig080-unique@example.test')
    await db.query(`INSERT INTO accounting_connections (user_id, provider, auth_kind) VALUES ($1, 'fortnox', 'oauth2')`, [userId])
    await expect(
      db.query(`INSERT INTO accounting_connections (user_id, provider, auth_kind) VALUES ($1, 'fortnox', 'oauth2')`, [userId]),
    ).rejects.toThrow(/accounting_connections_user_provider_key/)
    await expect(
      db.query(`INSERT INTO accounting_connections (user_id, provider, auth_kind) VALUES ($1, 'light', 'password')`, [userId]),
    ).rejects.toThrow(/accounting_connections_auth_kind_check/)
    await expect(
      db.query(`INSERT INTO accounting_connections (user_id, provider, auth_kind, status) VALUES ($1, 'light', 'api_key', 'weird')`, [userId]),
    ).rejects.toThrow(/accounting_connections_status_check/)
  })
})
