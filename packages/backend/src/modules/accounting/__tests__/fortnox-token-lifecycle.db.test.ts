/**
 * Fortnox token lifecycle on the REAL database (#2863, epic #2858).
 *
 * Three claims that only a real row lock, a real `accounting_connections`
 * row and a real `accounting_feed_syncs` ledger can make:
 *
 *   1. two callers refreshing the same expired token at once produce ONE
 *      provider refresh call — the second waits on the row lock, re-reads,
 *      and gets the first caller's token; the row holds the rotated refresh
 *      token (mutation target: the `withLockedConnection` wrap in
 *      `getValidOAuth2AccessToken` — without it, two refresh calls);
 *   2. a refresh Fortnox refuses with `invalid_grant` flips the row to
 *      `needs_reauthorisation` (reason = the provider's error code, never
 *      token material), the next call makes NO refresh attempt, and the next
 *      sync writes a `skipped` row naming the state (mutation target: the
 *      4xx flip in the same function — without it the next call refreshes
 *      again);
 *   3. disconnect posts the refresh token to `/oauth-v1/revoke` BEFORE the
 *      secrets are cleared, and a failed revoke still disconnects locally
 *      (mutation target: the `revoke` call in `disconnectProvider`).
 *
 * Only `fetch` is stubbed — with `mockImplementation`, never the one-shot
 * form `lint:db-mocks` counts (it reads source, comments included).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true), buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))
vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      fortnoxClientId: 'cid',
      fortnoxClientSecret: 'csecret',
      fortnoxRedirectUri: 'https://api.test/accounting/connections/fortnox/callback',
    },
  }
})

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getConnection, upsertConnection } from '../../../infra/repositories/accounting-connections.js'
import { SECRETS_KEY_ENV, decryptSecrets, encryptSecrets } from '../../../infra/secrets.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { disconnectProvider } from '../connections.js'
import { syncUser } from '../feed-orchestrator.js'
import { FortnoxConnector } from '../fortnox-connector.js'
import { getValidFortnoxAccessToken } from '../fortnox-connection.js'
import { FORTNOX_REVOKE_URL, FORTNOX_TOKEN_URL } from '../fortnox.js'
import { ConnectionNeedsReauthorisationError } from '../oauth-flow.js'
import { accountingEntry } from './connector-conformance.js'

const KEY = randomBytes(32).toString('base64')
const STORED = { accessToken: 'stored-access', refreshToken: 'stored-refresh', tokenType: 'Bearer', scope: 'bookkeeping' }
const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'

let seq = 0

/**
 * A Fortnox stand-in that answers the token and revoke endpoints and records
 * every call. Each refresh rotates to a NEW pair (`rotated-refresh-N`), which
 * is how a second refresh — the bug — becomes visible in the stored row.
 */
function fortnoxStub(opts: { refresh?: 'ok' | 'invalid_grant' | 'invalid_client' | 'rate_limited'; revoke?: 'ok' | 'fail'; delayMs?: number } = {}) {
  const calls = { refresh: 0, revoke: 0, revokeBodies: [] as string[], other: [] as string[] }
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u === FORTNOX_TOKEN_URL) {
      calls.refresh += 1
      const n = calls.refresh
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (opts.refresh === 'invalid_grant') {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired or revoked' }), { status: 400 })
      }
      if (opts.refresh === 'rate_limited') return new Response('', { status: 429 })
      if (opts.refresh === 'invalid_client') {
        return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed' }), { status: 401 })
      }
      return new Response(
        JSON.stringify({ access_token: `rotated-access-${n}`, refresh_token: `rotated-refresh-${n}`, token_type: 'Bearer', scope: 'bookkeeping', expires_in: 3600 }),
        { status: 200 },
      )
    }
    if (u === FORTNOX_REVOKE_URL) {
      calls.revoke += 1
      calls.revokeBodies.push(String(init?.body))
      return opts.revoke === 'fail' ? new Response('', { status: 503 }) : new Response('', { status: 200 })
    }
    calls.other.push(u)
    return new Response(JSON.stringify({ ErrorInformation: { error: 1, message: 'not stubbed', code: 0 } }), { status: 500 })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`lifecycle-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'lifecycle agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/** An encrypted Fortnox row whose access token expired a second ago. */
async function seedExpiredConnection(userId: string): Promise<void> {
  const { ciphertext, keyVersion } = encryptSecrets(STORED)
  await upsertConnection(userId, {
    provider: 'fortnox', authKind: 'oauth2', secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion,
    grantedScope: 'bookkeeping', tokenExpiresAt: new Date(Date.now() - 1000),
  })
}

/** A settled, FX-ready payment — what the backfill enumerates. */
async function seedSettled(userId: string, agentId: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, tx_hash,
        confirmed_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6, '100000', '0.10',
             '0x00000000000000000000000000000000000000d1', 0, $7, 'confirmed', $8,
             NOW() - interval '10 second', NOW() + interval '10 minutes', NOW() - interval '10 second')`,
    [id, agentId, userId, PAYER, TOKEN, MERCHANT, `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66), `0x${'30'.repeat(32)}`],
  )
  await db.query(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url, payer_address,
        settlement_address, token_symbol, token_address, amount_raw, amount_human, amount_sek,
        confirmed_at, created_at)
     VALUES ($1, $2, $3, 'x402', $4, ${CHAIN}, 'https://merchant.example/paid', $5, $6, 'USDC', $7,
             '100000', '0.10', 1.05, NOW() - interval '10 second', NOW() - interval '10 second')`,
    [id, agentId, userId, `0x${'30'.repeat(32)}`, PAYER, MERCHANT, TOKEN],
  )
  return id
}

describeDb('Fortnox token lifecycle: lock, needs_reauthorisation, revoke (#2863)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    process.env[SECRETS_KEY_ENV] = KEY
    clearConnectors()
    mocks.accountingFeedAvailable.mockReset().mockResolvedValue(true)
    mocks.buildAccountingEntryForPayment.mockReset().mockImplementation(async (_u: string, paymentId: string) => accountingEntry(paymentId))
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  it('two concurrent callers on an expired token → ONE provider refresh, both get the new token, the row holds the rotated refresh token', async () => {
    const { userId } = await seedUser()
    await seedExpiredConnection(userId)
    // The delay keeps the first refresh in flight while the second caller
    // arrives, so "the second waited on the lock" is what is being measured —
    // not a lucky interleaving.
    const { impl, calls } = fortnoxStub({ delayMs: 60 })

    const [a, b] = await Promise.all([
      getValidFortnoxAccessToken(userId, impl),
      getValidFortnoxAccessToken(userId, impl),
    ])

    expect(calls.refresh).toBe(1)
    expect(a).toBe('rotated-access-1')
    expect(b).toBe('rotated-access-1')

    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status).toBe('connected')
    expect(decryptSecrets(row.secrets_ciphertext!, row.secrets_key_version)).toMatchObject({
      accessToken: 'rotated-access-1', refreshToken: 'rotated-refresh-1',
    })
    expect(new Date(row.token_expires_at!).getTime()).toBeGreaterThan(Date.now())

    // A third call finds a valid token: still one refresh at the provider.
    expect(await getValidFortnoxAccessToken(userId, impl)).toBe('rotated-access-1')
    expect(calls.refresh).toBe(1)
  })

  it('invalid_grant → needs_reauthorisation with the provider error as reason; the next call makes NO refresh; the next sync writes a skipped row naming the state', async () => {
    const { userId, agentId } = await seedUser()
    await seedExpiredConnection(userId)
    const paymentId = await seedSettled(userId, agentId)
    const { impl, calls } = fortnoxStub({ refresh: 'invalid_grant' })
    registerConnector(new FortnoxConnector(impl))

    await expect(getValidFortnoxAccessToken(userId, impl)).rejects.toThrow(ConnectionNeedsReauthorisationError)
    expect(calls.refresh).toBe(1)

    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status).toBe('needs_reauthorisation')
    expect(row.status_reason).toBe('refresh refused: fortnox token request failed (HTTP 400): invalid_grant')
    expect(row.status_reason).not.toContain('stored-refresh')
    expect(row.status_reason).not.toContain('stored-access')
    expect(row.is_active_destination).toBe(true) // still THE destination — just unusable

    // Not retried: the dead grant is refused before any provider call.
    await expect(getValidFortnoxAccessToken(userId, impl)).rejects.toThrow(/needs reauthorisation/)
    expect(calls.refresh).toBe(1)

    // The next sync: no refresh, no push, one skipped row that names the state.
    // #2915: a skipped row was never pushed, so `fed` is 0 (enumerated: 1) —
    // the dialog no longer says "1 earlier payment fed" for it.
    expect(await syncUser(userId)).toEqual({ fed: 0, total: 1 })
    expect(calls.refresh).toBe(1)
    expect(calls.other).toEqual([])
    const syncs = await db.query<{ payment_id: string; status: string; error: string | null }>(
      `SELECT payment_id, status, error FROM accounting_feed_syncs WHERE user_id = $1`, [userId],
    )
    expect(syncs.rows).toEqual([{ payment_id: paymentId, status: 'skipped', error: expect.stringMatching(/^connection needs_reauthorisation: refresh refused: .*invalid_grant$/) }])
    expect(syncs.rows[0].error).not.toContain('stored-refresh')
  })

  it('a 429 (rate limit) is transient: the row stays connected and the next call refreshes again', async () => {
    const { userId } = await seedUser()
    await seedExpiredConnection(userId)
    const { impl, calls } = fortnoxStub({ refresh: 'rate_limited' })

    await expect(getValidFortnoxAccessToken(userId, impl)).rejects.toThrow(/HTTP 429/)
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status).toBe('connected')
    expect(decryptSecrets(row.secrets_ciphertext!, row.secrets_key_version)).toEqual(STORED)

    await expect(getValidFortnoxAccessToken(userId, impl)).rejects.toThrow(/HTTP 429/)
    expect(calls.refresh).toBe(2)
  })

  it("a 401 invalid_client is HAVEN's credential problem, not the user's grant: the row stays connected and the refresh token is unconsumed (review on #2895)", async () => {
    const { userId } = await seedUser()
    await seedExpiredConnection(userId)
    const { impl, calls } = fortnoxStub({ refresh: 'invalid_client' })

    // MUTATION TARGET: treating every 4xx as a dead grant flips this row —
    // and with a rotated client secret, every user's row — to
    // needs_reauthorisation, sending them all through a re-consent that
    // fails for the same reason.
    await expect(getValidFortnoxAccessToken(userId, impl)).rejects.toThrow(/HTTP 401.*invalid_client/)
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status).toBe('connected')
    expect(row.status_reason).toBeNull()
    expect(decryptSecrets(row.secrets_ciphertext!, row.secrets_key_version)).toEqual(STORED)

    // Once the operator fixes the client credentials, the next call refreshes
    // with the SAME stored refresh token — nothing was consumed or flipped.
    await expect(getValidFortnoxAccessToken(userId, impl)).rejects.toThrow(/HTTP 401/)
    expect(calls.refresh).toBe(2)
  })

  it('disconnect revokes the REFRESH token at Fortnox first, then the row is disconnected with secrets cleared', async () => {
    const { userId } = await seedUser()
    await seedExpiredConnection(userId)
    const { impl, calls } = fortnoxStub()
    registerConnector(new FortnoxConnector(impl))

    const outcome = await disconnectProvider(userId, 'fortnox')

    expect(outcome).toEqual({ existed: true, revoked: true, revokeError: null })
    expect(calls.revoke).toBe(1)
    expect(calls.revokeBodies).toEqual([new URLSearchParams({ token: 'stored-refresh', token_type_hint: 'refresh_token' }).toString()])
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row).toMatchObject({ status: 'disconnected', secrets_ciphertext: null, secrets_key_version: 0, is_active_destination: false })
    expect(row.status_reason).toBe('user disconnected (grant revoked at provider)')
  })

  it('a failed revoke does not block the disconnect: secrets are still cleared, the failure is reported by name only', async () => {
    const { userId } = await seedUser()
    await seedExpiredConnection(userId)
    const { impl, calls } = fortnoxStub({ revoke: 'fail' })
    registerConnector(new FortnoxConnector(impl))

    const outcome = await disconnectProvider(userId, 'fortnox')

    expect(calls.revoke).toBe(1)
    expect(outcome).toEqual({ existed: true, revoked: false, revokeError: 'FortnoxError' })
    expect((await getConnection(userId, 'fortnox'))!).toMatchObject({ status: 'disconnected', secrets_ciphertext: null, status_reason: 'user disconnected' })
  })
})
