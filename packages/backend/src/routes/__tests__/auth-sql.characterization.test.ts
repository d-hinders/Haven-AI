/**
 * Characterization of `routes/auth.ts`'s SQL behaviour, written BEFORE the
 * #1180 extraction moved those statements into `infra/repositories/`.
 *
 * The existing `auth.test.ts` pins status codes and payload shapes. What it
 * does NOT pin is what the queries are actually asked — and on the signup and
 * login path that is the security-relevant part: which value the email lookup
 * receives decides whether two accounts can share an address, and which
 * columns come back decides what the Connect modal can branch on.
 *
 * These assertions describe the behaviour as it was on 2026-08-08, before any
 * code moved. They are deliberately about the CALL, not the implementation, so
 * they survive the extraction unchanged and prove it changed nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'

const mockQuery = vi.fn()
vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

import { buildApp } from '../../__tests__/helpers.js'
import { setReceiptSigningKey } from '../../modules/passport/index.js'

/** Every SQL string the route layer sent, in order. */
const sqlSent = () => mockQuery.mock.calls.map((c) => String(c[0]))
/** The parameter arrays, in order. */
const paramsSent = () => mockQuery.mock.calls.map((c) => c[1] as unknown[])

describe('auth SQL characterization (pre-#1180)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    mockQuery.mockReset()
  })

  describe('email is looked up NORMALISED — the uniqueness semantic', () => {
    it('signup checks the trimmed, lower-cased address, not the raw input', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'u1', name: 'Ada', email: 'ada@example.com', created_at: '2026-01-01' }],
      })

      await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada', email: '  ADA@Example.COM  ', password: 'password123' },
      })

      // If this ever became the raw input, 'ADA@Example.com' would not collide
      // with a stored 'ada@example.com' and the same person could hold two
      // accounts — with two different treasuries.
      expect(paramsSent()[0]).toEqual(['ada@example.com'])
      // Anchored to the whole statement (#1208): the bare fragment
      // `FROM users WHERE email = $1` also matches the LOGIN lookup, so it
      // would keep matching after the duplicate-check statement it exists to
      // characterize was gone.
      expect(sqlSent()[0]).toMatch(/^SELECT id FROM users WHERE email = \$1$/)
    })

    it('the INSERT stores the normalised address and name, never the raw ones', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', created_at: '2026-01-01' }],
      })

      await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: '  Ada   Lovelace  ', email: ' ADA@Example.COM ', password: 'password123' },
      })

      const [name, email, hash] = paramsSent()[1]
      expect(name).toBe('Ada Lovelace') // trimmed, inner whitespace collapsed
      expect(email).toBe('ada@example.com')
      // A stored plaintext password would be the worst possible regression here.
      expect(hash).not.toBe('password123')
      expect(await bcrypt.compare('password123', String(hash))).toBe(true)
    })

    it('login looks up the normalised address too', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: ' ADA@Example.COM ', password: 'password123' },
      })

      expect(paramsSent()[0]).toEqual(['ada@example.com'])
    })
  })

  describe('the existence check runs BEFORE hashing and before the insert', () => {
    it('a duplicate email never reaches the INSERT', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] })

      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada', email: 'ada@example.com', password: 'password123' },
      })

      expect(res.statusCode).toBe(409)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      expect(sqlSent().some((s) => /INSERT INTO users/.test(s))).toBe(false)
    })
  })

  describe('login reads the columns the session needs', () => {
    it('selects password_hash plus the profile fields, scoped by email', async () => {
      const hash = await bcrypt.hash('password123', 4)
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'u1', name: 'Ada', email: 'ada@example.com', password_hash: hash,
          wallet_address: null, account_address: null, currency_preference: null,
        }],
      })
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ada@example.com', password: 'password123' },
      })

      expect(res.statusCode).toBe(200)
      for (const col of ['password_hash', 'wallet_address', 'account_address', 'currency_preference']) {
        expect(sqlSent()[0]).toContain(col)
      }
      // A null preference presents as SEK rather than leaking null to the
      // client. (#3127 moved the presented default from 'USD' to SEK
      // deliberately: SEK is the currency the transaction feed serves a
      // no-preference user, and the auth response, the preferences route and
      // the feed must agree — the signup INSERT now writes the same constant,
      // so the column and the presentation agree too. The characterization
      // SHAPE is unchanged: a null column presents as a currency, never null.)
      expect(res.json().user.currency_preference).toBe('SEK')
    })

    it('does not fetch accounts when the credentials are wrong', async () => {
      const hash = await bcrypt.hash('the-real-password', 4)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'u1', name: 'Ada', email: 'ada@example.com', password_hash: hash }],
      })

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ada@example.com', password: 'wrong-password' },
      })

      expect(res.statusCode).toBe(401)
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })
  })

  describe('the accounts payload is user-scoped and ordered', () => {
    it('login fetches accounts for the AUTHENTICATED user id, oldest first', async () => {
      const hash = await bcrypt.hash('password123', 4)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'u1', name: 'Ada', email: 'ada@example.com', password_hash: hash, currency_preference: 'EUR' }],
      })
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 's1',
            chain_id: 8453,
            account_type: 'delegator_hybrid',
            owner_address: null,
            passkey_count: 1,
          },
        ],
      })

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ada@example.com', password: 'password123' },
      })

      expect(paramsSent()[1]).toEqual(['u1'])
      expect(sqlSent()[1]).toMatch(/WHERE (?:us\.)?user_id = \$1/)
      expect(sqlSent()[1]).toMatch(/ORDER BY (?:us\.)?created_at ASC/)
      // #1205: raw signer-set inputs are consumed by sessionAccountPayload; the
      // payload carries the computed answer instead.
      expect(res.json().user.accounts).toEqual([
        {
          id: 's1',
          chain_id: 8453,
          account_type: 'delegator_hybrid',
          value_bearing_chain: true,
          needs_backup_recommendation: true,
          // #4719: Base mainnet is not a passport chain, so no opt-in.
          passport_issuable: false,
        },
      ])
    })
  })

  describe('GET /auth/me', () => {
    it('scopes both reads to the JWT subject', async () => {
      const app2 = app
      const token = app2.jwt.sign({ sub: 'u-jwt', email: 'ada@example.com' }, { expiresIn: '7d' })
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u-jwt', name: 'Ada', email: 'ada@example.com' }] })
      mockQuery.mockResolvedValueOnce({ rows: [] })

      await app2.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      })

      // Both the profile read and the accounts read take the token's subject —
      // never a client-supplied id.
      expect(paramsSent()[0]).toEqual(['u-jwt'])
      expect(paramsSent()[1]).toEqual(['u-jwt'])
    })

    /**
     * #4719: `passport_issuable` is the deployment's answer for the account,
     * computed server-side so the dashboard never offers an opt-in the
     * backend would drop. True only with BOTH halves configured here: the
     * schema UID for the chain and the receipt verifier (owner decision
     * 2026-11-06 — a passport no merchant can verify is not offered).
     */
    it('carries passport_issuable: true only when the chain, schema UID and verifier all line up', async () => {
      const sepolia = { id: 's1', chain_id: 84532, account_type: 'delegator_hybrid', owner_address: null, passkey_count: 1 }
      // Base mainnet with EVERY env var set, so its `false` is the chain leg's
      // answer and not a side effect of missing config.
      const mainnet = { ...sepolia, id: 's2', chain_id: 8453 }
      const uidKey = 'AGENT_PASSPORT_SCHEMA_UID_84532'
      const savedUid = process.env[uidKey]
      const savedMainnetUid = process.env.AGENT_PASSPORT_SCHEMA_UID_8453
      // Keyed on the statement, not on call order: the profile read and the
      // accounts read answer by what they ask.
      mockQuery.mockImplementation(async (sql: string) =>
        /hybrid_account_passkeys|FROM user_smart_accounts|smart_accounts/.test(String(sql))
          ? { rows: [sepolia, mainnet] }
          : { rows: [{ id: 'u-pp', name: 'Ada', email: 'ada@example.com' }] },
      )
      const me = async () => {
        const token = app.jwt.sign({ sub: 'u-pp', email: 'ada@example.com' }, { expiresIn: '7d' })
        const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
        const accounts = res.json().accounts as Array<{ id: string; passport_issuable: boolean }>
        return Object.fromEntries(accounts.map((a) => [a.id, a.passport_issuable]))
      }
      try {
        process.env[uidKey] = '0x' + 'ab'.repeat(32)
        process.env.AGENT_PASSPORT_SCHEMA_UID_8453 = '0x' + 'cd'.repeat(32)
        setReceiptSigningKey('0x' + '11'.repeat(32))
        expect(await me()).toEqual({ s1: true, s2: false })

        // Verifier off: issuance would anchor a passport no merchant can check.
        setReceiptSigningKey(null)
        expect(await me()).toEqual({ s1: false, s2: false })

        // Schema UID unset: nothing could anchor here at all.
        setReceiptSigningKey('0x' + '11'.repeat(32))
        delete process.env[uidKey]
        expect(await me()).toEqual({ s1: false, s2: false })
      } finally {
        setReceiptSigningKey(null)
        if (savedUid === undefined) delete process.env[uidKey]
        else process.env[uidKey] = savedUid
        if (savedMainnetUid === undefined) delete process.env.AGENT_PASSPORT_SCHEMA_UID_8453
        else process.env.AGENT_PASSPORT_SCHEMA_UID_8453 = savedMainnetUid
      }
    })

    it('404s when the user row is gone, without reading accounts', async () => {
      const token = app.jwt.sign({ sub: 'u-gone', email: 'ada@example.com' }, { expiresIn: '7d' })
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.statusCode).toBe(404)
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })
  })
})
